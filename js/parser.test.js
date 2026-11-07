/**
 * parser.test.js — self-check suite for the quick-add parser.
 *
 * Run in a browser:  open js/parser.test.html (via any static server)
 * Run in a terminal: node js/parser.test.js
 *
 * Every case runs against a FIXED "now" (Sat 2026-11-07 09:00 local) and
 * weekStart=Monday, so results are deterministic. Add cases freely —
 * each is { input, expect } where expect lists only the fields you care
 * about. `expect.recurrence` is a partial deep-match.
 */

import { parse, tokenize, computeResult } from './parser.js';

const NOW = new Date(2026, 10, 7, 9, 0); // Saturday, Nov 7 2026, 09:00
const OPTS = { now: NOW, weekStart: 1 };

const CASES = [
  // --- plain titles ---
  { input: 'Buy milk', expect: { title: 'Buy milk', date: null, time: null, priority: null } },
  { input: 'Call Tom about the garden', expect: { title: 'Call Tom about the garden' } },
  { input: 'Team of 5-7 people', expect: { title: 'Team of 5-7 people', time: null } },
  { input: 'Midnight snack run', expect: { title: 'Midnight snack run', time: null } },
  { input: 'May I ask a favor', expect: { title: 'May I ask a favor' } },
  { input: 'Sunburn shopping', expect: { title: 'Sunburn shopping' } },

  // --- dates ---
  { input: 'Buy milk today', expect: { title: 'Buy milk', date: '2026-11-07' } },
  { input: 'Buy milk today', expect: { date: '2026-11-07' } },
  { input: 'Buy milk tomorrow', expect: { title: 'Buy milk', date: '2026-11-08' } },
  { input: 'Ship the demo tmr', expect: { title: 'Ship the demo', date: '2026-11-08' } },
  { input: 'Call mom tonight', expect: { title: 'Call mom', date: '2026-11-07', time: 1200 } },
  { input: 'Call mom next friday', expect: { title: 'Call mom', date: '2026-11-13' } },
  { input: 'Sprint retro next monday', expect: { title: 'Sprint retro', date: '2026-11-09' } },
  { input: 'Planning next week', expect: { title: 'Planning', date: '2026-11-09' } },
  { input: 'Budget review next month', expect: { title: 'Budget review', date: '2026-12-07' } },
  { input: 'Brunch this weekend', expect: { title: 'Brunch', date: '2026-11-07' } },
  { input: 'Ship demo in 3 days', expect: { title: 'Ship demo', date: '2026-11-10' } },
  { input: 'Review design in 2 weeks', expect: { title: 'Review design', date: '2026-11-21' } },
  { input: 'Check lease in 1 month', expect: { title: 'Check lease', date: '2026-12-07' } },
  { input: 'Call back in 90 minutes', expect: { title: 'Call back', date: '2026-11-07', time: 630 } },
  { input: 'Leave in 5 hours', expect: { title: 'Leave', date: '2026-11-07', time: 840 } },
  { input: 'Audit 3 weeks from now', expect: { title: 'Audit', date: '2026-11-28' } },
  { input: 'Dentist jun 12', expect: { title: 'Dentist', date: '2027-06-12' } },
  { input: 'Dentist dec 1', expect: { title: 'Dentist', date: '2026-12-01' } },
  { input: 'Taxes 15 jun 2027', expect: { title: 'Taxes', date: '2027-06-15' } },
  { input: 'Party 12/06', expect: { title: 'Party', date: '2026-12-06' } },
  { input: 'File taxes 5/17/2027', expect: { title: 'File taxes', date: '2027-05-17' } },
  { input: 'Lunch on friday', expect: { title: 'Lunch', date: '2026-11-13' } },
  { input: 'Gym wed', expect: { title: 'Gym', date: '2026-11-11' } },
  { input: 'Board meeting on the 15th', expect: { title: 'Board meeting on the 15th', date: null } },

  // --- times ---
  { input: 'Call mom at 5pm', expect: { title: 'Call mom', time: 1020 } },
  { input: 'Call mom at 5 pm', expect: { title: 'Call mom', time: 1020 } },
  { input: 'Call mom 17:30', expect: { title: 'Call mom', time: 1050 } },
  { input: 'Call mom at 9am', expect: { title: 'Call mom', time: 540 } },
  { input: 'Call mom at 5', expect: { title: 'Call mom', time: 1020 } },
  { input: 'Standup at 9', expect: { title: 'Standup', time: 540 } },
  { input: 'Lunch at noon', expect: { title: 'Lunch', time: 720 } },
  { input: 'Bed at midnight', expect: { title: 'Bed', time: 0 } },
  { input: 'Jog in the morning', expect: { title: 'Jog', time: 540 } },
  { input: 'Dinner tomorrow 6pm', expect: { title: 'Dinner', date: '2026-11-08', time: 1080 } },

  // --- durations & ranges ---
  { input: 'Read for 45m', expect: { title: 'Read', duration: 45 } },
  { input: 'Deep work for 1h30m', expect: { title: 'Deep work', duration: 90 } },
  { input: 'Nap for 2 hours', expect: { title: 'Nap', duration: 120 } },
  { input: 'Meeting from 2pm to 3pm', expect: { title: 'Meeting', time: 840, duration: 60 } },
  { input: 'Workout 2pm - 3:30pm', expect: { title: 'Workout', time: 840, duration: 90 } },
  { input: 'Focus 10 to 11am', expect: { title: 'Focus', time: 600, duration: 60 } },
  { input: 'Meeting from 14:00 to 15:30', expect: { title: 'Meeting', time: 840, duration: 90 } },

  // --- priority ---
  { input: 'Fix login bug p1', expect: { title: 'Fix login bug', priority: 1 } },
  { input: 'Fix login bug P4', expect: { title: 'Fix login bug', priority: 4 } },
  { input: 'Fix login bug !!!', expect: { title: 'Fix login bug', priority: 1 } },
  { input: 'Fix login bug !!', expect: { title: 'Fix login bug', priority: 2 } },
  { input: 'Fix login bug !', expect: { title: 'Fix login bug', priority: 3 } },
  { input: 'Wow!!!', expect: { title: 'Wow!!!', priority: null } },

  // --- project / label / area / someday ---
  { input: 'Email Dana #Work', expect: { title: 'Email Dana', projectName: 'Work' } },
  { input: 'Redesign #Website', expect: { title: 'Redesign', projectName: 'Website' } },
  { input: 'Email Dana @email @urgent', expect: { title: 'Email Dana', labels: ['email', 'urgent'] } },
  { input: 'Write to me@example.com', expect: { title: 'Write to me@example.com', labels: [] } },
  { input: 'Plan trip &Personal', expect: { title: 'Plan trip', areaName: 'Personal' } },
  { input: 'Learn piano someday', expect: { title: 'Learn piano', someday: true } },

  // --- recurrence ---
  { input: 'Water plants every day', expect: { title: 'Water plants', date: '2026-11-07', recurrence: { freq: 'day', interval: 1 } } },
  { input: 'Water plants every other day', expect: { recurrence: { freq: 'day', interval: 2 }, date: '2026-11-07' } },
  { input: 'Standup every weekday', expect: { recurrence: { freq: 'week', byDay: [1, 2, 3, 4, 5] }, date: '2026-11-09' } },
  { input: 'Rest every weekend', expect: { recurrence: { freq: 'week', byDay: [0, 6] }, date: '2026-11-07' } },
  { input: 'Report every 2 weeks', expect: { recurrence: { freq: 'week', interval: 2 }, date: '2026-11-07' } },
  { input: 'Report every 2 weeks on fri', expect: { recurrence: { freq: 'week', interval: 2, byDay: [5] }, date: '2026-11-13' } },
  { input: 'Board meeting every 3rd wednesday', expect: { recurrence: { freq: 'month', nth: { n: 3, d: 3 } }, date: '2026-11-18' } },
  { input: 'Invoice every month on the 15th', expect: { recurrence: { freq: 'month', byMonthDay: 15 }, date: '2026-11-15' } },
  { input: 'Backup after 2 days from completion', expect: { recurrence: { freq: 'day', interval: 2, fromCompletion: true }, date: '2026-11-07' } },
  { input: 'Meditate daily', expect: { recurrence: { freq: 'day', interval: 1 }, date: '2026-11-07' } },
  { input: 'Sync weekly', expect: { recurrence: { freq: 'week', interval: 1 } } },
  { input: 'Review every friday', expect: { recurrence: { freq: 'week', byDay: [5] }, date: '2026-11-13' } },
  { input: 'Run every monday and wednesday', expect: { recurrence: { freq: 'week', byDay: [1, 3] } } },
  { input: 'Audit every 3 months', expect: { recurrence: { freq: 'month', interval: 3 } } },

  // --- combined ---
  { input: 'Email Dana tomorrow 9am #Work @email p1', expect: { title: 'Email Dana', date: '2026-11-08', time: 540, projectName: 'Work', labels: ['email'], priority: 1 } },
  { input: 'Call mom sun 5pm p2', expect: { title: 'Call mom', date: '2026-11-08', time: 1020, priority: 2 } },
  { input: 'BUY MILK TOMORROW', expect: { title: 'BUY MILK', date: '2026-11-08' } },
  { input: 'Standup every weekday at 9:30', expect: { title: 'Standup', recurrence: { freq: 'week', byDay: [1, 2, 3, 4, 5] }, time: 570, date: '2026-11-09' } },
  { input: 'Deep work tomorrow from 2pm to 3:30pm p1 #Focus', expect: { title: 'Deep work', date: '2026-11-08', time: 840, duration: 90, priority: 1, projectName: 'Focus' } },

  // --- only tokens, empty title (caller must reject) ---
  { input: 'tomorrow', expect: { title: '' } },
  { input: '#Work p1', expect: { title: '' } },
];

/* ---------------- runner ---------------- */

function deepIncludes(actual, expected) {
  if (actual === expected) return true;
  if (typeof expected !== typeof actual || expected === null || typeof expected !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((v, i) => deepIncludes(actual[i], v));
  }
  return Object.keys(expected).every((k) => deepIncludes(actual?.[k], expected[k]));
}

export function runTests() {
  const results = [];
  for (const c of CASES) {
    const r = parse(c.input, OPTS);
    const issues = [];
    for (const [key, want] of Object.entries(c.expect)) {
      const got = r[key];
      const ok = deepIncludes(got, want);
      if (!ok) issues.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    results.push({ input: c.input, ok: issues.length === 0, issues, result: r });
  }
  const failed = results.filter((r) => !r.ok);
  return { total: results.length, passed: results.length - failed.length, failed: results.filter((r) => !r.ok), results };
}

/* Extra behavioural checks that need tokenize/computeResult directly. */
export function runBehaviourTests() {
  const checks = [];
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }); }
    catch (e) { checks.push({ name, ok: false, issues: [e.message] }); }
  };
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  check('disabling a chip removes its value but keeps words out of the title', () => {
    const { tokens, title, ctx } = tokenize('Call mom tomorrow 5pm', OPTS);
    const dateTok = tokens.find((t) => t.kind === 'date');
    dateTok.enabled = false;
    const res = computeResult(tokens, ctx);
    // Design decision: a time without a date means TODAY ("at 5pm" rule),
    // so disabling the date chip degrades to today-at-5 — visible in the
    // sheet's live preview, never a silent surprise.
    eq(res.date, '2026-11-07', 'time without date falls back to today');
    eq(res.time, 1020, 'time survives');
    eq(title, 'Call mom', 'title strips matched words either way');
  });

  check('tokens are non-overlapping and ordered', () => {
    const { tokens } = tokenize('Email Dana tomorrow 9am #Work @email p1', OPTS);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i - 1].end > tokens[i].start) throw new Error('overlapping tokens');
    }
    eq(tokens.length, 5, 'token count');
  });

  check('dayFirst option flips numeric dates', () => {
    const r = parse('Party 06/12', { ...OPTS, dayFirst: true });
    eq(r.date, '2026-12-06', 'dayFirst');
  });

  check('past explicit-year dates do not roll forward', () => {
    const r = parse('Trip jan 5 2020', OPTS);
    eq(r.date, '2020-01-05', 'explicit year is respected');
  });

  check('invalid dates stay in the title', () => {
    const r = parse('Meet feb 30', OPTS);
    eq(r.title, 'Meet feb 30', 'invalid date remains');
  });

  const failed = checks.filter((c) => !c.ok);
  return { total: checks.length, passed: checks.length - failed.length, failed: checks, results: checks };
}

/* CLI mode */
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const a = runTests();
  const b = runBehaviourTests();
  for (const r of [...a.results, ...b.results]) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.input || r.name}${r.issues?.length ? '\n      ' + r.issues.join('\n      ') : ''}`);
  }
  console.log(`\n${a.passed + b.passed}/${a.total + b.total} passed`);
  process.exitCode = a.passed + b.passed === a.total + b.total ? 0 : 1;
}
