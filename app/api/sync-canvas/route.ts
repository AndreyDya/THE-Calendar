import ical from 'node-ical';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const CANVAS_ICS_URL = process.env.CANVAS_ICS_URL!;

// A minimal shape for what we actually read off a parsed ICS event —
// deliberately not relying on node-ical's own exported type names,
// since `ical` was imported as a value, not a type namespace, and its
// internal type names vary between versions anyway.
interface IcsEvent {
  type: string;
  start?: Date;
  summary?: string;
  uid?: string;
  url?: string;
}

function parseSummary(summary: string): { title: string; course: string | null } {
  const match = summary.match(/^(.*)\s\[(.+)\]$/);
  if (match) {
    return { title: match[1].trim(), course: match[2].trim() };
  }
  return { title: summary.trim(), course: null };
}

export async function GET() {
  try {
    const data = (await ical.async.fromURL(CANVAS_ICS_URL)) as Record<string, IcsEvent>;

    const rows = Object.values(data)
      // The type predicate here narrows `start` from optional to
      // required, which is what fixes the "possibly undefined" error
      // below — TypeScript now knows every event in this filtered list
      // definitely has a start date.
      .filter((event): event is IcsEvent & { start: Date } => {
        return event.type === 'VEVENT' && !!event.start;
      })
      .map((event) => {
        const { title, course } = parseSummary(event.summary ?? 'Untitled');
        return {
          title,
          due_at: event.start.toISOString(),
          source: 'canvas',
          external_id: event.uid ?? `${title}-${event.start.toISOString()}`,
          course_name: course,
          html_url: event.url ?? null,
          updated_at: new Date().toISOString(),
        };
      });

    if (rows.length === 0) {
      return Response.json({ success: true, upserted: 0 });
    }

    const { error, count } = await supabaseAdmin
      .from('tasks')
      .upsert(rows, { onConflict: 'source,external_id', count: 'exact' });

    if (error) {
      console.error('Canvas sync upsert failed:', error);
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, upserted: count ?? rows.length });
  } catch (err) {
    console.error('Canvas sync failed:', err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
