'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Task = {
  id: string;
  title: string;
  due_at: string | null;
  status: string;
  course_name: string | null;
  notes: string | null;
  source: string;
};

const currentYear = new Date().getFullYear();
const MIN_YEAR = currentYear - 1;
const MAX_YEAR = currentYear + 5;

const NO_SUBJECT = 'No subject';
const NO_DATE = 'No due date';

const cellBorder = '1px solid #444'; // visible on the dark theme, not just #ddd

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

function splitIso(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time };
}

function groupBySubject(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const label = task.course_name?.trim() || NO_SUBJECT;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(task);
  }
  const entries = Array.from(groups.entries());
  entries.sort(([, a], [, b]) => {
    const earliestA = a.find((t) => t.due_at)?.due_at;
    const earliestB = b.find((t) => t.due_at)?.due_at;
    if (!earliestA && !earliestB) return 0;
    if (!earliestA) return 1;
    if (!earliestB) return -1;
    return new Date(earliestA).getTime() - new Date(earliestB).getTime();
  });
  return entries;
}

function groupByDate(tasks: Task[]): [string, Task[]][] {
  const groups: [string, Task[]][] = [];
  for (const task of tasks) {
    const label = task.due_at ? dateLabel(task.due_at) : NO_DATE;
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

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [error, setError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editError, setEditError] = useState('');

  const [notesOpenId, setNotesOpenId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');

  async function fetchTasks() {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, due_at, status, course_name, notes, source')
      .order('due_at', { ascending: true, nullsFirst: false });

    if (error) console.error(error);
    else setTasks(data ?? []);
  }

  useEffect(() => {
    fetchTasks();
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

  async function deleteTask(id: string) {
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) console.error(error);
    else fetchTasks();
  }

  function startEdit(task: Task) {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditSubject(task.course_name ?? '');
    const { date, time } = splitIso(task.due_at);
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

    const { error } = await supabase
      .from('tasks')
      .update({
        title: editTitle,
        course_name: editSubject.trim() || null,
        due_at: iso,
      })
      .eq('id', id);

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

  const grouped = groupBySubject(tasks);
  const notesTask = tasks.find((t) => t.id === notesOpenId);

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
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject (optional)"
        />
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

      {grouped.map(([subjectLabel, subjectTasks]) => (
        <div
          key={subjectLabel}
          style={{
            marginBottom: 36,
            paddingBottom: 12,
            borderBottom: '2px solid #666', // stronger break between subjects
          }}
        >
          <h3 style={{ marginBottom: 8 }}>{subjectLabel}</h3>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {groupByDate(subjectTasks).map(([label, dateTasks]) =>
                dateTasks.map((t, i) => {
                  const locked = t.source === 'canvas';
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
                            <input
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                            />
                            <input
                              value={editSubject}
                              onChange={(e) => setEditSubject(e.target.value)}
                              placeholder="Subject"
                            />
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
                            {t.due_at && (
                              <span style={{ opacity: 0.7 }}> — {timeLabel(t.due_at)}</span>
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
                            <button
                              onClick={() => startEdit(t)}
                              disabled={locked}
                              title={locked ? "Synced from Canvas — can't edit" : undefined}
                            >
                              Edit
                            </button>{' '}
                            <button onClick={() => deleteTask(t.id)}>Delete</button>
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
      ))}

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
            color: '#111', // explicit dark text, independent of the page's dark theme
            colorScheme: 'light', // forces native form controls to render light-mode
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>{notesTask.title}</strong>
            <button onClick={closeNotes}>×</button>
          </div>
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
