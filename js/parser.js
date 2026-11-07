/**
 * parser.js — natural-language quick-add parser (pure module, no DOM).
 *
 * Usage:  const r = parse('Email Dana tomorrow 9am #Work @email p1')
 *         // → { title: 'Email Dana', date: '2026-11-08', time: 540, ... }
 *
 * Design
 * ------
 * 1. `tokenize` runs an ordered list of MATCHERS (recurrence first, then
 *    durations, time ranges, dates, times, priority, #project, @label,
 *    &area, someday). Higher-priority matchers claim their character span
 *    first; lower-priority ones skip claimed spans, so "every friday" is a
 *    recurrence, not a date, and "from 2pm to 3pm" is a range, not two times.
 * 2. Everything not claimed becomes the TITLE (whitespace collapsed,
 *    dangling prepositions like a trailing "at" trimmed).
 * 3. `computeResult` folds the tokens into scalar values. Repeated kinds
 *    (two dates, etc.) use the LAST occurrence — the user's final intent.
 *    Tokens carry an `enabled` flag: the quick-add sheet renders each token
 *    as a chip and lets the user disable one to override the parse (the
 *    raw words still stay out of the title).
 *
 * Conventions (also documented in the README cheat sheet):
 *   - "12/06" is month/day by default (dayFirst option flips it).
 *   - "at 5" (no am/pm) means 5 PM; hours 7–11 default to AM, 13–23 are 24h.
 *   - A weekday means the next occurrence INCLUDING today.
 *   - "next friday" is Friday of next week (week starts per option).
 *   - Dates in the past roll to next year ("jun 12" in November → 2027).
 *   - Recurrence without an explicit date schedules the first occurrence
 *     from today (inclusive) using store.nextOccurrence.
 *
 * Run the self-check: open js/parser.test.html in a browser, or
 * `node js/parser.test.js` from a terminal.
 */

import { nextOccurrence } from './store.js';
import * as U from './utils.js';

/* Weekday / month vocabularies (English; \b-bounded so "sunburn" ≠ Sunday). */
const WD = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:day)?)';
const WDG = '(' + WD + ')'; // capturing variant for handlers that read the match
const WD_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MO = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MOG = '(' + MO + ')'; // capturing variant
const MO_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/* ------------------------------------------------------------------ *
 * Matcher registry
 * ------------------------------------------------------------------ */

const MATCHERS = [];
/**
 * addMatcher(kind, re, make, spanFn?)
 *   re    — global regex (g flag required)
 *   make  — (match, ctx) → token value, or null when the match is invalid
 *           (e.g. "feb 30") and must stay in the title
 *   spanFn— optional [start, end] override (for (^|\s)-prefixed patterns
 *           we don't want the leading space inside the chip)
 */
function addMatcher(kind, re, make, spanFn) {
  if (!re.global) throw new Error('matcher regex must be global: ' + re);
  MATCHERS.push({ kind, re, make, spanFn });
}
const afterSpace = (m) => [m.index + (m[1] ? m[1].length : 0), m.index + m[0].length];

function buildCtx(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  return {
    now,
    today: U.dateStr(now.getFullYear(), now.getMonth(), now.getDate()),
    minutes: now.getHours() * 60 + now.getMinutes(),
    weekStart: opts.weekStart ?? 1,
    dayFirst: !!opts.dayFirst,
  };
}

const nextWeekdayIncl = (ctx, wd) => {
  let d = ctx.today;
  for (let i = 0; i < 7 && U.weekdayOf(d) !== wd; i++) d = U.addDays(d, 1);
  return d;
};
const weekdayOfMatch = (m, groupIndex) => WD_IDX[m[groupIndex].slice(0, 3).toLowerCase()];

/* ------------------------------------------------------------------ *
 * Recurrence
 * ------------------------------------------------------------------ */

const fromCompletion = (m, i) => !!m[i] || /from\s+completion/i.test(m[0]);
const freqOf = (unit) => ({ day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year' }[unit.toLowerCase()]);

addMatcher('recurrence', /\bevery\s+other\s+day\b/gi, () => ({ freq: 'day', interval: 2 }));
addMatcher('recurrence', /\bevery\s+week\s*days?\b|\bevery\s+weekdays?\b/gi, () => ({ freq: 'week', interval: 1, byDay: [1, 2, 3, 4, 5] }));
addMatcher('recurrence', /\bevery\s+weekend\b/gi, () => ({ freq: 'week', interval: 1, byDay: [0, 6] }));
addMatcher('recurrence', new RegExp(`\\bevery\\s+(\\d+)(?:st|nd|rd|th)?\\s+${WDG}\\b`, 'gi'),
  (m) => { const n = +m[1]; return n >= 1 && n <= 5 ? { freq: 'month', interval: 1, nth: { n, d: weekdayOfMatch(m, 2) } } : null; });
addMatcher('recurrence', /\bevery\s+month\s+on\s+the\s+(\d+)(?:st|nd|rd|th)?\b/gi,
  (m) => { const d = +m[1]; return d >= 1 && d <= 31 ? { freq: 'month', interval: 1, byMonthDay: d } : null; });
addMatcher('recurrence', new RegExp(`\\bevery\\s+(\\d+)\\s+weeks?\\s+on\\s+${WDG}\\b`, 'gi'),
  (m) => ({ freq: 'week', interval: +m[1], byDay: [weekdayOfMatch(m, 2)] }));
addMatcher('recurrence', new RegExp(`\\bevery\\s+(?:week\\s+on\\s+)?${WDG}\\b(?:\\s*(?:,|and)\\s+${WDG}\\b)?(?:\\s*(?:,|and)\\s+${WDG}\\b)?`, 'gi'),
  (m) => {
    const days = [m[1], m[2], m[3]].filter(Boolean).map((s) => WD_IDX[s.slice(0, 3).toLowerCase()]);
    return { freq: 'week', interval: 1, byDay: [...new Set(days)] };
  });
addMatcher('recurrence', /\bevery\s+(\d+)\s+(day|week|month|year)s?\b(\s+from\s+completion)?/gi,
  (m) => ({ freq: freqOf(m[2]), interval: +m[1], fromCompletion: fromCompletion(m, 3) }));
addMatcher('recurrence', /\bevery\s+(day|week|month|year)\b(\s+from\s+completion)?/gi,
  (m) => ({ freq: freqOf(m[1]), interval: 1, fromCompletion: fromCompletion(m, 2) }));
addMatcher('recurrence', /\b(daily|weekly|monthly|yearly)\b/gi,
  (m) => ({ freq: { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[m[1].toLowerCase()], interval: 1 }));
addMatcher('recurrence', /\bafter\s+(\d+)\s+(day|week|month)s?(\s+from\s+completion)?\b/gi,
  (m) => ({ freq: freqOf(m[2]), interval: +m[1], fromCompletion: true }));

addMatcher('someday', /\bsome\s*day\b/gi, () => true);

/* ------------------------------------------------------------------ *
 * Duration ("for 1h30m", "for 90 minutes") and time ranges
 * ------------------------------------------------------------------ */

addMatcher('duration', /\bfor\s+(?:(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\s*)?/gi,
  (m) => {
    if (m[1] == null && m[2] == null) return null;
    const mins = Math.round((m[1] ? parseFloat(m[1]) * 60 : 0) + (m[2] ? parseFloat(m[2]) : 0));
    return mins > 0 && mins <= 24 * 60 ? mins : null;
  });

/** "from 2pm to 3pm", "2pm-3:30pm", "10 to 11am" → start + duration. */
addMatcher('time', /(from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi,
  (m) => {
    // Require an explicit signal so "team of 5-7" stays a title.
    if (!m[1] && !m[4] && !m[7] && m[3] == null && m[6] == null) return null;
    const resolve = (h, min, mer, inherit) => {
      const pm = (mer || inherit || '').toLowerCase() === 'pm';
      const am = (mer || inherit || '').toLowerCase() === 'am';
      if (pm) return (h % 12) + 12 + (min || 0) / 60; // 12pm → 12
      if (am) return (h % 12) + (min || 0) / 60;      // 12am → 0
      // No meridiem: afternoon-biased heuristic (1–6 → PM, 7–11 → AM).
      const hh = h >= 1 && h <= 6 ? h + 12 : h;
      return hh + (min || 0) / 60;
    };
    let start = resolve(+m[2], m[3] ? +m[3] : 0, m[4], null);
    let end = resolve(+m[5], m[6] ? +m[6] : 0, m[7], m[4] || m[7]);
    let dur = Math.round((end - start) * 60); // hours-fraction → minutes
    if (dur <= 0) {
      if (end + 12 - start <= 12) end += 12;       // "2 to 3" → PM both
      else end += 24;                              // overnight
      dur = Math.round((end - start) * 60);
    }
    const startMin = Math.round(start * 60);
    if (startMin < 0 || startMin >= 1440 || dur < 15 || dur > 16 * 60) return null;
    return { range: true, time: startMin, duration: dur };
  });

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

addMatcher('date', /\bin\s+(\d+)\s*(minutes?|mins?|min|hours?|hrs?|h|days?|weeks?|months?)\b/gi, (m, ctx) => {
  const n = +m[1];
  const unit = m[2].toLowerCase();
  if (/^h/.test(unit) || /^min/.test(unit)) {
    const total = ctx.minutes + n * (/^h/.test(unit) ? 60 : 1);
    return { date: U.addDays(ctx.today, Math.floor(total / 1440)), time: total % 1440 };
  }
  if (/^day/.test(unit)) return { date: U.addDays(ctx.today, n) };
  if (/^week/.test(unit)) return { date: U.addDays(ctx.today, n * 7) };
  return { date: U.addMonths(ctx.today, n) };
});
addMatcher('date', /\b(\d+)\s*(day|week|month)s?\s+from\s+now\b/gi, (m, ctx) => ({
  date: /day/i.test(m[2]) ? U.addDays(ctx.today, +m[1]) : /week/i.test(m[2]) ? U.addDays(ctx.today, +m[1] * 7) : U.addMonths(ctx.today, +m[1]),
}));
addMatcher('date', /\bnext\s+week\b/gi, (m, ctx) => ({ date: U.addDays(U.weekStartOf(ctx.today, ctx.weekStart), 7) }));
addMatcher('date', /\bnext\s+month\b/gi, (m, ctx) => ({ date: U.addMonths(ctx.today, 1) }));
addMatcher('date', new RegExp(`\\bnext\\s+${WDG}\\b`, 'gi'), (m, ctx) => {
  const nextWeekStart = U.addDays(U.weekStartOf(ctx.today, ctx.weekStart), 7);
  const wd = weekdayOfMatch(m, 1);
  return { date: U.addDays(nextWeekStart, (wd - ctx.weekStart + 7) % 7) };
});
addMatcher('date', /\bthis\s+weekend\b/gi, (m, ctx) => {
  const wd = U.weekdayOf(ctx.today);
  return { date: wd === 0 ? ctx.today : U.addDays(ctx.today, (6 - wd + 7) % 7) };
});
addMatcher('date', /\b(today|tonight|tomorrow|tmrw|tmr)\b/gi, (m, ctx) => {
  const w = m[1].toLowerCase();
  if (w === 'today') return { date: ctx.today };
  if (w === 'tonight') return { date: ctx.today, time: 20 * 60 };
  return { date: U.addDays(ctx.today, 1) };
});
addMatcher('date', new RegExp(`\\b${MOG}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'gi'), (m, ctx) => {
  const month = MO_IDX[m[1].slice(0, 3).toLowerCase()];
  return buildYMD(ctx, m[3] ? +m[3] : null, month, +m[2]);
});
addMatcher('date', new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MOG}\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'gi'), (m, ctx) => {
  const month = MO_IDX[m[2].slice(0, 3).toLowerCase()];
  return buildYMD(ctx, m[3] ? +m[3] : null, month, +m[1]);
});
addMatcher('date', /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m, ctx) => {
  let a = +m[1], b = +m[2];
  if (a > 12 && b > 12) return null;             // "31/41" — not a date
  const dayFirst = ctx.dayFirst || (a > 12 && b <= 12);
  let month = dayFirst ? b : a, day = dayFirst ? a : b;
  if (month > 12) return null;
  let year = m[3] ? +m[3] : null;
  if (year != null && year < 100) year += 2000;
  return buildYMD(ctx, year, month - 1, day);
});
addMatcher('date', new RegExp(`\\b(?:on\\s+)?${WDG}\\b`, 'gi'), (m, ctx) => ({ date: nextWeekdayIncl(ctx, weekdayOfMatch(m, 1)) }));

function buildYMD(ctx, year, month, day) {
  if (day < 1 || day > 31 || month == null || month < 0 || month > 11) return null;
  const y0 = year ?? Number(ctx.today.slice(0, 4));
  const last = U.daysInMonth(y0, month);
  if (day > last) return null; // "feb 30" is not a date — leave it in the title
  let y = y0;
  let d = U.dateStr(y, month, day);
  if (year == null && d < ctx.today) {
    // Past date with no year → next year (Todoist behaviour).
    d = U.dateStr(y + 1, month, day);
  }
  return { date: d };
}

/* ------------------------------------------------------------------ *
 * Times
 * ------------------------------------------------------------------ */

addMatcher('time', /(?:^|\s)(?:at\s+)?(\d{1,2}):(\d{2})\b/g, (m) => {
  const h = +m[1], min = +m[2];
  return h <= 23 && min <= 59 ? h * 60 + min : null;
});
addMatcher('time', /(?:^|\s)(?:at\s+)?(\d{1,2})\s*(am|pm)\b/gi, (m) => {
  const h = +m[1];
  if (h < 1 || h > 12) return null;
  return (m[2].toLowerCase() === 'pm' ? (h % 12) + 12 : h % 12) * 60;
});
addMatcher('time', /(?:^|\s)at\s+(\d{1,2})\b/g, (m) => {
  const h = +m[1];
  if (h >= 1 && h <= 6) return (h + 12) * 60; // "at 5" → 5 PM
  if (h >= 7 && h <= 23) return h * 60;       // "at 9" → 9 AM, "at 17" → 17:00
  return null;
});
addMatcher('time', /(?:^|\s)(?:at|in\s+the)\s+(noon|midnight|morning|afternoon|evening)\b/gi,
  (m) => ({ noon: 720, midnight: 0, morning: 9 * 60, afternoon: 14 * 60, evening: 18 * 60 }[m[1].toLowerCase()]));

/* ------------------------------------------------------------------ *
 * Priority / project / label / area
 * ------------------------------------------------------------------ */

addMatcher('priority', /\bp([1-4])\b/gi, (m) => +m[1]);
addMatcher('priority', /(^|\s)(!{1,3})(?=\s|$)/g, (m) => 4 - m[2].length, afterSpace);

addMatcher('project', /#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (m) => m[1]);
addMatcher('label', /(^|\s)@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (m) => m[2], afterSpace);
addMatcher('area', /(^|\s)&([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (m) => m[2], afterSpace);

/* ------------------------------------------------------------------ *
 * tokenize / computeResult / parse
 * ------------------------------------------------------------------ */

export function tokenize(input, opts = {}) {
  const ctx = buildCtx(opts);
  const text = String(input ?? '');
  const claimed = [];
  const tokens = [];
  const overlaps = (s, e) => claimed.some(([cs, ce]) => s < ce && e > cs);

  for (const matcher of MATCHERS) {
    matcher.re.lastIndex = 0;
    let m;
    while ((m = matcher.re.exec(text))) {
      const [s, e] = matcher.spanFn ? matcher.spanFn(m) : [m.index, m.index + m[0].length];
      if (overlaps(s, e)) continue;
      const value = matcher.make(m, ctx);
      if (value === null || value === undefined) continue;
      tokens.push({ kind: matcher.kind, raw: text.slice(s, e), start: s, end: e, value, enabled: true });
      claimed.push([s, e]);
    }
  }
  tokens.sort((a, b) => a.start - b.start);
  return { input: text, tokens, title: cleanTitle(text, tokens), ctx };
}

/** Title = everything unclaimed, tidied up. */
function cleanTitle(text, tokens) {
  let out = '';
  let pos = 0;
  for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
    out += text.slice(pos, t.start);
    pos = t.end;
  }
  out += text.slice(pos);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/(?:^(?:on|at|in|from|to|for|by|every|and|the)\s+)+/i, '')
    .replace(/\s+(?:on|at|in|from|to|for|by|every|and)$/i, '')
    .replace(/^[\s,.:;-]+|[\s,:;-]+$/g, '')
    .trim();
}

/**
 * Fold tokens into the final values. `tokens` may be a filtered/toggled
 * copy from the quick-add sheet (chips the user disabled are removed).
 */
export function computeResult(tokens, ctx) {
  let date = null, time = null, duration = null, priority = null;
  let projectName = null, areaName = null, recurrence = null, someday = false;
  const labels = [];

  for (const t of tokens) {
    if (t.enabled === false) continue;
    switch (t.kind) {
      case 'date':
        if (t.value.date) date = t.value.date;
        if (t.value.time != null) time = t.value.time;
        break;
      case 'time':
        if (t.value && typeof t.value === 'object') { // range token
          time = t.value.time;
          duration = t.value.duration;
        } else {
          time = t.value;
        }
        break;
      case 'duration': duration = t.value; break;
      case 'priority': priority = t.value; break;
      case 'project': projectName = t.value; break;
      case 'label': labels.push(t.value); break;
      case 'area': areaName = t.value; break;
      case 'recurrence': recurrence = { ...t.value }; break;
      case 'someday': someday = true; break;
    }
  }

  if (recurrence) {
    recurrence.anchor = date || ctx.today;
    if (!date) {
      // First occurrence: find the first matching day as if the interval
      // were 1 ("every 2 weeks on fri" starts on the NEXT Friday), then
      // anchor the interval there so subsequent occurrences step by N.
      const first = nextOccurrence({ ...recurrence, interval: 1 }, ctx.today, true);
      if (first) { recurrence.anchor = first; date = first; }
    }
  }
  if (time != null && !date) date = ctx.today;

  return { date, time, duration, priority, projectName, areaName, labels, recurrence, someday };
}

/** parse(input, opts) → { title, tokens, ...values }. */
export function parse(input, opts = {}) {
  const { tokens, title, ctx } = tokenize(input, opts);
  return { title, tokens, ctx, ...computeResult(tokens, ctx) };
}
