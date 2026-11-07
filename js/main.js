/**
 * main.js — app shell and bootstrap.
 *
 * Boots the store (IndexedDB), renders the shell (header / sidebar on
 * desktop / bottom tabs on mobile / FAB), wires the hash router with
 * lazy-loaded views, the quick-add sheet (parser + chips + voice), the
 * command palette, reminders, onboarding, keyboard shortcuts and the
 * service worker.
 */

import * as store from './store.js';
import * as sync from './sync.js';
import * as ui from './ui.js';
import * as U from './utils.js';
import { parse } from './parser.js';
import { parseICS } from './ics.js';

window.__flowVersion = '1.0.0';
window.__flowStore = store;          // used by ui.metaChips for label/project lookups
window.__flowSettings = store.settings;

const ACCENT_HEX = {
  indigo: '#4F46E5', teal: '#0D9488', green: '#15803D',
  amber: '#B45309', rose: '#BE123C', violet: '#7C3AED',
};

/* ================================================================== *
 * Theme
 * ================================================================== */

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme) {
  store.setSettings({ theme });
  const resolved = theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#131313' : '#fafaf7');
  localStorage.setItem('flow-theme', theme);
}
export function applyAccent(key) {
  store.setSettings({ accent: key });
  document.documentElement.style.setProperty('--accent', ACCENT_HEX[key] || ACCENT_HEX.indigo);
  localStorage.setItem('flow-accent', key);
}
window.__flowApplyTheme = applyTheme;
window.__flowApplyAccent = applyAccent;

darkQuery.addEventListener('change', () => {
  if (store.settings.theme === 'system') applyTheme('system');
});

/* ================================================================== *
 * Shell
 * ================================================================== */

let viewContainer = null;
let viewTitleEl = null;
let routeCleanup = null;
let currentRoute = 'today';

function buildShell() {
  const app = document.getElementById('app');

  /* --- header --- */
  const menuBtn = h('button', { class: 'icon-btn only-mobile', 'aria-label': 'Open menu', onClick: () => openDrawer() }, ui.icon('menu', 22));
  viewTitleEl = h('h1', { class: 'app-title', id: 'viewTitle' }, 'Today');
  const syncChip = buildSyncChip();
  const focusChip = h('button', { class: 'chip chip-btn focus-chip hidden', 'aria-label': 'Focus timer running', onClick: () => { location.hash = '#/focus'; } },
    ui.icon('timer', 14), h('span', { class: 'focus-chip-time' }, ''));
  const searchBtn = h('button', { class: 'icon-btn', 'aria-label': 'Search (Ctrl K)', onClick: () => openPalette() }, ui.icon('search', 21));

  const header = h('header', { class: 'app-header' },
    menuBtn, viewTitleEl,
    h('div', { class: 'grow' }),
    focusChip, syncChip, searchBtn,
  );

  /* --- sidebar (desktop) / drawer (mobile) --- */
  const sidebar = buildSidebar();
  const backdrop = h('div', { class: 'drawer-backdrop', onClick: closeDrawer });
  function openDrawer() { document.body.classList.add('drawer-open'); }
  function closeDrawer() { document.body.classList.remove('drawer-open'); }

  /* --- main view --- */
  viewContainer = h('main', { class: 'view-scroll', id: 'view', tabindex: '-1' });

  /* --- bottom tabbar (mobile) --- */
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main navigation' },
    tab('inbox', 'Inbox', 'inbox'), tab('today', 'Today', 'sun'),
    tab('upcoming', 'Upcoming', 'calendar'), tab('browse', 'Browse', 'layers'),
  );
  function tab(route, label, icon) {
    return h('a', { class: 'tab', href: '#/' + route, dataset: { route } },
      ui.icon(icon, 22), h('span', { class: 'tab-label' }, label));
  }

  /* --- FAB --- */
  const fab = h('button', { class: 'fab', 'aria-label': 'Quick add task (Q)', onClick: () => openQuickAdd() }, ui.icon('plus', 26));
  // Auto-hide while scrolling down into content (keeps cards/toggles
  // unobstructed), slide back on scroll up. Tasks-first routes only.
  const FAB_HIDDEN_ROUTES = new Set(['settings', 'focus']);
  let lastScrollTop = 0;
  viewContainer.addEventListener('scroll', () => {
    const st = viewContainer.scrollTop;
    const hide = st > lastScrollTop + 8 && st > 40;
    const show = st < lastScrollTop - 8 || st <= 40;
    if (hide) fab.classList.add('hidden');
    else if (show) fab.classList.remove('hidden');
    lastScrollTop = st;
  }, { passive: true });

  app.append(header, h('div', { class: 'shell' }, sidebar, backdrop, viewContainer), tabbar, fab);
  window.__flowUpdateFab = (routeName) => {
    fab.classList.toggle('route-hidden', FAB_HIDDEN_ROUTES.has(routeName));
  };
}

function buildSidebar() {
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Sidebar' });
  const item = (route, label, icon, cls = '') => h('a', { class: `side-link ${cls}`, href: '#/' + route, dataset: { route } },
    ui.icon(icon, 19), h('span', {}, label));

  nav.append(
    h('div', { class: 'side-group' },
      item('today', 'Today', 'sun'),
      item('inbox', 'Inbox', 'inbox'),
      item('upcoming', 'Upcoming', 'calendar'),
      item('anytime', 'Anytime', 'layers'),
      item('someday', 'Someday', 'someday'),
      item('logbook', 'Logbook', 'archive'),
    ),
    h('div', { class: 'side-group' },
      h('div', { class: 'side-label' }, 'Tools'),
      item('matrix', 'Matrix', 'grid'),
      item('habits', 'Habits', 'flame'),
      item('focus', 'Focus', 'timer'),
      item('settings', 'Settings', 'settings'),
    ),
    h('div', { class: 'side-group side-projects' }),
    h('div', { class: 'side-foot' },
      h('div', { class: 'side-sync muted small' }, ''),
      h('button', { class: 'btn btn-sm install-btn hidden', onClick: () => {
        window.__flowInstallPrompt?.();
      } }, ui.icon('download', 14), 'Install app'),
    ),
  );

  renderSidebarProjects(nav);
  return nav;
}

function renderSidebarProjects(nav = document.querySelector('.sidebar')) {
  const wrap = nav?.querySelector('.side-projects');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.append(h('div', { class: 'side-label' }, 'Areas & projects'));
  const link = (href, label, icon, count) => h('a', { class: 'side-link sub', href },
    ui.icon(icon, 16), h('span', { class: 'grow' }, label), count != null && h('span', { class: 'side-count muted small' }, String(count)));
  for (const area of store.childrenOf('area', null)) {
    const count = store.activeTasks().filter((t) => {
      const p = store.projectOf(t);
      return p && p.parentId === area.id;
    }).length;
    wrap.append(link('#/area/' + area.id, area.props.name, 'box', count));
    for (const p of store.childrenOf('project', area.id)) {
      wrap.append(link('#/project/' + p.id, p.props.name, 'folder',
        store.activeTasks().filter((t) => t.props.projectId === p.id).length));
    }
  }
  for (const p of store.childrenOf('project', null)) {
    wrap.append(link('#/project/' + p.id, p.props.name, 'folder',
      store.activeTasks().filter((t) => t.props.projectId === p.id).length));
  }
}

/* --- sync status chip --- */
function buildSyncChip() {
  const chip = h('button', { class: 'sync-chip', 'aria-live': 'polite', title: 'Sync status', onClick: () => {
    const s = sync.syncState;
    ui.toast(`Sync: ${s.status}${s.pending ? ` · ${s.pending} pending change${s.pending > 1 ? 's' : ''}` : ''}${s.lastError ? ` · ${s.lastError}` : ''}`);
  } },
    ui.icon('cloud', 18), h('span', { class: 'sync-dot' }),
  );
  const label = document.createElement('span');
  label.className = 'sync-label small';
  chip.append(label);
  const refresh = () => {
    const s = sync.syncState;
    chip.dataset.status = s.status;
    label.textContent = s.pending > 0 ? `${s.pending}` : '';
    chip.title = `Sync: ${s.status}`;
    const foot = document.querySelector('.side-sync');
    if (foot) foot.textContent = `Sync ${s.status}${s.pending ? ` · ${s.pending} pending` : ''}`;
  };
  sync.subscribeSync(refresh);
  refresh();
  return chip;
}

/* ================================================================== *
 * Router (hash-based, lazy views)
 * ================================================================== */

const VIEW_LOADERS = {
  today: () => import('./views/today.js').then((m) => m.renderToday),
  inbox: () => import('./views/list.js').then((m) => m.renderInbox),
  anytime: () => import('./views/list.js').then((m) => m.renderAnytime),
  someday: () => import('./views/list.js').then((m) => m.renderSomeday),
  logbook: () => import('./views/list.js').then((m) => m.renderLogbook),
  upcoming: () => import('./views/upcoming.js').then((m) => m.renderUpcoming),
  browse: () => import('./views/browse.js').then((m) => m.renderBrowse),
  project: () => import('./views/list.js').then((m) => m.renderProject),
  area: () => import('./views/list.js').then((m) => m.renderArea),
  label: () => import('./views/list.js').then((m) => m.renderLabel),
  smart: () => import('./views/list.js').then((m) => m.renderSmart),
  matrix: () => import('./views/matrix.js').then((m) => m.renderMatrix),
  habits: () => import('./views/habits.js').then((m) => m.renderHabits),
  focus: () => import('./views/focus.js').then((m) => m.renderFocus),
  settings: () => import('./views/settings.js').then((m) => m.renderSettings),
};

const TITLES = {
  today: 'Today', inbox: 'Inbox', upcoming: 'Upcoming', anytime: 'Anytime', someday: 'Someday',
  logbook: 'Logbook', browse: 'Browse', matrix: 'Matrix', habits: 'Habits', focus: 'Focus', settings: 'Settings',
};

async function route() {
  const hash = location.hash || '#/today';
  const [name, id] = hash.replace(/^#\//, '').split('/');
  const routeName = VIEW_LOADERS[name] ? name : 'today';
  currentRoute = routeName;

  try {
    routeCleanup?.();
  } catch { /* ignore */ }
  routeCleanup = null;

  const title = TITLES[routeName] ||
    (routeName === 'project' ? (store.get(id)?.props.name || 'Project') :
      routeName === 'area' ? (store.get(id)?.props.name || 'Area') :
        routeName === 'label' ? '@' + (store.get(id)?.props.name || 'Label') :
          routeName === 'smart' ? (store.get(id)?.props.name || 'Smart list') : 'Flow');
  viewTitleEl.textContent = title;
  document.title = `${title} · Flow`;

  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('active', el.dataset.route === routeName);
    if (el.dataset.route === routeName) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  for (const el of document.querySelectorAll('.side-link')) {
    const on = el.dataset.route === routeName && el.getAttribute('href') === hash;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  document.body.classList.remove('drawer-open');

  viewContainer.innerHTML = '';
  viewContainer.scrollTop = 0;
  const loader = VIEW_LOADERS[routeName];
  window.__flowUpdateFab?.(routeName);
  const render = await loader();
  routeCleanup = render(viewContainer, { id }) || null;
}
window.__flowReroute = () => { renderSidebarProjects(); route(); };

/* ================================================================== *
 * Quick add
 * ================================================================== */

let activeQuickAdd = null;

export function openQuickAdd(prefill = '') {
  if (activeQuickAdd) { activeQuickAdd.focus(prefill); return; }
  const ctx = { now: new Date(), weekStart: store.settings.weekStart };
  let tokens = [];
  let lastInput = '';

  const input = h('input', {
    class: 'input qa-input', placeholder: 'e.g. Email Dana tomorrow 9am #Work p1',
    'aria-label': 'Quick add task', autocomplete: 'off',
  });
  input.value = prefill;

  const preview = h('div', { class: 'qa-preview muted', 'aria-hidden': 'true' });
  const chipsRow = h('div', { class: 'qa-chips' });
  const hint = h('div', { class: 'qa-hint muted small' }, 'Try: ',
    h('code', {}, 'tomorrow 5pm'), ' · ', h('code', {}, 'every weekday'), ' · ', h('code', {}, '#Project @label p1'));

  const addBtn = h('button', { class: 'btn btn-primary', onClick: () => commit(false) }, 'Add');
  const detailsBtn = h('button', { class: 'btn btn-ghost', onClick: () => commit(true) }, 'Details');
  const moreBtn = h('button', { class: 'btn btn-ghost btn-sm', onClick: () => commit(true) }, 'Add with details');

  /* voice input (graceful if unsupported) */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false;
  const micBtn = h('button', { class: 'icon-btn', 'aria-label': 'Voice input', onClick: toggleVoice }, ui.icon('mic', 21));
  if (!SR) micBtn.disabled = true, micBtn.title = 'Voice input is not supported in this browser';
  function toggleVoice() {
    if (!SR) return;
    if (listening) { recognition.stop(); return; }
    recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const text = [...e.results].map((r) => r[0].transcript).join(' ');
      input.value = text;
      reparse();
    };
    recognition.onend = () => { listening = false; micBtn.classList.remove('listening'); };
    recognition.onerror = () => { listening = false; micBtn.classList.remove('listening'); ui.toast('Voice input unavailable — check microphone permission'); };
    try {
      recognition.start();
      listening = true;
      micBtn.classList.add('listening');
    } catch { ui.toast('Voice input could not start'); }
  }

  const content = h('div', { class: 'qa' },
    preview,
    h('div', { class: 'row' }, input, micBtn),
    chipsRow,
    hint,
    h('div', { class: 'row', style: 'justify-content: space-between; margin-top: 6px' },
      moreBtn, h('div', { class: 'row' }, detailsBtn, addBtn)),
  );

  const sheet = ui.openSheet({
    title: 'Quick add', content, className: 'qa-sheet',
    onClose: () => { activeQuickAdd = null; try { recognition?.stop(); } catch { /* noop */ } },
  });
  activeQuickAdd = { focus: (p) => { input.focus(); if (p) { input.value = p; reparse(); } } };

  input.addEventListener('input', reparse);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(false); }
  });
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); reparse(); }, 60);

  function reparse() {
    const r = parse(input.value, ctx);
    tokens = r.tokens;
    // live highlighted preview of the recognized spans
    preview.innerHTML = '';
    if (!input.value.trim()) { preview.append('Recognized details appear here as you type.'); }
    else {
      let pos = 0;
      const text = input.value;
      for (const t of tokens) {
        preview.append(text.slice(pos, t.start));
        preview.append(h('mark', { class: t.enabled === false ? 'off' : '' }, text.slice(t.start, t.end)));
        pos = t.end;
      }
      preview.append(text.slice(pos));
    }
    renderChips(r);
  }

  function chipLabel(t) {
    switch (t.kind) {
      case 'date': return t.value.time != null ? `${U.dayLabel(t.value.date)} ${U.fmtTime(t.value.time, store.settings.use24h)}` : U.dayLabel(t.value.date);
      case 'time': return typeof t.value === 'object' ? `${U.fmtTime(t.value.time, store.settings.use24h)} · ${U.fmtDuration(t.value.duration)}` : U.fmtTime(t.value, store.settings.use24h);
      case 'duration': return U.fmtDuration(t.value);
      case 'priority': return `P${t.value}`;
      case 'project': return '#' + t.value;
      case 'label': return '@' + t.value;
      case 'area': return '&' + t.value;
      case 'recurrence': return store.describeRule(t.value);
      case 'someday': return 'Someday';
      default: return t.raw.trim();
    }
  }
  function chipIcon(t) {
    return { date: 'calendar', time: 'clock', duration: 'clock', priority: 'flag', project: 'folder', label: 'tag', area: 'box', recurrence: 'repeat', someday: 'someday' }[t.kind] || 'info';
  }
  function renderChips(r) {
    chipsRow.innerHTML = '';
    for (const t of tokens) {
      const chip = h('span', { class: 'pchip' + (t.enabled === false ? ' off' : ''), title: t.enabled === false ? 'Tap to re-enable' : 'Tap × to exclude' },
        ui.icon(chipIcon(t), 13), chipLabel(t),
        h('button', { class: 'pchip-x', 'aria-label': `Exclude ${chipLabel(t)}`, onClick: (e) => { e.stopPropagation(); t.enabled = false; reparse(); } }, ui.icon('close', 13)),
      );
      chip.addEventListener('click', () => { t.enabled = true; reparse(); });
      chipsRow.append(chip);
    }
  }

  function commit(withDetails) {
    const r = parse(input.value, ctx);
    if (!r.title.trim()) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      input.focus();
      return;
    }
    const task = createTaskFromParse(r);
    U.vibrate(10);
    input.value = '';
    reparse();
    input.focus();
    const where = r.date ? U.dayLabel(r.date) : 'Inbox';
    if (withDetails) {
      sheet.close();
      import('./views/detail.js').then(({ openTaskDetail }) => openTaskDetail(task.id));
    } else {
      ui.toast(`Added — ${where}`, { duration: 2200 });
    }
  }
}

/** Turn a parse result into task props (+ any implicit project/label/area). */
export function createTaskFromParse(r) {
  const props = { title: r.title.trim() };
  if (r.date) props.schedule = { date: r.date, start: r.time ?? null, dur: r.duration ?? (r.time != null ? 30 : 30) };
  if (r.priority != null) props.priority = r.priority;
  if (r.recurrence) props.recurrence = r.recurrence;
  if (r.someday) props.someday = true;

  if (r.projectName) props.projectId = store.ensureNamed('project', r.projectName).id;
  if (r.areaName) {
    const area = store.ensureNamed('area', r.areaName);
    let project = store.childrenOf('project', area.id)[0];
    if (!project) project = store.create({ type: 'project', props: { name: area.props.name }, parentId: area.id });
    if (!props.projectId) props.projectId = project.id;
  }
  if (r.labels?.length) props.labels = r.labels.map((n) => store.ensureNamed('label', n).id);

  if (store.settings.autoReminders && r.date) {
    props.reminder = r.time != null ? U.timeStr(r.time) : store.settings.defaultReminderTime;
  }
  return store.create({ type: 'task', props });
}

window.__flowQuickAdd = (prefill) => openQuickAdd(prefill || '');
window.__flowExportJSON = () => {
  U.download(`flow-backup-${U.todayStr()}.json`, 'application/json', JSON.stringify(store.exportJSON(), null, 2));
  ui.toast('Backup downloaded');
};

/* ================================================================== *
 * Calendar import (shared by Upcoming + Settings + palette)
 * ================================================================== */

window.__flowImportICS = () => {
  const input = h('input', { type: 'file', accept: '.ics,text/calendar', class: 'hidden' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const { events, warnings } = parseICS(await file.text());
      if (!events.length) return ui.toast('No events found in that file');
      store.createMany(events.map((e) => ({
        type: 'event',
        props: {
          title: e.title, date: e.date, start: e.time, dur: e.dur, allDay: e.allDay,
          location: e.location, uid: e.uid || null,
        },
        id: e.uid ? `ics:${e.uid}:${e.date}` : undefined,
      })));
      ui.toast(`Imported ${events.length} event${events.length > 1 ? 's' : ''}`, { action: { label: 'See Today', fn: () => { location.hash = '#/today'; } } });
      for (const w of warnings.slice(0, 3)) ui.toast(w, { type: 'info' });
      window.__flowReroute();
    } catch (err) {
      ui.toast(`Import failed: ${err.message}`);
    }
  });
  input.click();
};

/* ================================================================== *
 * Notifications & reminders
 * ================================================================== */

let swReg = null;
window.__flowSWreg = null;

async function notify(title, body, taskId) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = swReg || await navigator.serviceWorker?.getRegistration();
      await reg?.showNotification(title, {
        body, tag: taskId || 'flow',
        icon: './icons/icon-192.png', badge: './icons/icon-192.png',
        data: { taskId },
      });
      return;
    } catch { /* fall through to in-app */ }
  }
  ui.toast(`${title} — ${body}`, { duration: 7000 });
}
window.__flowNotify = notify;

/** Runs every 30s while the app is visible; fires due reminders exactly once. */
function checkReminders() {
  if (document.hidden) return;
  const now = Date.now();
  for (const t of store.activeTasks()) {
    const rem = t.props.reminder;
    if (!rem || t.props.notifiedAt) continue;
    const day = t.props.schedule?.date || t.props.dueDate;
    if (!day) continue;
    const at = new Date(`${day}T${rem}`).getTime();
    if (at <= now) {
      store.update(t.id, { notifiedAt: now });
      const title = t.props.title || 'Task';
      notify(`Reminder: ${title}`, `${U.dayLabel(day)} · ${rem}`);
      ui.toast(`Reminder — ${title}`, {
        duration: 8000,
        action: { label: 'Complete', fn: () => { store.completeTask(t.id); U.vibrate(12); } },
      });
    }
  }
}

/* ================================================================== *
 * Onboarding
 * ================================================================== */

const CARDS = [
  {
    icon: 'plus', title: 'Capture anything, fast',
    body: h('div', {},
      'One box, plain language. Tap + (or press Q) and type:',
      h('div', { class: 'onboard-example' }, 'Email Dana tomorrow 9am #Work @email p1'),
      'Dates, times, priorities, projects, labels and repeats — all inline.'),
  },
  {
    icon: 'calendar', title: 'Plan the day on a timeline',
    body: h('div', {},
      'Today is not a list. Drag tasks onto the hour-by-hour timeline to time-block them, drag back to unschedule. Import your calendar with .ics to see events beside tasks.'),
  },
  {
    icon: 'cloud', title: 'Yours, offline, forever',
    body: h('div', {},
      'Flow works fully offline and stores everything on your device. Export JSON/CSV any time — no account, no lock-in. A sync protocol is built in for the future.'),
  },
];

async function maybeOnboard() {
  const { metaGet, metaSet } = await import('./db.js');
  if (await metaGet('onboarded', null)) return;
  let i = 0;
  const dots = h('div', { class: 'onboard-dots' });
  const card = h('div', { class: 'onboard-card' });
  const nextBtn = h('button', { class: 'btn btn-primary', onClick: next }, 'Next');
  const skipBtn = h('button', { class: 'btn btn-ghost', onClick: finish }, 'Skip');

  function renderCard() {
    const c = CARDS[i];
    card.innerHTML = '';
    card.append(h('div', { class: 'onboard-icon' }, ui.icon(c.icon, 32)));
    card.append(h('h2', { class: 'onboard-title' }, c.title));
    card.append(h('div', { class: 'onboard-body' }, c.body));
    dots.innerHTML = '';
    CARDS.forEach((_, n) => dots.append(h('span', { class: 'onboard-dot' + (n === i ? ' on' : '') })));
    nextBtn.textContent = i === CARDS.length - 1 ? 'Start using Flow' : 'Next';
  }
  function next() { i += 1; if (i >= CARDS.length) finish(); else renderCard(); }
  async function finish() {
    overlay.remove();
    await metaSet('onboarded', true);
    await store.seedSample();
    ui.toast('Added a few sample tasks so you can explore — clear them anytime in Settings', { duration: 6000 });
    window.__flowReroute();
  }

  const overlay = h('div', { class: 'onboard' },
    card, dots,
    h('div', { class: 'row', style: 'justify-content:space-between; width:100%' }, skipBtn, nextBtn),
  );
  document.body.append(overlay);
  renderCard();
}

/* ================================================================== *
 * Shortcuts help
 * ================================================================== */

window.__flowShortcuts = () => {
  const rows = [
    ['Q', 'Quick add a task'], ['Ctrl/Cmd + K  or  /', 'Search & command palette'],
    ['1 – 4', 'Today · Inbox · Upcoming · Browse'], ['Esc', 'Close sheet / menu / selection'],
    ['Enter', 'Open focused task'], ['X', 'Complete focused task'], ['?', 'This help'],
  ];
  ui.openModal({
    title: 'Keyboard shortcuts',
    content: h('div', {},
      h('table', { class: 'shortcut-table' },
        ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
    ),
  });
};

/* ================================================================== *
 * Boot
 * ================================================================== */

async function boot() {
  /* pre-paint theme from the localStorage mirror (set by index.html) */
  const themePref = localStorage.getItem('flow-theme') || 'system';
  const accentPref = localStorage.getItem('flow-accent') || 'indigo';
  document.documentElement.dataset.theme =
    themePref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : themePref;
  document.documentElement.style.setProperty('--accent', ACCENT_HEX[accentPref] || ACCENT_HEX.indigo);

  try {
    await store.initStore();
  } catch (err) {
    document.getElementById('app').append(ui.emptyState({
      icon: 'cloudOff', title: 'Storage unavailable',
      body: 'Flow needs IndexedDB to store your tasks, and it appears to be blocked (private browsing?). Try a regular window.',
    }));
    return;
  }

  buildShell();
  await route();
  window.addEventListener('hashchange', route);
  window.__flowReroute = () => { renderSidebarProjects(); route(); };

  /* sync engine */
  sync.initSync({ store });

  /* service worker */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    try {
      swReg = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
      window.__flowSWreg = swReg;
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.action === 'open-task' && e.data.taskId) {
          import('./views/detail.js').then(({ openTaskDetail }) => openTaskDetail(e.data.taskId));
        }
      });
    } catch { /* SW is an enhancement; the app still works */ }
  }

  /* install prompt */
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__flowInstallPrompt = async () => {
      e.prompt();
      await e.userChoice;
      window.__flowInstallPrompt = null;
      document.querySelector('.install-btn')?.classList.add('hidden');
    };
    document.querySelector('.install-btn')?.classList.remove('hidden');
  });

  /* palette + shortcuts */
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      import('./views/palette.js').then(({ openPalette }) => openPalette());
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (ui.hasOpenLayers() && e.key !== 'Escape') return;
    switch (e.key) {
      case 'q': case 'Q': e.preventDefault(); openQuickAdd(); break;
      case '/': e.preventDefault(); import('./views/palette.js').then(({ openPalette }) => openPalette()); break;
      case '?': window.__flowShortcuts(); break;
      case 'Escape': ui.closeTopLayer(); break;
      case '1': location.hash = '#/today'; break;
      case '2': location.hash = '#/inbox'; break;
      case '3': location.hash = '#/upcoming'; break;
      case '4': location.hash = '#/browse'; break;
      default: break;
    }
  });

  /* focus timer chip */
  window.addEventListener('flow:focus', (e) => {
    const chip = document.querySelector('.focus-chip');
    if (!chip) return;
    const d = e.detail;
    if (d.running) {
      chip.classList.remove('hidden');
      const m = Math.floor(d.remaining / 60), s = d.remaining % 60;
      chip.querySelector('.focus-chip-time').textContent = `${m}:${String(s).padStart(2, '0')}`;
    } else {
      chip.classList.add('hidden');
    }
  });

  /* reminders */
  setInterval(checkReminders, 30000);
  document.addEventListener('visibilitychange', checkReminders);
  checkReminders();

  /* deep link from manifest shortcut (?add=1) */
  if (new URLSearchParams(location.search).get('add')) {
    history.replaceState(null, '', location.pathname);
    openQuickAdd();
  }

  await maybeOnboard();

  /* first paint of sidebar projects after store load */
  renderSidebarProjects();
}

function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }

boot();
