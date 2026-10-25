import ical from 'node-ical';
import type { VEvent } from 'node-ical';

export interface NormalizedEvent {
  external_id: string;
  title: string;
  start_at: string; // ISO timestamp
  end_at: string; // ISO timestamp
  all_day: boolean;
  location: string | null;
}

// node-ical returns some text fields as either a plain string or an object
// like { val: 'text', params: {...} } — this flattens both to a string.
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'val' in value) {
    return String((value as { val: unknown }).val ?? '');
  }
  return '';
}

// All-day events carry no time or timezone, just a calendar date. node-ical
// builds the Date at *server-local* midnight, so the only reading that is
// correct on any server timezone is the local getters. We then re-encode the
// date as UTC midnight, so the browser can read the same Y/M/D back with the
// UTC getters regardless of where it is.
function allDayAsUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * Parses ICS text and returns every event occurrence that overlaps
 * [from, to], with recurring events expanded into individual occurrences
 * (honoring EXDATE exclusions and moved/edited single occurrences).
 */
export function expandIcsEvents(icsText: string, from: Date, to: Date): NormalizedEvent[] {
  const parsed = ical.sync.parseICS(icsText);
  const results = new Map<string, NormalizedEvent>();

  for (const component of Object.values(parsed)) {
    if (!component || component.type !== 'VEVENT') continue;
    const event = component as VEvent;
    if (!event.start) continue;

    const instances = ical.expandRecurringEvent(event, {
      from,
      to,
      includeOverrides: true,
      excludeExdates: true,
      expandOngoing: true,
    });

    for (const instance of instances) {
      // Cancelled events (or cancelled single occurrences) still appear in
      // the feed with STATUS:CANCELLED — skip them.
      if (instance.event.status === 'CANCELLED') continue;

      const isFullDay = instance.isFullDay;
      const start = isFullDay ? allDayAsUtcMidnight(instance.start) : instance.start;
      // A missing DTEND means zero-length (timed) or one day (all-day).
      const rawEnd = instance.end ?? instance.start;
      let end = isFullDay ? allDayAsUtcMidnight(rawEnd) : rawEnd;
      if (isFullDay && end.getTime() <= start.getTime()) {
        end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      }

      // The occurrence's own start time is part of its identity: a weekly
      // event shares one UID across all of its occurrences.
      const externalId = `${event.uid}|${start.toISOString()}`;

      results.set(externalId, {
        external_id: externalId,
        title: text(instance.summary).trim() || 'Untitled event',
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        all_day: isFullDay,
        location: text(event.location).trim() || null,
      });
    }
  }

  return Array.from(results.values()).sort((a, b) => a.start_at.localeCompare(b.start_at));
}
