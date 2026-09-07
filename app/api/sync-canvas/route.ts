import ical from 'node-ical';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const CANVAS_ICS_URL = process.env.CANVAS_ICS_URL!;

// Canvas's ICS feed often appends the course as a bracketed code at the
// end of the event title, e.g. "Homework 2 [ECE120-1FA26-ONL]". This
// splits that off so it can feed the same course_name column the manual
// subject field uses. If there's no bracket, the whole thing is just the
// title and course_name stays null.
function parseSummary(summary: string): { title: string; course: string | null } {
  const match = summary.match(/^(.*)\s\[(.+)\]$/);
  if (match) {
    return { title: match[1].trim(), course: match[2].trim() };
  }
  return { title: summary.trim(), course: null };
}

export async function GET() {
  try {
    const data = await ical.async.fromURL(CANVAS_ICS_URL);

    const rows = Object.values(data)
      .filter((event): event is ical.VEvent => event.type === 'VEVENT')
      .filter((event) => event.start) // skip anything with no date at all
      .map((event) => {
        const { title, course } = parseSummary(event.summary ?? 'Untitled');
        return {
          title,
          due_at: new Date(event.start).toISOString(),
          source: 'canvas',
          external_id: event.uid,
          course_name: course,
          html_url: event.url ?? null,
          updated_at: new Date().toISOString(),
        };
      });

    if (rows.length === 0) {
      return Response.json({ success: true, upserted: 0 });
    }

    // Deliberately not touching `notes` — Canvas doesn't own that field,
    // so re-syncing must never overwrite a personal note.
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
