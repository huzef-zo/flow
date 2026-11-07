/**
 * views/focus.js — Pomodoro focus timer (25/5 by default, configurable in
 * Settings). The timer is a module-level singleton, so it keeps running
 * while you navigate elsewhere; the app header shows a running chip
 * (main.js listens to the custom `flow:focus` events dispatched here).
 * Completed focus rounds are logged as timerLog blocks and summed onto
 * the task (props.focusMinutes).
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';

/* ---------------- singleton timer engine ---------------- */

const timer = {
  taskId: null,
  mode: 'focus',            // focus | break | long
  remaining: (store.settings.pomodoro.focus || 25) * 60,
  running: false,
  round: 1,                 // completed focus rounds in this cycle
  endAt: null,              // wall-clock ms when running
};
let tickHandle = null;
const listeners = new Set();

function totalFor(mode) {
  const p = store.settings.pomodoro;
  return (mode === 'focus' ? p.focus : mode === 'break' ? p.break : p.longBreak) * 60;
}

function emit() {
  const detail = { ...timer, taskTitle: timer.taskId ? store.get(timer.taskId)?.props.title : null };
  for (const fn of listeners) fn(detail);
  window.dispatchEvent(new CustomEvent('flow:focus', { detail }));
}
export function subscribeFocus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function focusState() { return { ...timer }; }

function setMode(mode, { autostart = false } = {}) {
  timer.mode = mode;
  timer.remaining = totalFor(mode);
  timer.running = false;
  if (autostart) start();
  else emit();
}

function start() {
  if (timer.running) return;
  timer.running = true;
  timer.endAt = Date.now() + timer.remaining * 1000;
  clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
    if (timer.remaining <= 0) finishPhase();
    emit();
  }, 250);
  emit();
}
function pause() {
  if (!timer.running) return;
  timer.running = false;
  clearInterval(tickHandle);
  emit();
}
function reset() {
  pause();
  timer.remaining = totalFor(timer.mode);
  emit();
}
function skip() { finishPhase(true); }

function finishPhase(skipped = false) {
  clearInterval(tickHandle);
  timer.running = false;
  const wasFocus = timer.mode === 'focus';
  const minutes = Math.round(totalFor('focus') / 60);

  if (wasFocus && !skipped) {
    store.logFocus({ taskId: timer.taskId, minutes });
    U.vibrate([20, 60, 20, 60, 40]);
    if (store.settings.pomodoro.sound) { ui.beep(880, 0.15); setTimeout(() => ui.beep(1174, 0.25), 180); }
    notify('Focus round complete', timer.taskId ? `Nice work on “${store.get(timer.taskId)?.props.title}”. Time for a break.` : 'Time for a break.');
    timer.round += 1;
    const p = store.settings.pomodoro;
    const nextMode = timer.round > (p.rounds || 4) ? 'long' : 'break';
    if (timer.round > (p.rounds || 4)) timer.round = 1;
    setMode(nextMode, { autostart: p.autoStartBreaks });
    return;
  }
  if (!wasFocus && !skipped) {
    U.vibrate(20);
    if (store.settings.pomodoro.sound) ui.beep(660, 0.2);
    notify('Break over', 'Ready for the next focus round?');
    setMode('focus');
    return;
  }
  // skipped: jump to the other phase without logging
  setMode(wasFocus ? 'break' : 'focus');
}

function notify(title, body) {
  window.__flowNotify?.(title, body);
}

/* ---------------- view ---------------- */

export function renderFocus(container) {
  function render() {
    container.innerHTML = '';
    const task = timer.taskId ? store.get(timer.taskId) : null;

    container.append(h('div', { class: 'view-head row' },
      h('div', { class: 'grow' },
        h('h2', { class: 'view-title' }, 'Focus'),
        h('div', { class: 'view-sub muted small' }, 'Pomodoro timer · logs minutes per task'),
      ),
    ));

    /* task selector */
    const taskChip = h('button', { class: 'focus-task chip chip-btn', onClick: () => pickTask() },
      ui.icon('check', 13),
      task ? task.props.title : 'Pick a task (optional)',
    );
    container.append(h('div', { class: 'row', style: 'justify-content:center; margin: 6px 0 2px' }, taskChip));

    /* ring */
    const total = totalFor(timer.mode);
    const ring = ui.progressRing({ size: 210, stroke: 10, value: 1 - timer.remaining / total, label: `${U.fmtTime(timer.remaining / 60 | 0, true)} remaining` });
    const timeText = h('div', { class: 'focus-time' }, fmt(timer.remaining));
    const modeText = h('div', { class: 'focus-mode muted small' },
      timer.mode === 'focus' ? 'Focus' : timer.mode === 'break' ? 'Short break' : 'Long break');
    container.append(h('div', { class: 'focus-ring-wrap' },
      h('div', { class: 'focus-ring' }, ring.el, timeText, modeText)));

    /* round dots */
    const p = store.settings.pomodoro;
    const dots = h('div', { class: 'row', style: 'justify-content:center; gap:8px; margin:10px 0' });
    for (let i = 1; i <= (p.rounds || 4); i++) {
      dots.append(h('span', { class: 'round-dot' + (i < timer.round ? ' done' : '') }));
    }
    container.append(dots);

    /* controls */
    container.append(h('div', { class: 'row', style: 'justify-content:center; gap:12px' },
      h('button', { class: 'icon-btn', 'aria-label': 'Reset', onClick: () => reset() }, ui.icon('reset', 22)),
      h('button', { class: 'fab-static btn-primary', 'aria-label': timer.running ? 'Pause' : 'Start', onClick: () => timer.running ? pause() : start() },
        ui.icon(timer.running ? 'pause' : 'play', 26)),
      h('button', { class: 'icon-btn', 'aria-label': 'Skip phase', onClick: () => skip() }, ui.icon('skip', 22)),
    ));

    /* today's stats */
    const today = U.todayStr();
    const logs = store.allOfType('timerLog').filter((l) => l.props.mode !== 'break' && U.dateStrFromMs(l.props.endedAt || l.createdAt) === today);
    const mins = logs.reduce((a, l) => a + (l.props.minutes || 0), 0);
    container.append(h('div', { class: 'focus-stats muted small' },
      `Today: ${logs.length} ${logs.length === 1 ? 'round' : 'rounds'} · ${U.fmtDuration(mins)} focused`,
      task?.props.focusMinutes ? ` · ${U.fmtDuration(task.props.focusMinutes)} on this task` : '',
    ));

    container.append(h('div', { class: 'muted small', style: 'text-align:center; margin-top:14px' },
      h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { location.hash = '#/settings'; } }, 'Timer settings')));
  }

  function fmt(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function pickTask() {
    const today = U.todayStr();
    const tasks = store.activeTasks().filter((t) => !t.parentId && (!store.taskDay(t) || store.taskDay(t) <= today))
      .sort((a, b) => (b.props.focusMinutes || 0) - (a.props.focusMinutes || 0));
    const list = h('div', {});
    if (!tasks.length) list.append(h('div', { class: 'muted small', style: 'padding:8px' }, 'No open tasks — free focus is fine too.'));
    for (const t of tasks) {
      list.append(h('button', { class: 'menu-item', onClick: () => {
        timer.taskId = t.id;
        emit();
        sheet.close();
        render();
      } },
        ui.icon(t.id === timer.taskId ? 'check' : 'clock', 18),
        h('span', { class: 'grow' }, t.props.title),
        t.props.focusMinutes > 0 && h('span', { class: 'muted small' }, U.fmtDuration(t.props.focusMinutes)),
      ));
    }
    list.append(h('div', { class: 'menu-sep' }));
    list.append(h('button', { class: 'menu-item', onClick: () => { timer.taskId = null; emit(); sheet.close(); render(); } },
      ui.icon('close', 18), h('span', { class: 'grow' }, 'No task (free focus)')));
    const sheet = ui.openSheet({ title: 'Focus on…', content: list });
  }

  let lastRunning = null;
  const onTick = () => {
    // Full re-render only when the running state flips (button label etc.);
    // otherwise update the ring + time in place for smooth 60fps ticks.
    if (lastRunning !== timer.running) { lastRunning = timer.running; render(); return; }
    const total = totalFor(timer.mode);
    const timeEl = container.querySelector('.focus-time');
    const modeEl = container.querySelector('.focus-mode');
    if (timeEl) timeEl.textContent = fmt(timer.remaining);
    if (modeEl) modeEl.textContent = timer.mode === 'focus' ? 'Focus' : timer.mode === 'break' ? 'Short break' : 'Long break';
    const svg = container.querySelector('.focus-ring svg');
    if (svg) {
      const fg = svg.querySelector('.ring-fg');
      const c = 2 * Math.PI * ((210 - 10) / 2);
      if (fg) fg.style.strokeDashoffset = String(c * (timer.remaining / total));
    }
  };
  const unsubTick = subscribeFocus(onTick);

  render();
  const unsubStore = store.subscribe(render);
  return () => { unsubStore(); unsubTick(); };
}

function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
