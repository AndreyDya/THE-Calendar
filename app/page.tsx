'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';

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

const currentYear = new Date().getFullYear();
const MIN_YEAR = currentYear - 1;
const MAX_YEAR = currentYear + 5;

const NO_SUBJECT = 'No subject';
const NO_DATE = 'No due date';

const cellBorder = '1px solid #444';

const locales = { 'en-US': enUS };
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

  useEffect(() => {
    fetchTasks();
    fetchMappings();
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
    if (task.source === 'canvas') {
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
      editSource === 'canvas'
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
    for (const rawName of rawCanvasCourses) {
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
  const rawCanvasCourses = Array.from(
    new Set(
      tasks
        .filter((t) => t.source === 'canvas' && t.course_name)
        .map((t) => t.course_name as string)
    )
  ).sort();

  const calendarEvents = pendingTasks
    .filter((t) => t.effectiveDueAt)
    .map((t) => ({
      id: t.id,
      title: t.effectiveCourse ? `${t.title} (${t.effectiveCourse})` : t.title,
      start: new Date(t.effectiveDueAt!),
      end: new Date(t.effectiveDueAt!),
      resource: t,
    }));

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
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {innerGroupFn(outerTasks).map(([label, dateTasks]) =>
              dateTasks.map((t, i) => {
                const isCanvas = t.source === 'canvas';
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
                          {isCanvas ? (
                            <span style={{ opacity: 0.7 }}>
                              {editTitle} <em>(title set by Canvas — not editable)</em>
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
                            {isCanvas ? 'Dismiss' : 'Delete'}
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
    ));
  }

  return (
    <main style={{ padding: 40, paddingRight: 320 }}>
      <h1>Tasks</h1>

      <div style={{ marginBottom: 20 }}>
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

      <div style={{ marginBottom: 20 }}>
        <button
          onClick={() => setViewMode('table')}
          style={{ fontWeight: viewMode === 'table' ? 'bold' : 'normal' }}
        >
          Table view
        </button>{' '}
        <button
          onClick={() => setViewMode('calendar')}
          style={{ fontWeight: viewMode === 'calendar' ? 'bold' : 'normal' }}
        >
          Calendar view
        </button>{' '}
        <button
          onClick={() => setViewMode('completed')}
          style={{ fontWeight: viewMode === 'completed' ? 'bold' : 'normal' }}
        >
          Completed
        </button>{' '}
        <button onClick={openMappingPanel}>Manage subject names</button>{' '}
        {viewMode !== 'calendar' && (
          <>
            |{' '}
            <button
              onClick={() => setGroupMode('subject')}
              style={{ fontWeight: groupMode === 'subject' ? 'bold' : 'normal' }}
            >
              Group by subject
            </button>{' '}
            <button
              onClick={() => setGroupMode('date')}
              style={{ fontWeight: groupMode === 'date' ? 'bold' : 'normal' }}
            >
              Group by date
            </button>
          </>
        )}
      </div>

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
            Assign a friendly name to each raw Canvas course code. This applies to every
            task under that code — now and after future syncs — until you change it again.
          </p>
          {rawCanvasCourses.length === 0 && <p>No Canvas-synced tasks yet.</p>}
          {rawCanvasCourses.map((rawName) => (
            <div key={rawName} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
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
            onSelectEvent={(event: { resource: Task }) => openNotes(event.resource)}
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
          style={{
            position: 'fixed',
            top: 40,
            right: 20,
            width: 260,
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
