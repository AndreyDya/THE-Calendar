import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { expandIcsEvents } from '@/lib/googleIcs';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_DAYS = 7;
const FUTURE_DAYS = 120;
const CHUNK = 100;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function GET() {
  try {
    const feedUrl = process.env.GOOGLE_ICS_URL;
    if (!feedUrl) {
      return Response.json(
        { success: false, error: 'GOOGLE_ICS_URL is not set' },
        { status: 400 }
      );
    }

    const res = await fetch(feedUrl, { cache: 'no-store' });
    if (!res.ok) {
      return Response.json(
        { success: false, error: `Google feed returned HTTP ${res.status}` },
        { status: 502 }
      );
    }
    const icsText = await res.text();

    // A login page or error page isn't a calendar — refusing here keeps a
    // bad response from looking like "you have no events" and wiping the table.
    if (!icsText.includes('BEGIN:VCALENDAR')) {
      return Response.json(
        { success: false, error: 'Feed did not contain a calendar' },
        { status: 502 }
      );
    }

    const now = Date.now();
    const from = new Date(now - PAST_DAYS * DAY_MS);
    const to = new Date(now + FUTURE_DAYS * DAY_MS);

    const occurrences = expandIcsEvents(icsText, from, to);
    const rows = occurrences.map((o) => ({
      ...o,
      source: 'google',
      updated_at: new Date().toISOString(),
    }));

    for (const batch of chunks(rows, 500)) {
      const { error } = await supabaseAdmin
        .from('events')
        .upsert(batch, { onConflict: 'source,external_id' });
      if (error) {
        console.error('Google sync upsert failed:', error);
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
    }

    // Mirror, not just upsert: events get cancelled and moved constantly, so
    // anything inside the sync window that the feed no longer contains has to
    // be removed here, or it would linger in the app forever.
    const keep = new Set(rows.map((r) => r.external_id));
    const { data: existing, error: listError } = await supabaseAdmin
      .from('events')
      .select('id, external_id')
      .eq('source', 'google')
      .gte('start_at', from.toISOString())
      .lte('start_at', to.toISOString());

    if (listError) {
      console.error('Google sync list failed:', listError);
      return Response.json({ success: false, error: listError.message }, { status: 500 });
    }

    const staleIds = (existing ?? []).filter((e) => !keep.has(e.external_id)).map((e) => e.id);
    for (const batch of chunks(staleIds, CHUNK)) {
      const { error } = await supabaseAdmin.from('events').delete().in('id', batch);
      if (error) {
        console.error('Google sync delete failed:', error);
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
    }

    await supabaseAdmin
      .from('app_settings')
      .upsert(
        { key: 'last_google_sync', value: new Date().toISOString() },
        { onConflict: 'key' }
      );

    return Response.json({ success: true, synced: rows.length, removed: staleIds.length });
  } catch (err) {
    console.error('Google sync failed:', err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
