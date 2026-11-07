/**
 * utils.js — shared, dependency-free utilities.
 * Pure functions only (no DOM, no storage) so this module can also run in Node
 * for the parser self-tests. Everything date-related works on LOCAL wall-clock
 * strings ('YYYY-MM-DD', minutes-from-midnight) instead of UTC epochs:
 * that keeps user-visible dates stable across timezone changes and DST jumps
 * (a due date of Nov 8 is Nov 8 wherever you fly).
 */

/* ------------------------------------------------------------------ *
 * IDs
 * ------------------------------------------------------------------ */

/**
 * UUID v7 — time-ordered (48-bit millisecond timestamp prefix + random).
 * Time-ordered ids keep IndexedDB records roughly sorted by creation time,
 * which makes cursor pagination and debugging pleasant. Falls back to a
 * random v4-shaped value if crypto.getRandomValues is unavailable.
 */
export function uuidv7() {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  const rnd = new Uint8Array(10);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(rnd);
  } else {
    for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.random() * 256) | 0;
  }
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(ts / 2 ** 32)); // high 32 bits of the 48-bit ts
  view.setUint16(4, ts & 0xffff);              // low 16 bits
  bytes.set(rnd, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Short random id (device ids, op suffixes). */
export function shortId(n = 8) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[(Math.random() * abc.length) | 0];
  return s;
}

/* ------------------------------------------------------------------ *
 * Fractional indexing (manual ordering without list rewrites)
 * ------------------------------------------------------------------ */

/**
 * Order keys are strings compared with plain `<` (code-unit order over the
 * base62 alphabet below). Structure: <head><fraction>
 *   - head: 'a'..'z' + N base62 digits (N = position of the letter, so 'a'→1
 *     digit, 'b'→2 …). Heads are the "integers"; a fraction tail refines.
 *   - fractions never end in '0' (we append 'V' instead) so the pathological
 *     pair (x, x+"0") — between which no key exists — can never be produced.
 *
 * between(a, b) returns a key strictly between two keys (or beside a single
 * key / inside an empty space), so inserting an item between two neighbours
 * touches ONLY the new item. Reordering one row therefore writes one record.
 *
 * This is a compact re-derivation of the technique described by Figma's
 * "Realtime Editing of Ordered Sequences" and the `fractional-indexing`
 * reference implementation.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO_KEY = 'a0';
const LOWER_A = DIGITS.indexOf('a'); // index of the first head letter ('a') in DIGITS

function dord(c) { return DIGITS.indexOf(c); }
function dchr(i) { return DIGITS[i]; }

/** Key strictly between a < b. */
function midpoint(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length) {
    // a is a proper prefix of b: lower b's last non-'0' char and trim zeros.
    let j = b.length - 1;
    while (j >= 0 && b[j] === '0') j--;
    if (j < i) return a + 'V'; // b === a + "0"*k (dead end) — extend instead
    let m = b.slice(0, j) + dchr(dord(b[j]) - 1);
    if (m <= a) return a + 'V'; // safety net; should not happen
    return m.endsWith('0') ? m + 'V' : m;
  }
  const ca = dord(a[i]);
  const cb = dord(b[i]);
  if (cb - ca >= 2) return a.slice(0, i) + dchr(ca + 1);
  // Adjacent chars — no room at this position; extend a. (Linear growth only
  // under adversarial repeated inserts at the exact same slot; fine here.)
  return a + 'V';
}

/** Smallest key greater than a. */
function increment(a) {
  const k = dord(a[0]) - LOWER_A + 1; // digit count implied by head letter (a→1, b→2 …)
  const head = a.length >= 1 + k ? a.slice(0, 1 + k) : a[0] + '0'.repeat(k);
  const digits = head.slice(1).split('');
  let i = k - 1;
  while (i >= 0 && digits[i] === 'z') { digits[i] = '0'; i--; }
  if (i < 0) { // carry past all digits → next head letter
    if (a[0] === 'z') return a + 'V'; // ceiling fallback (never hit in practice)
    return String.fromCharCode(a.charCodeAt(0) + 1) + '0'.repeat(k + 1);
  }
  digits[i] = dchr(dord(digits[i]) + 1);
  return head[0] + digits.join('');
}

export const FI = {
  /** Key between a and b (either may be null = unbounded on that side). */
  between(a, b) {
    if (a != null && b != null) {
      if (!(a < b)) throw new Error(`FI.between: expected "${a}" < "${b}"`);
      return midpoint(a, b);
    }
    if (a == null && b == null) return ZERO_KEY;
    if (a == null) { // before b
      if (b > ZERO_KEY) return ZERO_KEY;
      return null; // b === 'a0' → caller must bump b (see store.insertFirst)
    }
    return increment(a); // after a
  },
  /** n keys between a and b (for seeding / rebalancing). */
  nBetween(a, b, n) {
    const out = [];
    let prev = a;
    for (let i = 0; i < n; i++) {
      const k = FI.between(prev, b);
      out.push(k);
      prev = k;
    }
    return out;
  },
  cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; },
};

/* ------------------------------------------------------------------ *
 * Dates (local wall-clock strings)
 * ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

export function dateStr(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; } // m 0-based
export function toDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function todayStr() {
  const n = new Date();
  return dateStr(n.getFullYear(), n.getMonth(), n.getDate());
}
/** 'YYYY-MM-DD' from a millisecond timestamp (local time). */
export function dateStrFromMs(ms) {
  const n = new Date(ms);
  return dateStr(n.getFullYear(), n.getMonth(), n.getDate());
}
export function addDays(s, n) {
  const d = toDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d.getFullYear(), d.getMonth(), d.getDate());
}
/** Add months, clamping the day to the target month's length (Jan 31 → Feb 28/29). */
export function addMonths(s, n) {
  const d = toDate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return dateStr(d.getFullYear(), d.getMonth(), d.getDate());
}
export function diffDays(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000); }
export function weekdayOf(s) { return toDate(s).getDay(); } // 0=Sun
export function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
/** Start of the week containing s, per weekStart (0=Sun, 1=Mon). */
export function weekStartOf(s, weekStart = 1) {
  const wd = weekdayOf(s);
  const back = (wd - weekStart + 7) % 7;
  return addDays(s, -back);
}
/** Monday-based absolute week index (for recurrence interval math). */
export function weekIndex(s) { return Math.floor(diffDays('1970-01-05', s) / 7); }

const dtCache = {};
function fmt(localeOpts, opts) {
  const key = JSON.stringify([localeOpts, opts]);
  if (!dtCache[key]) dtCache[key] = new Intl.DateTimeFormat(undefined, opts);
  return dtCache[key];
}

/** 'Sat' / short weekday name in the user's locale. */
export function weekdayShort(s) { return fmt(null, { weekday: 'short' }).format(toDate(s)); }
export function weekdayLong(s) { return fmt(null, { weekday: 'long' }).format(toDate(s)); }
export function monthShort(s) { return fmt(null, { month: 'short' }).format(toDate(s)); }
/** 'Nov 7' style. */
export function fmtDate(s) { return fmt(null, { month: 'short', day: 'numeric' }).format(toDate(s)); }
/** 'Sat, Nov 7' style. */
export function fmtDateWithWeekday(s) {
  return fmt(null, { weekday: 'short', month: 'short', day: 'numeric' }).format(toDate(s));
}
/** 'November 7, 2026' style. */
export function fmtDateLong(s) {
  return fmt(null, { year: 'numeric', month: 'long', day: 'numeric' }).format(toDate(s));
}

/** Friendly label: Today / Tomorrow / Yesterday / short date. */
export function dayLabel(s, today = todayStr()) {
  const d = diffDays(today, s);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return weekdayLong(s);
  return fmtDateWithWeekday(s);
}

/** 'HH:MM' from minutes since midnight. */
export function timeStr(minutes) { return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`; }
/** Parse 'HH:MM' → minutes, or null. */
export function parseClock(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
export function nowMinutes() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }

/** '5:30 PM' or '17:30' per user preference. */
export function fmtTime(minutes, use24h = false) {
  minutes = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (use24h) return `${pad(h)}:${pad(m)}`;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${period}`;
}

/** '1h 30m' / '45m' / '2h'. */
export function fmtDuration(minutes) {
  if (minutes == null) return '';
  minutes = Math.round(minutes);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0, t;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); }
  };
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s)/mailto links survive (markdown link sanitizer). */
function safeUrl(u) {
  const t = String(u).trim();
  if (/^(https?:|mailto:)/i.test(t)) return t;
  return null;
}

/**
 * Tiny markdown renderer for task notes: **bold**, *italic*, `code`,
 * links, headings (#..###), blockquotes, ordered/unordered lists and
 * interactive `- [ ]` / `- [x]` checkboxes. Input is HTML-escaped first,
 * so the output is safe to inject. Checkbox items carry data-mdcb="i"
 * where i counts checkbox-lines in source order.
 */
export function renderMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const html = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  let cbIndex = 0;

  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const u = safeUrl(url);
      return u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });

  for (const raw of lines) {
    const line = raw.trimEnd();
    const cb = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (cb) {
      if (list !== 'ul') { closeList(); html.push('<ul class="md-list">'); list = 'ul'; }
      const i = cbIndex++;
      const checked = cb[2].toLowerCase() === 'x';
      html.push(
        `<li class="md-check${checked ? ' done' : ''}" data-mdcb="${i}">` +
        `<button type="button" class="md-check-btn" data-mdcb="${i}" aria-label="${checked ? 'Mark unchecked' : 'Mark checked'}" aria-pressed="${checked}">` +
        `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
        `<span>${inline(cb[3])}</span></li>`
      );
      continue;
    }
    const ul = /^(\s*)[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (list !== 'ul') { closeList(); html.push('<ul class="md-list">'); list = 'ul'; }
      html.push(`<li>${inline(ul[2])}</li>`);
      continue;
    }
    const ol = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
    if (ol) {
      if (list !== 'ol') { closeList(); html.push('<ol class="md-list">'); list = 'ol'; }
      html.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { html.push(`<h${h[1].length + 2} class="md-h">${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    if (line.startsWith('> ')) { html.push(`<blockquote class="md-quote">${inline(line.slice(2))}</blockquote>`); continue; }
    html.push(`<p class="md-p">${inline(line)}</p>`);
  }
  closeList();
  return html.join('\n');
}

/**
 * Flip the nth `- [ ]`/`- [x]` checkbox line in the markdown source.
 * Used by the interactive note preview.
 */
export function toggleMdCheckbox(text, index) {
  const lines = String(text ?? '').split(/\r?\n/);
  let i = 0;
  for (let n = 0; n < lines.length; n++) {
    const m = /^(\s*[-*]\s+\[)( |x|X)(\].*)$/.exec(lines[n]);
    if (m) {
      if (i === index) {
        lines[n] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + m[3];
        break;
      }
      i++;
    }
  }
  return lines.join('\n');
}

/** RFC 4180-ish CSV cell escaping. */
export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Trigger a client-side file download. */
export function download(filename, mime, content) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Haptic feedback where supported (Android Chrome). No-op elsewhere. */
export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}
