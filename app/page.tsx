'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek as dateFnsStartOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './responsive.css';

type Task = {
  id: string;
  title: string;
  due_at: string | null;
  status: string;
  course_name: string | null;
  notes: string | null;
  source: string;
  course_display_name: string | null;
  due_at_override: string | null;
};

type CourseMapping = {
  raw_name: string;
  display_name: string;
};

type ViewTask = Task & {
  effectiveDueAt: string | null;
  effectiveCourse: string | null;
};

// A calendar event (from Google Calendar). Unlike a task it has a start AND
// an end, and nothing to complete or dismiss — which is why it lives in its
// own table instead of `tasks`.
type EventRow = {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
};

const currentYear = new Date().getFullYear();
const MIN_YEAR = currentYear - 1;
const MAX_YEAR = currentYear + 5;

// How old synced data may get before opening the app triggers a fresh sync.
const SYNC_STALE_MS = 15 * 60 * 1000;

const NO_SUBJECT = 'No subject';
const NO_DATE = 'No due date';

const cellBorder = '1px solid #444';

const locales = { 'en-US': enUS };
// Monday-start week (weekStartsOn: 1) — date-fns/enUS defaults to Sunday
// (weekStartsOn: 0), which is what this overrides.
const startOfWeek = (date: Date) => dateFnsStartOfWeek(date, { weekStartsOn: 1 });

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});

function dateLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function hasSpecificTime(iso: string): boolean {
  const d = new Date(iso);
  return d.getHours() !== 0 || d.getMinutes() !== 0;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return startOfLocalDay(a).getTime() === startOfLocalDay(b).getTime();
}

// Timed events are real instants and convert straight to local time. All-day
// events have no time or timezone — the server stores them as UTC midnights
// that stand for a calendar date — so we read the date back with the UTC
// getters and rebuild it as local midnight. (End is exclusive, as in iCal.)
function eventLocalRange(e: EventRow): { start: Date; end: Date } {
  if (e.all_day) {
    const s = new Date(e.start_at);
    const en = new Date(e.end_at);
    return {
      start: new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()),
      end: new Date(en.getUTCFullYear(), en.getUTCMonth(), en.getUTCDate()),
    };
  }
  return { start: new Date(e.start_at), end: new Date(e.end_at) };
}

function eventOverlapsDay(range: { start: Date; end: Date }, day: Date): boolean {
  const dayStart = startOfLocalDay(day).getTime();
  const dayEnd = addDays(startOfLocalDay(day), 1).getTime();
  const start = range.start.getTime();
  const end = range.end.getTime();
  if (end <= start) return start >= dayStart && start < dayEnd; // zero-length
  return start < dayEnd && end > dayStart;
}

function splitIso(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time };
}

// Effective subject, in priority order: a manual per-task override, then
// a batch mapping keyed on the raw Canvas course code, then the raw code
// itself if nothing's mapped it yet.
function withEffectiveFields(tasks: Task[], mappings: Map<string, string>): ViewTask[] {
  return tasks.map((t) => ({
    ...t,
    effectiveDueAt: t.due_at_override ?? t.due_at,
    effectiveCourse:
      t.course_display_name?.trim() ||
      (t.course_name ? mappings.get(t.course_name) : undefined) ||
      t.course_name?.trim() ||
      null,
  }));
}

function sortByEffectiveDueAt(tasks: ViewTask[]): ViewTask[] {
  return [...tasks].sort((a, b) => {
    if (!a.effectiveDueAt && !b.effectiveDueAt) return 0;
    // Undated tasks sort first, not last — this is what puts "No due
    // date" at the top of every table/date-group instead of the bottom.
    if (!a.effectiveDueAt) return -1;
    if (!b.effectiveDueAt) return 1;
    return new Date(a.effectiveDueAt).getTime() - new Date(b.effectiveDueAt).getTime();
  });
}

function groupBySubject(tasks: ViewTask[]): [string, ViewTask[]][] {
  const groups = new Map<string, ViewTask[]>();
  for (const task of tasks) {
    const label = task.effectiveCourse || NO_SUBJECT;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(task);
  }
  const entries = Array.from(groups.entries());
  entries.sort(([, a], [, b]) => {
    const earliestA = a.find((t) => t.effectiveDueAt)?.effectiveDueAt;
    const earliestB = b.find((t) => t.effectiveDueAt)?.effectiveDueAt;
    if (!earliestA && !earliestB) return 0;
    if (!earliestA) return 1;
    if (!earliestB) return -1;
    return new Date(earliestA).getTime() - new Date(earliestB).getTime();
  });
  return entries;
}

function groupByDate(tasks: ViewTask[]): [string, ViewTask[]][] {
  const groups: [string, ViewTask[]][] = [];
  for (const task of tasks) {
    const label = task.effectiveDueAt ? dateLabel(task.effectiveDueAt) : NO_DATE;
    const last = groups[groups.length - 1];
    if (last && last[0] === label) {
      last[1].push(task);
    } else {
      groups.push([label, [task]]);
    }
  }
  return groups;
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [mappings, setMappings] = useState<CourseMapping[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'calendar' | 'completed'>('table');
  const [groupMode, setGroupMode] = useState<'subject' | 'date'>('date');
  const [showMappingPanel, setShowMappingPanel] = useState(false);
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, string>>({});
  const [webAssignStatus, setWebAssignStatus] = useState('');
  const [lastWebAssignImport, setLastWebAssignImport] = useState<string | null>(null);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [lastGoogleSync, setLastGoogleSync] = useState<string | null>(null);
  const [googleStatus, setGoogleStatus] = useState('');
  const [canvasStatus, setCanvasStatus] = useState('');
  const [calFilter, setCalFilter] = useState<'both' | 'assignments' | 'events'>('both');

  // null until the page is running in the browser, so the server-rendered
  // HTML never contains a date (server and browser timezones can differ).
  const [summaryDate, setSummaryDate] = useState<Date | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [subjectMode, setSubjectMode] = useState<'select' | 'new'>('select');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [error, setError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSource, setEditSource] = useState<string>('manual');
  const [editTitle, setEditTitle] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editSubjectMode, setEditSubjectMode] = useState<'select' | 'new'>('select');
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editError, setEditError] = useState('');

  const [notesOpenId, setNotesOpenId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');

  const [calDate, setCalDate] = useState(new Date());
  const [calView, setCalView] = useState<'month' | 'week'>('month');

  async function fetchTasks() {
    const { data, error } = await supabase
      .from('tasks')
      .select(
        'id, title, due_at, status, course_name, notes, source, course_display_name, due_at_override'
      )
      .eq('dismissed', false)
      .order('due_at', { ascending: true, nullsFirst: false });

    if (error) console.error(error);
    else setTasks(data ?? []);
  }

  async function fetchMappings() {
    const { data, error } = await supabase
      .from('course_mappings')
      .select('raw_name, display_name');

    if (error) console.error(error);
    else setMappings(data ?? []);
  }

  async function fetchLastWebAssignImport() {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'last_webassign_import')
      .maybeSingle();

    if (error) console.error(error);
    else setLastWebAssignImport(data?.value ?? null);
  }

  async function fetchEvents() {
    const { data, error } = await supabase
      .from('events')
      .select('id, title, start_at, end_at, all_day, location')
      .order('start_at', { ascending: true });

    if (error) {
      console.warn('Could not load events (has the events table been created?):', error.message);
    } else {
      setEvents(data ?? []);
    }
  }

  async function fetchLastGoogleSync(): Promise<string | null> {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'last_google_sync')
      .maybeSingle();

    if (error) {
      console.warn(error.message);
      return null;
    }
    setLastGoogleSync(data?.value ?? null);
    return data?.value ?? null;
  }

  async function syncGoogle() {
    setGoogleStatus('Syncing calendar…');
    try {
      const res = await fetch('/api/sync-google');
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.success) {
        console.warn('Google sync failed:', json?.error ?? res.status);
        setGoogleStatus(
          json?.error === 'GOOGLE_ICS_URL is not set'
            ? 'Calendar not connected yet.'
            : 'Calendar sync failed.'
        );
        return;
      }

      setGoogleStatus('');
      await fetchEvents();
      await fetchLastGoogleSync();
    } catch (err) {
      console.warn('Google sync threw:', err);
      setGoogleStatus('Calendar sync failed.');
    }
  }

  // Sync on open: the daily cron alone would leave "today's schedule" up to a
  // day out of date, so opening the app also refreshes when the last sync is
  // older than 15 minutes.
  async function maybeSyncGoogle() {
    const last = await fetchLastGoogleSync();
    const stale = !last || Date.now() - new Date(last).getTime() > SYNC_STALE_MS;
    if (stale) await syncGoogle();
  }

  async function syncCanvas() {
    setCanvasStatus('Syncing Canvas…');
    try {
      const res = await fetch('/api/sync-canvas');
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.success) {
        console.warn('Canvas sync failed:', json?.error ?? res.status);
        setCanvasStatus('Canvas sync failed.');
        return;
      }

      setCanvasStatus('');
      await fetchTasks();
    } catch (err) {
      console.warn('Canvas sync threw:', err);
      setCanvasStatus('Canvas sync failed.');
    }
  }

  // Same idea as Google: the daily cron is only a backstop, so opening the
  // app re-syncs Canvas whenever the last sync is older than the threshold.
  async function maybeSyncCanvas() {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'last_canvas_sync')
      .maybeSingle();

    if (error) console.warn(error.message);
    const last = data?.value ?? null;
    const stale = !last || Date.now() - new Date(last).getTime() > SYNC_STALE_MS;
    if (stale) await syncCanvas();
  }

  useEffect(() => {
    fetchTasks();
    fetchMappings();
    fetchLastWebAssignImport();
    fetchEvents();
    maybeSyncGoogle();
    maybeSyncCanvas();

    setSummaryDate(startOfLocalDay(new Date()));
    try {
      if (window.localStorage.getItem('summaryOpen') === 'false') setSummaryOpen(false);
    } catch {
      // storage can be unavailable (private mode etc.) — default stays open
    }

    // A phone browser keeps tabs alive for days, so "opening the app" often
    // just means switching back to a tab that loaded long ago. Re-check
    // whenever the tab becomes visible again.
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      fetchTasks();
      fetchEvents();
      maybeSyncGoogle();
      maybeSyncCanvas();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  function buildDueAtIso(
    date: string,
    time: string,
    setErr: (msg: string) => void
  ): { iso: string | null; ok: boolean } {
    if (!date) return { iso: null, ok: true };
    const parsed = new Date(`${date}T${time || '00:00'}`);
    const year = parsed.getFullYear();
    if (year < MIN_YEAR || year > MAX_YEAR) {
      setErr(`That due date's year (${year}) looks off — check it before saving.`);
      return { iso: null, ok: false };
    }
    return { iso: parsed.toISOString(), ok: true };
  }

  async function addTask() {
    if (!title.trim()) return;
    setError('');

    const { iso, ok } = buildDueAtIso(dueDate, dueTime, setError);
    if (!ok) return;

    const { error: insertError } = await supabase.from('tasks').insert({
      title,
      due_at: iso,
      course_name: subject.trim() || null,
    });

    if (insertError) {
      console.error(insertError);
      setError('Something went wrong saving that task.');
      return;
    }

    setTitle('');
    setSubject('');
    setSubjectMode('select');
    setShowAddForm(false);
    setDueDate('');
    setDueTime('');
    fetchTasks();
  }

  async function toggleComplete(id: string, currentStatus: string) {
    const newStatus = currentStatus === 'pending' ? 'done' : 'pending';
    const { error } = await supabase
      .from('tasks')
      .update({ status: newStatus })
      .eq('id', id);
    if (error) console.error(error);
    else fetchTasks();
  }

  // Canvas tasks are never hard-deleted — the next sync would just see
  // "this Canvas assignment isn't in my table" and re-insert it. Instead,
  // a "dismissed" flag hides it from view, and sync (which never writes
  // that column) can't undo the dismissal. Manual tasks have no such
  // conflict, so they're still genuinely deleted.
  async function deleteTask(task: ViewTask) {
    // Any non-manual source gets dismissed rather than deleted — the
    // next sync/import would just re-add a hard-deleted row otherwise.
    if (task.source !== 'manual') {
      const { error } = await supabase
        .from('tasks')
        .update({ dismissed: true })
        .eq('id', task.id);
      if (error) console.error(error);
      else fetchTasks();
      return;
    }

    const { error } = await supabase.from('tasks').delete().eq('id', task.id);
    if (error) console.error(error);
    else fetchTasks();
  }

  function startEdit(task: ViewTask) {
    setEditingId(task.id);
    setEditSource(task.source);
    setEditTitle(task.title);
    setEditSubject(task.effectiveCourse ?? '');
    setEditSubjectMode('select');
    const { date, time } = splitIso(task.effectiveDueAt);
    setEditDate(date);
    setEditTime(time);
    setEditError('');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError('');
  }

  async function saveEdit(id: string) {
    setEditError('');
    const { iso, ok } = buildDueAtIso(editDate, editTime, setEditError);
    if (!ok) return;

    const payload =
      editSource !== 'manual'
        ? { course_display_name: editSubject.trim() || null, due_at_override: iso }
        : { title: editTitle, course_name: editSubject.trim() || null, due_at: iso };

    const { error } = await supabase.from('tasks').update(payload).eq('id', id);

    if (error) {
      console.error(error);
      setEditError('Something went wrong saving that edit.');
      return;
    }

    setEditingId(null);
    fetchTasks();
  }

  function openNotes(task: Task) {
    setNotesOpenId(task.id);
    setNotesDraft(task.notes ?? '');
  }

  function closeNotes() {
    setNotesOpenId(null);
  }

  async function saveNotes(id: string) {
    const { error } = await supabase
      .from('tasks')
      .update({ notes: notesDraft || null })
      .eq('id', id);
    if (error) console.error(error);
    else fetchTasks();
  }

  function openMappingPanel() {
    const drafts: Record<string, string> = {};
    for (const rawName of rawSyncedCourses) {
      const existing = mappings.find((m) => m.raw_name === rawName);
      drafts[rawName] = existing?.display_name ?? '';
    }
    setMappingDrafts(drafts);
    setShowMappingPanel(true);
  }

  async function saveMappings() {
    const rows = Object.entries(mappingDrafts)
      .filter(([, displayName]) => displayName.trim())
      .map(([rawName, displayName]) => ({
        raw_name: rawName,
        display_name: displayName.trim(),
      }));

    if (rows.length === 0) {
      setShowMappingPanel(false);
      return;
    }

    const { error } = await supabase
      .from('course_mappings')
      .upsert(rows, { onConflict: 'raw_name' });

    if (error) {
      console.error(error);
      return;
    }

    setShowMappingPanel(false);
    fetchMappings();
  }

  async function importWebAssignFile(file: File) {
    setWebAssignStatus('Importing…');

    try {
      const text = await file.text();
      const res = await fetch('/api/import-webassign', { method: 'POST', body: text });

      if (!res.ok) {
        // The route errored badly enough that it didn't even return its
        // own JSON error shape (e.g. a 404 because the file isn't at the
        // right path, or an unhandled server crash) — read as text so we
        // can show *something* instead of throwing on res.json().
        const text = await res.text();
        console.error('WebAssign import HTTP error:', res.status, text);
        setWebAssignStatus(`Import failed (HTTP ${res.status}) — check the console.`);
        return;
      }

      const json = await res.json();

      if (!json.success) {
        console.error(json.error);
        setWebAssignStatus(`Import failed: ${json.error}`);
        return;
      }

      setWebAssignStatus(`Imported/updated ${json.upserted} WebAssign task(s).`);
      fetchTasks();
      fetchLastWebAssignImport();
    } catch (err) {
      console.error('WebAssign import threw:', err);
      setWebAssignStatus('Import failed unexpectedly — check the console.');
    }
  }

  const mappingsMap = new Map(mappings.map((m) => [m.raw_name, m.display_name]));
  const viewTasks = sortByEffectiveDueAt(withEffectiveFields(tasks, mappingsMap));

  // Every distinct subject name currently in use, across both manual
  // entries and Canvas mappings — this is what populates the subject
  // dropdown so retyping isn't necessary (and typos can't quietly split
  // one subject into two).
  const existingSubjects = Array.from(
    new Set(viewTasks.map((t) => t.effectiveCourse).filter((s): s is string => !!s))
  ).sort();

  // Completed tasks get pulled out of the main table/calendar entirely,
  // so the primary view only ever shows what's still actually pending —
  // done items live in their own tab instead of sitting struck-through
  // in the middle of everything else.
  const pendingTasks = viewTasks.filter((t) => t.status !== 'done');
  const completedTasks = viewTasks.filter((t) => t.status === 'done');

  // Which grouping sits on the outside (section headings) versus inside
  // (the row-span column) is exactly reversed between the two modes —
  // everything else about the table is identical either way.
  const subGroupFn = groupMode === 'subject' ? groupByDate : groupBySubject;
  const grouped =
    groupMode === 'subject' ? groupBySubject(pendingTasks) : groupByDate(pendingTasks);
  const groupedCompleted =
    groupMode === 'subject' ? groupBySubject(completedTasks) : groupByDate(completedTasks);
  const notesTask = tasks.find((t) => t.id === notesOpenId);

  // Every distinct raw Canvas course code currently in your tasks — this
  // is what the mapping panel lets you assign friendly names to, once
  // each, regardless of how many tasks share that code.
  const rawSyncedCourses = Array.from(
    new Set(
      tasks
        .filter((t) => t.source !== 'manual' && t.course_name)
        .map((t) => t.course_name as string)
    )
  ).sort();

  const taskCalendarItems = pendingTasks
    .filter((t) => t.effectiveDueAt)
    .map((t) => ({
      id: t.id,
      kind: 'task' as const,
      title: t.effectiveCourse ? `${t.title} (${t.effectiveCourse})` : t.title,
      start: new Date(t.effectiveDueAt!),
      end: new Date(t.effectiveDueAt!),
      allDay: false,
      resource: t,
    }));

  const googleCalendarItems = events.map((e) => {
    const range = eventLocalRange(e);
    return {
      id: e.id,
      kind: 'event' as const,
      title: e.title,
      start: range.start,
      end: range.end,
      allDay: e.all_day,
      resource: e,
    };
  });

  const calendarEvents = [
    ...(calFilter !== 'events' ? taskCalendarItems : []),
    ...(calFilter !== 'assignments' ? googleCalendarItems : []),
  ];

  // A week is the threshold for "stale" — matches the once-a-week check-in
  // habit for WebAssign, since nothing watches it automatically.
  const STALE_DAYS = 7;
  const daysSinceWebAssignImport = lastWebAssignImport
    ? Math.floor((Date.now() - new Date(lastWebAssignImport).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const webAssignIsStale = daysSinceWebAssignImport === null || daysSinceWebAssignImport >= STALE_DAYS;

  // --- Day summary box ---------------------------------------------------
  // Everything below is recomputed from the same `tasks` and `events` state
  // the rest of the page uses, on every render. The box never keeps its own
  // copy, so ticking a task off anywhere updates it everywhere.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const todayStart = startOfLocalDay(new Date());
  const dayOffset = summaryDate
    ? Math.round((summaryDate.getTime() - todayStart.getTime()) / MS_PER_DAY)
    : 0;

  const summaryEvents = summaryDate
    ? events
        .map((e) => ({ e, range: eventLocalRange(e) }))
        .filter(({ range }) => eventOverlapsDay(range, summaryDate))
        .sort((a, b) => {
          if (a.e.all_day !== b.e.all_day) return a.e.all_day ? -1 : 1;
          return a.range.start.getTime() - b.range.start.getTime();
        })
    : [];

  const summaryDue = summaryDate
    ? pendingTasks.filter(
        (t) => t.effectiveDueAt && sameLocalDay(new Date(t.effectiveDueAt), summaryDate)
      )
    : [];

  // Overdue is only meaningful relative to the real today, so it only shows
  // while you're looking at today. A task due today is not overdue yet, even
  // with no set time: it becomes overdue once its date has passed.
  const summaryOverdue =
    summaryDate && dayOffset === 0
      ? pendingTasks.filter(
          (t) =>
            t.effectiveDueAt &&
            startOfLocalDay(new Date(t.effectiveDueAt)).getTime() < todayStart.getTime()
        )
      : [];

  function shiftSummary(days: number) {
    setSummaryDate((d) => (d ? addDays(d, days) : d));
  }

  function goToToday() {
    setSummaryDate(startOfLocalDay(new Date()));
  }

  function toggleSummary() {
    const next = !summaryOpen;
    setSummaryOpen(next);
    try {
      window.localStorage.setItem('summaryOpen', String(next));
    } catch {
      // not fatal — it just won't be remembered
    }
  }

  function renderSummaryTask(t: ViewTask, showDate: boolean) {
    const meta = [
      showDate && t.effectiveDueAt
        ? new Date(t.effectiveDueAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })
        : null,
      t.effectiveCourse,
      t.effectiveDueAt && hasSpecificTime(t.effectiveDueAt) ? timeLabel(t.effectiveDueAt) : null,
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <li key={t.id} className="summary-task">
        <input
          type="checkbox"
          checked={false}
          onChange={() => toggleComplete(t.id, t.status)}
          aria-label={`Mark ${t.title} done`}
        />
        <button className="link-button" onClick={() => openNotes(t)}>
          {t.title}
        </button>
        {meta && <span className="muted">{meta}</span>}
      </li>
    );
  }

  function renderSummaryBox() {
    if (!summaryDate) return null;
    const day = summaryDate;
    const label =
      dayOffset === 0
        ? 'Today'
        : dayOffset === 1
          ? 'Tomorrow'
          : dayOffset === -1
            ? 'Yesterday'
            : day.toLocaleDateString(undefined, { weekday: 'long' });
    const dateText = day.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const todoCount = summaryOverdue.length + summaryDue.length;
    const calendarConnected = lastGoogleSync !== null || events.length > 0;

    return (
      <section className="summary-box">
        <div className="summary-header">
          <button onClick={() => shiftSummary(-1)} aria-label="Previous day">
            ‹
          </button>
          <div className="summary-title">
            <strong>{label}</strong>
            <span className="muted">{dateText}</span>
          </div>
          <button onClick={() => shiftSummary(1)} aria-label="Next day">
            ›
          </button>
          {dayOffset !== 0 && <button onClick={goToToday}>Today</button>}
          <span className="summary-counts muted">
            {summaryEvents.length} event{summaryEvents.length === 1 ? '' : 's'} · {todoCount} to do
          </span>
          <button onClick={toggleSummary}>{summaryOpen ? 'Hide' : 'Show'}</button>
        </div>

        {summaryOpen && (
          <div className="summary-body">
            <div>
              <h4>Schedule</h4>
              {!calendarConnected ? (
                <p className="muted">{googleStatus || 'Calendar not connected yet.'}</p>
              ) : summaryEvents.length === 0 ? (
                <p className="muted">Nothing scheduled.</p>
              ) : (
                <ul className="summary-list">
                  {summaryEvents.map(({ e }) => (
                    <li key={e.id} className="summary-event">
                      <span className="summary-time">
                        {e.all_day
                          ? 'All day'
                          : `${timeLabel(e.start_at)}–${timeLabel(e.end_at)}`}
                      </span>
                      <span>
                        {e.title}
                        {e.location && <span className="muted"> · {e.location}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h4>To do</h4>
              {todoCount === 0 ? (
                <p className="muted">Nothing due.</p>
              ) : (
                <>
                  {summaryOverdue.length > 0 && (
                    <>
                      <p className="summary-subhead">Overdue</p>
                      <ul className="summary-list">
                        {summaryOverdue.map((t) => renderSummaryTask(t, true))}
                      </ul>
                    </>
                  )}
                  {summaryDue.length > 0 && (
                    <>
                      {summaryOverdue.length > 0 && <p className="summary-subhead">Due</p>}
                      <ul className="summary-list">
                        {summaryDue.map((t) => renderSummaryTask(t, false))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    );
  }

  // Renders a two-level grouped table — the outer level becomes section
  // headings, the inner level becomes the row-spanning left column. Which
  // function does which job is what makes "group by subject" and "group
  // by date" the same rendering code with the roles swapped.
  // Shared subject picker for both the Add form and inline editing — a
  // dropdown of existing subjects, with "Add new" swapping in a text
  // input for a genuinely new one. Same component either way; only the
  // value/mode state passed in differs.
  function renderSubjectPicker(
    value: string,
    setValue: (v: string) => void,
    mode: 'select' | 'new',
    setMode: (m: 'select' | 'new') => void,
    placeholder: string
  ) {
    if (mode === 'new') {
      return (
        <span style={{ display: 'inline-flex', gap: 4 }}>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="New subject name"
            autoFocus
          />
          <button
            type="button"
            title="Choose an existing subject instead"
            onClick={() => {
              setMode('select');
              setValue('');
            }}
          >
            ↩
          </button>
        </span>
      );
    }

    return (
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === '__new__') {
            setMode('new');
            setValue('');
          } else {
            setValue(e.target.value);
          }
        }}
        // Unlike the surrounding text inputs, <select> doesn't reliably
        // inherit the page's dark color-scheme on its own — this is what
        // was causing the light-grey-on-white contrast issue.
        style={{ colorScheme: 'dark' }}
      >
        <option value="" style={{ background: '#1e1e1e', color: 'white' }}>
          {placeholder}
        </option>
        {existingSubjects.map((s) => (
          <option key={s} value={s} style={{ background: '#1e1e1e', color: 'white' }}>
            {s}
          </option>
        ))}
        <option value="__new__" style={{ background: '#1e1e1e', color: 'white' }}>
          + Add new subject…
        </option>
      </select>
    );
  }

  function renderGroupedTable(
    outerGroups: [string, ViewTask[]][],
    innerGroupFn: (tasks: ViewTask[]) => [string, ViewTask[]][]
  ) {
    return outerGroups.map(([outerLabel, outerTasks]) => (
      <div
        key={outerLabel}
        style={{
          marginBottom: 36,
          paddingBottom: 12,
          borderBottom: '2px solid #666',
        }}
      >
        <h3 style={{ marginBottom: 8 }}>{outerLabel}</h3>
        <div className="table-scroll">
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {innerGroupFn(outerTasks).map(([label, dateTasks]) =>
              dateTasks.map((t, i) => {
                const isSynced = t.source !== 'manual';
                const isEditing = editingId === t.id;

                return (
                  <tr key={t.id}>
                    {i === 0 && (
                      <td
                        rowSpan={dateTasks.length}
                        style={{
                          verticalAlign: 'top',
                          padding: '8px 16px 8px 0',
                          whiteSpace: 'nowrap',
                          fontWeight: 500,
                          borderBottom: cellBorder,
                          borderTop: cellBorder,
                        }}
                      >
                        {label}
                      </td>
                    )}

                    <td
                      style={{
                        padding: '8px 16px',
                        width: '100%',
                        borderBottom: cellBorder,
                        borderTop: cellBorder,
                      }}
                    >
                      {isEditing ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {isSynced ? (
                            <span style={{ opacity: 0.7 }}>
                              {editTitle} <em>(title set by sync — not editable)</em>
                            </span>
                          ) : (
                            <input
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                            />
                          )}
                          {renderSubjectPicker(
                            editSubject,
                            setEditSubject,
                            editSubjectMode,
                            setEditSubjectMode,
                            'Subject'
                          )}
                          <div>
                            <input
                              type="date"
                              value={editDate}
                              onChange={(e) => setEditDate(e.target.value)}
                            />
                            <input
                              type="time"
                              value={editTime}
                              onChange={(e) => setEditTime(e.target.value)}
                              disabled={!editDate}
                            />
                          </div>
                          {editError && (
                            <p style={{ color: 'crimson', margin: 0 }}>{editError}</p>
                          )}
                        </div>
                      ) : (
                        <>
                          <span
                            onClick={() => toggleComplete(t.id, t.status)}
                            style={{
                              cursor: 'pointer',
                              textDecoration: t.status === 'done' ? 'line-through' : 'none',
                            }}
                          >
                            {t.title}
                          </span>
                          {t.effectiveDueAt && hasSpecificTime(t.effectiveDueAt) && (
                            <span style={{ opacity: 0.7 }}>
                              {' '}
                              — {timeLabel(t.effectiveDueAt)}
                            </span>
                          )}
                          <button
                            onClick={() => openNotes(t)}
                            title={t.notes ? 'View/edit notes' : 'Add a note'}
                            style={{
                              marginLeft: 8,
                              fontWeight: t.notes ? 'bold' : 'normal',
                            }}
                          >
                            📝
                          </button>
                        </>
                      )}
                    </td>

                    <td
                      style={{
                        padding: '8px 0',
                        whiteSpace: 'nowrap',
                        borderBottom: cellBorder,
                        borderTop: cellBorder,
                      }}
                    >
                      {isEditing ? (
                        <>
                          <button onClick={() => saveEdit(t.id)}>Save</button>{' '}
                          <button onClick={cancelEdit}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(t)}>Edit</button>{' '}
                          <button onClick={() => deleteTask(t)}>
                            {isSynced ? 'Dismiss' : 'Delete'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>
    ));
  }

  return (
    <main className="app-main">
      <h1>Tasks</h1>

      {renderSummaryBox()}

      {webAssignIsStale && (
        <p
          style={{
            background: '#4a3a00',
            border: '1px solid #a67c00',
            padding: '8px 12px',
            borderRadius: 6,
            marginBottom: 20,
          }}
        >
          {lastWebAssignImport
            ? `It's been ${daysSinceWebAssignImport} days since your last WebAssign import — worth checking for new assignments.`
            : "You haven't imported a WebAssign calendar yet."}
        </p>
      )}

      <button className="add-toggle" onClick={() => setShowAddForm((v) => !v)}>
        {showAddForm ? 'Close' : '+ Add task'}
      </button>

      <div className={`task-form${showAddForm ? ' open' : ''}`}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          placeholder="New task"
        />
        {renderSubjectPicker(subject, setSubject, subjectMode, setSubjectMode, 'Subject (optional)')}
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          min={`${MIN_YEAR}-01-01`}
          max={`${MAX_YEAR}-12-31`}
        />
        <input
          type="time"
          value={dueTime}
          onChange={(e) => setDueTime(e.target.value)}
          disabled={!dueDate}
          title={!dueDate ? 'Pick a date first' : 'Optional — defaults to midnight'}
        />
        <button onClick={addTask}>Add</button>
      </div>

      {error && (
        <p style={{ color: 'crimson', marginTop: -10, marginBottom: 20 }}>
          {error}
        </p>
      )}

      <div className="toolbar-row">
        <button
          onClick={() => setViewMode('table')}
          style={{ fontWeight: viewMode === 'table' ? 'bold' : 'normal' }}
        >
          Table view
        </button>
        <button
          onClick={() => setViewMode('calendar')}
          style={{ fontWeight: viewMode === 'calendar' ? 'bold' : 'normal' }}
        >
          Calendar view
        </button>
        <button
          onClick={() => setViewMode('completed')}
          style={{ fontWeight: viewMode === 'completed' ? 'bold' : 'normal' }}
        >
          Completed
        </button>

        {viewMode !== 'calendar' && (
          <>
            <span className="muted">|</span>
            <button
              onClick={() => setGroupMode('subject')}
              style={{ fontWeight: groupMode === 'subject' ? 'bold' : 'normal' }}
            >
              Group by subject
            </button>
            <button
              onClick={() => setGroupMode('date')}
              style={{ fontWeight: groupMode === 'date' ? 'bold' : 'normal' }}
            >
              Group by date
            </button>
          </>
        )}

        {viewMode === 'calendar' && (
          <>
            <span className="muted">|</span>
            <button
              onClick={() => setCalFilter('both')}
              style={{ fontWeight: calFilter === 'both' ? 'bold' : 'normal' }}
            >
              Both
            </button>
            <button
              onClick={() => setCalFilter('assignments')}
              style={{ fontWeight: calFilter === 'assignments' ? 'bold' : 'normal' }}
            >
              Assignments
            </button>
            <button
              onClick={() => setCalFilter('events')}
              style={{ fontWeight: calFilter === 'events' ? 'bold' : 'normal' }}
            >
              Events
            </button>
            <span className="muted">blue = assignments, green = events</span>
          </>
        )}
      </div>

      <details className="tools">
        <summary>More tools</summary>
        <div className="toolbar-row">
          <button onClick={openMappingPanel}>Manage subject names</button>
          <label className="file-button">
            Import WebAssign .ics
            <input
              type="file"
              accept=".ics"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importWebAssignFile(file);
                e.target.value = ''; // allows re-selecting the same file later
              }}
            />
          </label>
          <button onClick={syncGoogle}>Sync calendar</button>
          <button onClick={syncCanvas}>Sync Canvas</button>
        </div>
        {webAssignStatus && <p className="muted">{webAssignStatus}</p>}
        {googleStatus && <p className="muted">{googleStatus}</p>}
        {canvasStatus && <p className="muted">{canvasStatus}</p>}
      </details>

      {showMappingPanel && (
        <div
          style={{
            marginBottom: 24,
            padding: 16,
            border: '1px solid #666',
            borderRadius: 8,
          }}
        >
          <p style={{ marginTop: 0 }}>
            Assign a friendly name to each raw synced course label (from Canvas or
            WebAssign). This applies to every
            task under that code — now and after future syncs — until you change it again.
          </p>
          {rawSyncedCourses.length === 0 && <p>No synced tasks yet.</p>}
          {rawSyncedCourses.map((rawName) => (
            <div key={rawName} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <span style={{ opacity: 0.7, minWidth: 220 }}>{rawName}</span>
              <input
                value={mappingDrafts[rawName] ?? ''}
                onChange={(e) =>
                  setMappingDrafts((prev) => ({ ...prev, [rawName]: e.target.value }))
                }
                placeholder="e.g. ECE 145"
              />
            </div>
          ))}
          <button onClick={saveMappings}>Save</button>{' '}
          <button onClick={() => setShowMappingPanel(false)}>Cancel</button>
        </div>
      )}

      {viewMode === 'table' && renderGroupedTable(grouped, subGroupFn)}

      {viewMode === 'completed' && (
        completedTasks.length === 0 ? (
          <p style={{ opacity: 0.7 }}>Nothing completed yet.</p>
        ) : (
          renderGroupedTable(groupedCompleted, subGroupFn)
        )
      )}

      {viewMode === 'calendar' && (
        <div
          style={{
            background: 'white',
            color: '#111',
            colorScheme: 'light',
            padding: 16,
            borderRadius: 8,
          }}
        >
          <Calendar
            localizer={localizer}
            events={calendarEvents}
            startAccessor="start"
            endAccessor="end"
            views={['month', 'week']}
            style={{ height: 750 }}
            popup
            date={calDate}
            view={calView}
            onNavigate={(newDate: Date) => setCalDate(newDate)}
            onView={(newView: string) => setCalView(newView as 'month' | 'week')}
            onSelectEvent={(item: { kind: string; resource: Task }) => {
              // Assignments open the notes panel; events are read-only.
              if (item.kind === 'task') openNotes(item.resource);
            }}
            eventPropGetter={(item: { kind: string }) => ({
              style: {
                backgroundColor: item.kind === 'event' ? '#2e7d5b' : '#3174ad',
              },
            })}
            components={{
              // Native browser tooltip on hover — shows the full title
              // even when the event bar itself truncates it visually.
              event: ({ event }: { event: { title: string } }) => (
                <span title={event.title}>{event.title}</span>
              ),
            }}
          />
        </div>
      )}

      {notesTask && (
        <div
          className="notes-panel"
          style={{
            padding: 16,
            border: '1px solid #ccc',
            borderRadius: 8,
            background: 'white',
            color: '#111',
            colorScheme: 'light',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>{notesTask.title}</strong>
            <button onClick={closeNotes}>×</button>
          </div>

          {(() => {
            const vt = viewTasks.find((v) => v.id === notesTask.id);
            if (!vt) return null;
            return (
              <div style={{ marginBottom: 12, fontSize: 14 }}>
                {vt.effectiveCourse && <div>Subject: {vt.effectiveCourse}</div>}
                <div>
                  Due:{' '}
                  {vt.effectiveDueAt
                    ? `${dateLabel(vt.effectiveDueAt)}${
                        hasSpecificTime(vt.effectiveDueAt)
                          ? `, ${timeLabel(vt.effectiveDueAt)}`
                          : ''
                      }`
                    : 'No due date'}
                </div>
                <div>Status: {vt.status}</div>
              </div>
            );
          })()}

          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={6}
            style={{
              width: '100%',
              background: 'white',
              color: '#111',
              border: '1px solid #ccc',
            }}
            placeholder="Add a note…"
          />
          <button onClick={() => saveNotes(notesTask.id)} style={{ marginTop: 8 }}>
            Save note
          </button>
        </div>
      )}
    </main>
  );
}
