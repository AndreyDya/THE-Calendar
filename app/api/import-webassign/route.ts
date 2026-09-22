import ical from 'node-ical';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

interface IcsEvent {
  type: string;
  start?: Date;
  summary?: string;
  uid?: string;
  url?: string;
}

export async function POST(request: Request) {
  try {
    const icsText = await request.text();

    // parseICS works on a raw string — no network fetch involved, since
    // this is a file you downloaded and uploaded yourself, not a live
    // subscribable feed like Canvas's.
    const data = ical.sync.parseICS(icsText) as Record<string, IcsEvent>;

    const rows = Object.values(data)
      .filter((event): event is IcsEvent & { start: Date } => {
        return event.type === 'VEVENT' && !!event.start;
      })
      .map((event) => ({
        title: (event.summary ?? 'Untitled').trim(),
        due_at: event.start.toISOString(),
        source: 'webassign',
        // WebAssign's UID should be stable across re-exports of the same
        // assignment, which is what keeps re-importing an overlapping
        // month from creating duplicates.
        external_id: event.uid ?? `${event.summary}-${event.start.toISOString()}`,
        // WebAssign's ICS format doesn't reliably expose a course code
        // the way Canvas's does, so everything lands under one generic
        // label — rename it once via "Manage subject names," same as
        // any Canvas course code.
        course_name: 'WebAssign',
        html_url: event.url ?? null,
        updated_at: new Date().toISOString(),
      }));

    if (rows.length === 0) {
      await supabaseAdmin
        .from('app_settings')
        .upsert({ key: 'last_webassign_import', value: new Date().toISOString() }, { onConflict: 'key' });
      return Response.json({ success: true, upserted: 0 });
    }

    const { error, count } = await supabaseAdmin
      .from('tasks')
      .upsert(rows, { onConflict: 'source,external_id', count: 'exact' });

    if (error) {
      console.error('WebAssign import upsert failed:', error);
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    // Record the import time regardless of how many rows actually
    // changed — even a re-import of an already-seen file counts as
    // "checked WebAssign," which is what the staleness nudge cares about.
    await supabaseAdmin
      .from('app_settings')
      .upsert({ key: 'last_webassign_import', value: new Date().toISOString() }, { onConflict: 'key' });

    return Response.json({ success: true, upserted: count ?? rows.length });
  } catch (err) {
    console.error('WebAssign import failed:', err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
