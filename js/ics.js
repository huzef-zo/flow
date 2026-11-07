/**
 * ics.js — minimal iCalendar (RFC 5545) import/export.
 *
 * Import: parses VEVENT blocks (SUMMARY, DTSTART, DTEND/DURATION, RRULE,
 * UID, LOCATION), expands simple recurrence rules (DAILY/WEEKLY/MONTHLY/
 * YEARLY with INTERVAL, COUNT, UNTIL, BYDAY) for the next year (max 500
 * occurrences per event), and produces `event` blocks for the timeline.
 * TZID parameters are IGNORED (times are treated as local floating) —
 * documented limitation in the README.
 *
 * Export: writes tasks (scheduled or with a due date) and imported events
 * as VEVENTs; timed tasks become floating datetimes, day tasks become
 * all-day events.
 */

import * as U from './utils.js';

const WK = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

/** Unfold folded lines (continuations start with space/tab). */
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseIcsDate(value, params = '') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, zulu] = m;
  if (params.includes('VALUE=DATE') || !hh) return { date: `${y}-${mo}-${d}`, time: null, allDay: true };
  let date = `${y}-${mo}-${d}`;
  let time = (+hh) * 60 + (+mi);
  if (zulu) { // UTC → local
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)));
    date = U.dateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
    time = dt.getHours() * 60 + dt.getMinutes();
  }
  return { date, time, allDay: false };
}

function parseDuration(str) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(str || '');
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+(m[2] || 0)) * 7 * 1440 + (+(m[3] || 0)) * 1440 + (+(m[4] || 0)) * 60 + (+(m[5] || 0)));
}

/**
 * parseICS(text) → { events: [{uid, title, date, time, dur, allDay,
 * location, rrule}], warnings: [...] }
 */
export function parseICS(text) {
  const lines = unfold(text);
  const events = [];
  const warnings = [];
  let cur = null;
  let inVEvent = false;

  const pushEvent = () => {
    if (cur && cur.dtstart) {
      if (!cur.title) cur.title = '(untitled event)';
      events.push(cur);
    }
    cur = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^BEGIN:VEVENT$/i.test(trimmed)) { inVEvent = true; cur = { uid: null, title: null, location: null, dtstart: null, dtend: null, duration: null, rrule: null }; continue; }
    if (/^END:VEVENT$/i.test(trimmed)) { inVEvent = false; pushEvent(); continue; }
    if (!inVEvent || !cur) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const left = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1);
    const name = left.split(';')[0].toUpperCase();
    const params = left.slice(left.indexOf(';') + 1) || '';
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DTSTART': cur.dtstart = parseIcsDate(value, params.toUpperCase()); break;
      case 'DTEND': cur.dtend = parseIcsDate(value, params.toUpperCase()); break;
      case 'DURATION': cur.duration = parseDuration(value); break;
      case 'RRULE': cur.rrule = parseRRULE(value); break;
      default: break;
    }
  }

  // Derive duration + expand recurrence into concrete occurrences.
  const expanded = [];
  const horizon = U.addDays(U.todayStr(), 400);
  for (const ev of events) {
    const dur = ev.duration ?? (ev.dtend && ev.dtstart
      ? (ev.dtend.allDay
        ? Math.max(1, U.diffDays(ev.dtstart.date, ev.dtend.date)) * 1440
        : (ev.dtend.time - ev.dtstart.time + 1440) % 1440 || 1440)
      : 60);
    const dates = ev.rrule
      ? expandRRule(ev.rrule, ev.dtstart.date, horizon, warnings)
      : [ev.dtstart.date];
    if (dates.length > 1 && ev.dtstart.allDay === false && ev.dtstart.time == null) {
      // all-day recurring
    }
    for (const date of dates) {
      expanded.push({
        uid: ev.uid ? `${ev.uid}` : null,
        title: ev.title,
        date,
        time: ev.dtstart.allDay ? null : ev.dtstart.time,
        dur: Math.max(15, dur),
        allDay: ev.dtstart.allDay,
        location: ev.location,
      });
    }
    if (expanded.length > 2000) { warnings.push('Import truncated at 2000 occurrences.'); break; }
  }
  return { events: expanded, warnings };
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseRRULE(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    const key = k.toUpperCase();
    if (key === 'BYDAY') rule.byDay = v.split(',').map((d) => WK[d.trim().toUpperCase()]).filter((d) => d != null);
    else if (key === 'INTERVAL' || key === 'COUNT') rule[key.toLowerCase()] = +v;
    else if (key === 'UNTIL') rule.until = parseIcsDate(v)?.date ?? null;
    else rule[key.toLowerCase()] = v.toUpperCase();
  }
  return rule;
}

/** Expand FREQ/INTERVAL/COUNT/UNTIL/BYDAY into concrete dates. */
function expandRRule(rule, start, horizon, warnings) {
  const out = [];
  const interval = Math.max(1, rule.interval || 1);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) {
    warnings.push(`Unsupported RRULE FREQ=${rule.freq} — imported first occurrence only.`);
    return [start];
  }
  if (rule.count != null && rule.count > 400) warnings.push(`RRULE COUNT capped at 400 (was ${rule.count}).`);
  const maxCount = Math.min(rule.count ?? 400, 400);
  let d = start;
  for (let i = 0; i < 2000; i++) {
    let matches = true;
    if (d !== start) {
      const diff = U.diffDays(start, d);
      switch (rule.freq) {
        case 'DAILY': matches = diff % interval === 0; break;
        case 'WEEKLY': {
          const weeks = Math.floor(Math.floor(diff + ((U.weekdayOf(start) + 1) % 7)) / 7); // approx weeks elapsed
          matches = (rule.byDay ? rule.byDay.includes(U.weekdayOf(d)) : U.weekdayOf(d) === U.weekdayOf(start)) && weeks % interval === 0;
          break;
        }
        case 'MONTHLY': {
          const months = (Number(d.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + (Number(d.slice(5, 7)) - Number(start.slice(5, 7)));
          matches = months % interval === 0 && Number(d.slice(8, 10)) === Number(start.slice(8, 10));
          break;
        }
        case 'YEARLY': matches = d.slice(5) === start.slice(5) && (Number(d.slice(0, 4)) - Number(start.slice(0, 4))) % interval === 0; break;
      }
    }
    if (matches) {
      out.push(d);
      if (out.length >= maxCount) break;
      if (d >= horizon) break;
    }
    if (d >= horizon) break;
    d = U.addDays(d, 1);
  }
  if (rule.until && out.length) {
    return out.filter((x) => x <= rule.until);
  }
  return out.length ? out : [start];
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
function icsDate(date, time) {
  const [y, m, d] = date.split('-');
  if (time == null) return `${y}${m}${d}`;
  return `${y}${m}${d}T${pad(Math.floor(time / 60))}${pad(time % 60)}00`;
}
function icsEndDate(date, time, dur) {
  const [y, m, d] = date.split('-');
  const end = (time ?? 0) + (dur || 60);
  const dayShift = Math.floor(end / 1440);
  const shifted = U.addDays(date, dayShift);
  const [y2, m2, d2] = shifted.split('-');
  if (time == null) return `${y2}${m2}${d2}`;
  const t = ((end % 1440) + 1440) % 1440;
  return `${y2}${m2}${d2}T${pad(Math.floor(t / 60))}${pad(t % 60)}00`;
}
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const fold = (line) => {
  // RFC 5545 §3.1: lines longer than 75 octets fold with CRLF + space.
  const out = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ' ' + rest.slice(73);
  }
  out.push(rest);
  return out.join('\r\n');
};

/**
 * toICS(records) — records: [{title, date, time, dur, allDay, description}]
 * → full VCALENDAR text.
 */
export function toICS(records) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flow//Tasks//EN', 'CALSCALE:GREGORIAN'];
  let n = 0;
  for (const r of records) {
    if (!r.date) continue;
    n += 1;
    lines.push(fold('BEGIN:VEVENT'));
    lines.push(`UID:flow-${n}-${Date.now()}@flow.local`);
    lines.push(`DTSTAMP:${icsDate(U.todayStr(), U.nowMinutes())}`);
    if (r.allDay || r.time == null) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(r.date, null)}`);
      lines.push(`DTEND;VALUE=DATE:${icsEndDate(r.date, null, r.dur || 1440)}`);
    } else {
      lines.push(`DTSTART:${icsDate(r.date, r.time)}`);
      lines.push(`DTEND:${icsEndDate(r.date, r.time, r.dur)}`);
    }
    lines.push(fold(`SUMMARY:${esc(r.title)}`));
    if (r.description) lines.push(fold(`DESCRIPTION:${esc(r.description)}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
