/**
 * views/matrix.js — Eisenhower matrix.
 *
 * Quadrants are DERIVED: important = P1/P2, urgent = due/overdue today or
 * tomorrow. Dragging a card between quadrants rewrites its priority
 * (Q1→P1 … Q4→P4) — predictable, undoable, and keeps the matrix a view,
 * not a second source of truth.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';
import { openTaskDetail, taskContextMenu } from './detail.js';

const QUADRANTS = [
  { key: 'q1', title: 'Do first', sub: 'Urgent · Important', prio: 1, cls: 'q1' },
  { key: 'q2', title: 'Schedule', sub: 'Not urgent · Important', prio: 2, cls: 'q2' },
  { key: 'q3', title: 'Delegate', sub: 'Urgent · Not important', prio: 3, cls: 'q3' },
  { key: 'q4', title: 'Eliminate', sub: 'Not urgent · Not important', prio: 4, cls: 'q4' },
];

export function renderMatrix(container) {
  let drag = null;

  function quadrantOf(t) {
    const today = U.todayStr();
    const day = store.taskDay(t);
    const urgent = !!(day && day <= U.addDays(today, 1));
    const important = (t.props.priority ?? 4) <= 2;
    return urgent && important ? 'q1' : important ? 'q2' : urgent ? 'q3' : 'q4';
  }

  function render() {
    container.innerHTML = '';
    stopDrag();
    const today = U.todayStr();
    const tasks = store.activeTasks().filter((t) => !t.parentId && !t.props.someday &&
      store.isStarted(t, today) && (!store.taskDay(t) || store.taskDay(t) <= U.addDays(today, 60)));

    container.append(h('div', { class: 'view-head row' },
      h('div', { class: 'grow' },
        h('h2', { class: 'view-title' }, 'Eisenhower matrix'),
        h('div', { class: 'view-sub muted small' }, 'Urgency from dates · importance from priority. Drag to re-prioritize.'),
      ),
    ));

    const grid = h('div', { class: 'matrix' });
    for (const q of QUADRANTS) {
      const items = tasks.filter((t) => quadrantOf(t) === q.key);
      const cell = h('div', { class: `matrix-cell ${q.cls}`, dataset: { q: q.key } },
        h('div', { class: 'matrix-head' },
          h('span', { class: 'matrix-title' }, q.title),
          h('span', { class: 'matrix-sub muted small' }, q.sub),
          h('span', { class: 'matrix-count chip' }, String(items.length)),
        ),
        h('div', { class: 'matrix-body', dataset: { q: q.key } },
          items.slice(0, 40).map((t) => card(t)),
          !items.length && h('div', { class: 'muted small matrix-empty' }, emptyCopy(q.key)),
        ),
      );
      grid.append(cell);
    }
    container.append(grid);
  }

  function emptyCopy(key) {
    return { q1: 'No fires to put out.', q2: 'Room for deep work.', q3: 'Nothing shouting at you.', q4: 'Nothing to let go of.' }[key];
  }

  function card(t) {
    const overdue = store.isOverdue(t);
    const el = h('div', {
      class: 'mcard' + (overdue ? ' overdue' : ''), tabindex: '0', role: 'button',
      'aria-label': `${t.props.title}. Drag between quadrants to change priority.`,
    },
      h('div', { class: 'mcard-title' }, t.props.title || 'Untitled'),
      h('div', { class: 'mcard-meta small' },
        h('span', { class: 'pflag p' + (t.props.priority ?? 4) }, ui.icon('flag', 13)),
        store.taskDay(t) && h('span', { class: 'chip chip-date' + (overdue ? ' overdue' : '') }, U.dayLabel(store.taskDay(t))),
        t.props.schedule?.start != null && h('span', { class: 'chip chip-time' }, U.fmtTime(t.props.schedule.start, store.settings.use24h)),
      ),
    );
    el.addEventListener('click', () => { if (!drag?.moved) openTaskDetail(t.id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); taskContextMenu(t, render); });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      startCardDrag(e, t, el);
    });
    return el;
  }

  /* --- card dragging between quadrants --- */
  function startCardDrag(e, task, el) {
    if (drag) return;
    drag = { task, el, moved: false, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, ghost: null };
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      drag.ghost = h('div', { class: 'mcard ghost' }, h('div', { class: 'mcard-title' }, drag.task.props.title));
      document.body.append(drag.ghost);
      U.vibrate(8);
    }
    e.preventDefault();
    drag.ghost.style.left = `${e.clientX + 8}px`;
    drag.ghost.style.top = `${e.clientY - 20}px`;
    const cell = quadrantAt(e.clientX, e.clientY);
    for (const c of container.querySelectorAll('.matrix-cell')) c.classList.toggle('drop-target', c.dataset.q === cell?.dataset?.q);
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    stopDrag();
    if (!d.moved) return;
    const cell = quadrantAt(e.clientX, e.clientY);
    if (!cell) return;
    const q = QUADRANTS.find((x) => x.key === cell.dataset.q);
    if (!q || (d.task.props.priority ?? 4) === q.prio) return;
    const oldP = d.task.props.priority ?? 4;
    store.update(d.task.id, { priority: q.prio });
    U.vibrate(10);
    ui.undoToast(`Moved to ${q.title} (P${q.prio})`, () => store.update(d.task.id, { priority: oldP }));
    render();
  }
  function quadrantAt(x, y) {
    return [...container.querySelectorAll('.matrix-cell')].find((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) || null;
  }
  function stopDrag() {
    if (drag) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    }
    drag?.ghost?.remove();
    drag?.el?.classList.remove('dragging');
    for (const c of container.querySelectorAll('.matrix-cell')) c.classList.remove('drop-target');
    drag = null;
  }

  render();
  const unsub = store.subscribe(render);
  return () => { unsub(); stopDrag(); };
}

function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
