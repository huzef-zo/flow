/**
 * views/today.js — the Today planner.
 *
 * Top: progress ring + planned-vs-available time.
 * Middle: "Today" task list (unscheduled + overdue).
 * Bottom: hour-by-hour timeline. Drag a task onto it to time-block it
 * (15-minute snap), drag blocks to move them, grab an edge to resize,
 * drag a block back up (or use its menu) to unschedule. Imported .ics
 * events render in a visually distinct style.
 *
 * Pointer-events based dragging works for touch AND mouse; all
 * manipulations also have menu/keyboard equivalents (accessibility).
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';
import { openTaskDetail, completeWithUndo, quickScheduleMenu, taskContextMenu, openSchedulePicker } from './detail.js';

const HOUR_H = 72;          // px per hour → 15 min = 18px
const SNAP = 15;            // minutes
const DEFAULT_DUR = 60;     // minutes for newly time-blocked tasks
const DAY_AVAILABLE_MIN = 16 * 60; // 07:00–23:00 is "available"

export function renderToday(container) {
  const cleanups = [];
  const selection = ui.createSelection({ onChange: () => render() });
  let drag = null;
  let rafId = null;
  let nowTimer = null;
  let trackEl = null;
  let listSectionEl = null;
  let lastDragEnd = 0;
  let scrolledOnce = false;

  /* ---------------- data ---------------- */

  function collect() {
    const today = U.todayStr();
    const tasks = store.activeTasks().filter((t) =>
      !t.parentId && !t.props.someday && store.isStarted(t) &&
      (store.taskDay(t) === today || (t.props.dueDate && t.props.dueDate < today)));
    const blocks = tasks.filter((t) => t.props.schedule?.date === today && t.props.schedule.start != null)
      .sort((a, b) => a.props.schedule.start - b.props.schedule.start);
    const overdue = tasks.filter((t) => !blocks.includes(t) && t.props.dueDate && t.props.dueDate < today);
    const list = tasks.filter((t) => !blocks.includes(t) && !overdue.includes(t));
    const events = store.allOfType('event').filter((e) => e.props.date === today);
    const doneToday = store.allOfType('task').filter((t) => t.props.completedAt && U.dateStrFromMs(t.props.completedAt) === today);
    return { today, tasks, blocks, overdue, list, events, doneToday };
  }

  /* ---------------- render ---------------- */

  function render() {
    stopDrag();
    container.innerHTML = '';
    const d = collect();

    /* header: ring + stats */
    const total = d.blocks.length + d.list.length + d.overdue.length + d.doneToday.length;
    const ring = ui.progressRing({
      size: 46, stroke: 4.5,
      value: total ? d.doneToday.length / total : 0,
      label: `${d.doneToday.length} of ${total} done today`,
    });
    const plannedMin = d.blocks.reduce((a, t) => a + (t.props.schedule?.dur || DEFAULT_DUR), 0) +
      d.events.filter((e) => !e.props.allDay).reduce((a, e) => a + (e.props.dur || 60), 0);

    container.append(h('div', { class: 'view-head row today-head' },
      ring.el,
      h('div', { class: 'grow' },
        h('h2', { class: 'view-title' }, 'Today'),
        h('div', { class: 'view-sub muted small' },
          `${d.doneToday.length}/${total} done · ${U.fmtDuration(plannedMin)} planned of ${U.fmtDuration(DAY_AVAILABLE_MIN)} available`),
      ),
      h('button', { class: 'icon-btn accent', 'aria-label': 'Add task', onClick: () => window.__flowQuickAdd?.() }, ui.icon('plus', 22)),
    ));

    /* plan-tomorrow prompt (evening) */
    const now = new Date();
    if (store.settings.planPrompt && now.getHours() >= 18) {
      const tomorrow = U.addDays(U.todayStr(), 1);
      const tmrwCount = store.activeTasks().filter((t) => !t.parentId && store.taskDay(t) === tomorrow).length;
      if (tmrwCount < 3 && window.__flowPlanPromptDate !== U.todayStr()) {
        container.append(h('div', { class: 'banner row' },
          ui.icon('moon', 18),
          h('span', { class: 'grow small' }, tmrzCopy(tmrwCount)),
          h('button', { class: 'btn btn-sm btn-primary', onClick: () => {
            window.__flowPlanPromptDate = U.todayStr();
            location.hash = '#/upcoming';
            setTimeout(() => window.__flowQuickAdd?.('tomorrow '), 350);
          } }, 'Plan tomorrow'),
          h('button', { class: 'icon-btn', 'aria-label': 'Dismiss', onClick: (e) => {
            window.__flowPlanPromptDate = U.todayStr();
            e.currentTarget.closest('.banner').remove();
          } }, ui.icon('close', 16)),
        ));
      }
    }

    /* overdue */
    if (d.overdue.length) {
      container.append(h('div', { class: 'section-label danger-label' }, `Overdue · ${d.overdue.length}`));
      const wrap = h('div', { class: 'task-list', role: 'list' });
      for (const t of d.overdue) wrap.append(rowEl(t));
      container.append(wrap);
    }

    /* today list */
    container.append(sectionLabelWith('Today', d.list.length));
    listSectionEl = h('div', { class: 'task-list today-list drop-unschedule', role: 'list' });
    if (d.list.length) {
      for (const t of d.list) listSectionEl.append(rowEl(t));
    } else {
      listSectionEl.append(ui.emptyState({
        icon: 'sun', title: 'A clean sheet',
        body: d.blocks.length ? 'Everything is on the timeline. Drag it away to unschedule.' : 'Nothing due today. Add something, or enjoy the calm.',
        actionLabel: 'Add a task', onAction: () => window.__flowQuickAdd?.(),
      }));
    }
    container.append(listSectionEl);

    /* timeline */
    container.append(sectionLabelWith('Timeline', d.blocks.length + d.events.filter((e) => !e.props.allDay).length));
    container.append(buildTimeline(d));

    document.body.append(selection.el);
  }

  function tmrzCopy(n) {
    return n === 0 ? 'Tomorrow is wide open. Plan a few things tonight?' : `Tomorrow has only ${n} ${n === 1 ? 'task' : 'tasks'} so far. Add a few more?`;
  }
  function sectionLabelWith(text, count) {
    return h('div', { class: 'section-label row' }, text,
      h('span', { class: 'group-count muted small' }, count ? String(count) : ''));
  }

  function rowEl(t) {
    const row = ui.taskRow(t, {
      selection,
      showProject: true,
      onOpen: (b) => openTaskDetail(b.id),
      onComplete: completeWithUndo,
      onUncomplete: (b) => store.uncompleteTask(b.id),
      onSchedule: (b) => quickScheduleMenu(b.id, render),
      onDragStart: (e, b) => startDrag(e, b, 'list'),
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); taskContextMenu(t, render); });
    return row;
  }

  /* ---------------- timeline ---------------- */

  function buildTimeline(d) {
    const wrap = h('div', { class: 'tl-wrap' });

    /* all-day events */
    const allDay = d.events.filter((e) => e.props.allDay);
    if (allDay.length) {
      wrap.append(h('div', { class: 'tl-allday row' },
        ui.icon('calendar', 15),
        ...allDay.slice(0, 3).map((e) => h('span', { class: 'chip' }, e.props.title)),
        allDay.length > 3 && h('span', { class: 'chip' }, `+${allDay.length - 3}`),
      ));
    }

    const gutter = h('div', { class: 'tl-gutter', 'aria-hidden': 'true' });
    for (let hh = 0; hh <= 24; hh++) {
      gutter.append(h('div', { class: 'tl-hour-label', style: { top: `${hh * HOUR_H - 8}px` } },
        hh === 24 ? '' : U.fmtTime(hh * 60, store.settings.use24h)));
    }

    trackEl = h('div', { class: 'tl-track', role: 'list', 'aria-label': 'Today timeline' });
    trackEl.style.height = `${24 * HOUR_H}px`;

    /* now line */
    const nowMin = U.nowMinutes();
    if (nowMin < 1440) {
      trackEl.append(h('div', { class: 'tl-now', style: { top: `${(nowMin / 60) * HOUR_H}px` } },
        h('span', { class: 'tl-now-dot' }), h('span', { class: 'tl-now-label small' }, U.fmtTime(nowMin, store.settings.use24h))));
    }

    /* blocks with greedy lane packing for overlaps */
    const items = [
      ...d.events.filter((e) => !e.props.allDay).map((e) => ({ kind: 'event', block: e, start: e.props.start ?? 0, dur: e.props.dur || 60 })),
      ...d.blocks.map((t) => ({ kind: 'task', block: t, start: t.props.schedule.start, dur: t.props.schedule.dur || DEFAULT_DUR })),
    ].sort((a, b) => a.start - b.start);

    const lanes = []; // lanes[i] = end minute of last block in lane i
    const clusters = [];
    let cluster = null;
    for (const it of items) {
      if (!cluster || it.start >= cluster.end) { cluster = { end: it.start + it.dur, items: [] }; clusters.push(cluster); }
      cluster.items.push(it);
      cluster.end = Math.max(cluster.end, it.start + it.dur);
    }
    for (const cl of clusters) {
      lanes.length = 0;
      for (const it of cl.items) {
        let lane = lanes.findIndex((end) => end <= it.start);
        if (lane === -1) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = it.start + it.dur;
        it.lane = lane;
      }
      const width = cl.items.length ? Math.max(...cl.items.map((i) => i.lane)) + 1 : 1;
      for (const it of cl.items) {
        trackEl.append(blockEl(it, cl.items.length > 1 ? width : 1));
      }
    }

    wrap.append(h('div', { class: 'tl-scroll' }, gutter, trackEl));

    /* On first render, bring "now" (or 7am) into view. */
    const target = nowMin > 60 ? nowMin : 7 * 60;
    if (!scrolledOnce) {
      scrolledOnce = true;
      requestAnimationFrame(() => {
        const y = (target / 60) * HOUR_H - 120;
        container.scrollTop += y;
      });
    }

    if (nowTimer) clearInterval(nowTimer);
    nowTimer = setInterval(() => {
      const el = trackEl?.querySelector('.tl-now');
      if (el) {
        const m = U.nowMinutes();
        el.style.top = `${(m / 60) * HOUR_H}px`;
        const lbl = el.querySelector('.tl-now-label');
        if (lbl) lbl.textContent = U.fmtTime(m, store.settings.use24h);
      }
    }, 60000);

    return wrap;
  }

  function blockEl(it, laneCount) {
    const b = it.block;
    const isEvent = it.kind === 'event';
    const el = h('div', {
      class: `tl-block ${isEvent ? 'tl-event' : 'tl-task'}${it.dur < 35 ? ' tl-short' : ''}`,
      role: 'listitem',
      tabindex: '0',
      'aria-label': `${isEvent ? 'Event' : 'Task'}: ${b.props.title}, ${U.fmtTime(it.start, store.settings.use24h)} to ${U.fmtTime(it.start + it.dur, store.settings.use24h)}`,
    });
    el.style.top = `${(it.start / 60) * HOUR_H}px`;
    el.style.height = `${Math.max(20, (it.dur / 60) * HOUR_H - 2)}px`;
    const w = `calc((100% - 10px) / ${laneCount} - ${laneCount > 1 ? 4 : 0}px)`;
    el.style.width = laneCount > 1 ? w : 'calc(100% - 10px)';
    el.style.left = `calc(5px + (100% - 10px) / ${laneCount} * ${it.lane} )`;

    const pr = !isEvent && b.props.projectId ? store.get(b.props.projectId) : null;
    el.append(
      h('div', { class: 'tl-block-time small' }, `${U.fmtTime(it.start, store.settings.use24h)}`),
      h('div', { class: 'tl-block-title' }, b.props.title || 'Untitled'),
      // NOTE: el.append is native and renders `false` as text — spread
      // conditional children as arrays instead.
      ...(it.dur >= 45 ? [h('div', { class: 'tl-block-sub small' }, pr ? pr.props.name : U.fmtDuration(it.dur))] : []),
      ...(!isEvent ? [
        h('div', { class: 'tl-handle tl-handle-top', 'aria-hidden': 'true' }),
        h('div', { class: 'tl-handle tl-handle-bottom', 'aria-hidden': 'true' }),
      ] : []),
    );
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tl-handle-top')) return startDrag(e, b, 'resize-top');
      if (e.target.closest('.tl-handle-bottom')) return startDrag(e, b, 'resize-bottom');
      if (e.button !== 0) return;
      startDrag(e, b, 'block');
    });
    el.addEventListener('click', (e) => {
      if (Date.now() - lastDragEnd < 350) return; // it was a drag, not a tap
      if (isEvent) { ui.toast(`${b.props.title} — imported event`); return; }
      openTaskDetail(b.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (isEvent) {
        ui.menu([
          { label: 'Delete event', icon: 'trash', danger: true, fn: () => { store.softDelete(b.id); ui.undoToast('Event removed', () => store.restore(b.id)); render(); } },
        ], el);
        return;
      }
      ui.menu([
        { label: 'Edit time…', icon: 'clock', fn: () => openSchedulePicker(b.id, render) },
        { label: 'Unschedule', icon: 'close', fn: () => unschedule(b) },
        '---',
        { label: 'Open task', icon: 'pencil', fn: () => openTaskDetail(b.id) },
        { label: 'Complete', icon: 'check', fn: () => { completeWithUndo(b); render(); } },
      ], el);
    });
    return el;
  }

  /* ---------------- drag machinery ---------------- */

  function startDrag(e, block, source) {
    if (drag) return;
    e.preventDefault();
    drag = {
      block, source, moved: false,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      pointerId: e.pointerId,
      preview: null, lastSnap: null,
    };
    const sched = block.props.schedule;
    if (source === 'block') {
      drag.grabOffset = (e.clientY - (trackEl.getBoundingClientRect().top + (sched.start / 60) * HOUR_H));
    }
    document.addEventListener('pointermove', onDragMove, { passive: false });
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
    drag.moved = true;
    e.preventDefault();
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    updateDragPreview();
    startEdgeAutoscroll();
  }

  /** Recompute the drop target from the last pointer position. Called on
   *  pointermove AND from the auto-scroll loop — while the view scrolls under
   *  a stationary finger, the preview must keep tracking the track geometry. */
  function updateDragPreview() {
    const x = drag.lastX, y = drag.lastY;

    const trackRect = trackEl.getBoundingClientRect();
    const overTrack = x >= trackRect.left - 40 && x <= trackRect.right + 40 &&
      y >= trackRect.top - 30 && y <= trackRect.bottom + 30;
    // Dragging a block anywhere clearly ABOVE the timeline unschedules it
    // (the whole upper area acts as the drop-back zone, not just the list).
    const overList = drag.source !== 'list' && y < trackRect.top - 40;

    if (overList) {
      clearPreview();
      drag.lastSnap = { unschedule: true };
      listSectionEl.classList.add('will-drop');
      return;
    }
    listSectionEl.classList.remove('will-drop');
    if (!overTrack) { clearPreview(); drag.lastSnap = null; return; }

    let startMin, dur;
    const sched = drag.block.props.schedule;
    if (drag.source === 'list') {
      dur = sched?.dur || DEFAULT_DUR;
      startMin = snap(yToMinutes(y - trackRect.top) - dur / 2);
    } else if (drag.source === 'resize-top') {
      const end = (sched?.start ?? 0) + (sched?.dur ?? DEFAULT_DUR);
      dur = end - snap(yToMinutes(y - trackRect.top));
      if (dur < SNAP) { dur = SNAP; }
      startMin = end - dur;
    } else if (drag.source === 'resize-bottom') {
      startMin = sched?.start ?? 0;
      dur = Math.max(SNAP, snap(yToMinutes(y - trackRect.top) - startMin));
    } else { // move
      dur = sched?.dur || DEFAULT_DUR;
      startMin = snap(yToMinutes(y - trackRect.top - drag.grabOffset));
    }
    startMin = U.clamp(startMin, 0, 1440 - SNAP);
    if (startMin + dur > 1440) dur = 1440 - startMin;

    if (drag.lastSnap?.start !== startMin || drag.lastSnap?.dur !== dur) {
      U.vibrate(6);
      drag.lastSnap = { start: startMin, dur };
      showPreview(startMin, dur);
    }
  }

  /** While dragging near the viewport edges, scroll the view (and keep the
   *  preview in sync) so long drags to distant hours work. Stops when the
   *  view can't scroll any further — otherwise it would run past the track
   *  end and cancel the drag. */
  function startEdgeAutoscroll() {
    cancelAnimationFrame(rafId);
    const edge = 80;
    const step = () => {
      if (!drag) return;
      const box = container.getBoundingClientRect();
      const before = container.scrollTop;
      if (drag.lastY < box.top + edge) container.scrollTop = before - 14;
      else if (drag.lastY > box.bottom - edge) container.scrollTop = before + 14;
      if (container.scrollTop === before) return; // reached the end — stop scrolling
      updateDragPreview();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function onDragEnd() {
    if (!drag) return;
    const d = drag;
    if (d.moved) lastDragEnd = Date.now();
    stopDrag();
    if (!d.moved || !d.lastSnap) return;

    const today = U.todayStr();
    if (d.lastSnap.unschedule) {
      store.update(d.block.id, { schedule: null });
      U.vibrate(10);
      ui.toast('Unscheduled — back in the Today list');
      render();
      return;
    }
    const prev = d.block.props.schedule;
    const next = { date: today, start: d.lastSnap.start, dur: d.lastSnap.dur };
    if (prev?.date === next.date && prev?.start === next.start && prev?.dur === next.dur) return;
    store.update(d.block.id, { schedule: next });
    U.vibrate(10);
    render();
  }

  function stopDrag() {
    if (drag) {
      document.removeEventListener('pointermove', onDragMove);
      document.removeEventListener('pointerup', onDragEnd);
      document.removeEventListener('pointercancel', onDragEnd);
    }
    cancelAnimationFrame(rafId);
    clearPreview();
    listSectionEl?.classList.remove('will-drop');
    drag = null;
  }

  function snap(min) { return Math.round(min / SNAP) * SNAP; }
  function yToMinutes(y) { return (y / HOUR_H) * 60; }

  function showPreview(start, dur) {
    clearPreview();
    drag.preview = h('div', { class: 'tl-preview' },
      h('span', { class: 'small' }, `${U.fmtTime(start, store.settings.use24h)} – ${U.fmtTime(start + dur, store.settings.use24h)}`));
    drag.preview.style.top = `${(start / 60) * HOUR_H}px`;
    drag.preview.style.height = `${Math.max(20, (dur / 60) * HOUR_H - 2)}px`;
    trackEl.append(drag.preview);
    drag.preview.scrollIntoView({ block: 'nearest' });
  }
  function clearPreview() {
    drag?.preview?.remove();
    if (drag) drag.preview = null;
  }

  function unschedule(block) {
    store.update(block.id, { schedule: null });
    ui.toast('Unscheduled');
    render();
  }

  /* ---------------- bulk ---------------- */
  selection.onBulk('complete', async (ids) => {
    for (const id of ids) store.completeTask(id);
    U.vibrate([12, 30, 12]);
    ui.undoToast(`${ids.length} completed`, () => ids.forEach((id) => store.uncompleteTask(id)));
    selection.exit();
  });
  selection.onBulk('delete', async (ids) => {
    if (!await ui.confirmDialog({ title: `Delete ${ids.length} tasks?`, confirmLabel: 'Delete', danger: true })) return;
    ids.forEach((id) => store.softDelete(id));
    ui.undoToast(`${ids.length} deleted`, () => ids.forEach((id) => store.restore(id)));
    selection.exit();
  });
  selection.onBulk('date', async (ids) => {
    selection.exit();
    ui.menu(ui.scheduleMenuItems({ props: {} }, (v) => {
      if (v === 'pick') { openSchedulePicker(ids[0], render); return; }
      const today = U.todayStr();
      ids.forEach((id) => {
        const b = store.get(id);
        if (!b) return;
        store.update(id, v == null ? { schedule: null }
          : { schedule: { date: v.date || today, start: v.start ?? b.props.schedule?.start ?? null, dur: b.props.schedule?.dur ?? DEFAULT_DUR } });
      });
      render();
    }), document.activeElement || { x: 24, y: 24 });
  });
  selection.onBulk('priority', async (ids) => {
    selection.exit();
    ui.menu([1, 2, 3, 4].map((p) => ({
      label: p === 4 ? 'None' : `P${p}`, icon: 'flag',
      fn: () => ids.forEach((id) => store.update(id, { priority: p })),
    })), document.activeElement || { x: 24, y: 24 });
  });
  selection.onBulk('move', async (ids) => {
    selection.exit();
    const { pickProject } = await import('./detail.js');
    pickProject(null, (pid) => ids.forEach((id) => store.update(id, { projectId: pid })));
  });

  /* ---------------- lifecycle ---------------- */
  render();
  // Re-render on store changes. Sheets/modals live outside `container`, so
  // replacing the view under them never steals focus; the detail sheet
  // manages its own live updates and closes itself if the task disappears.
  cleanups.push(store.subscribe(() => render()), () => selection.destroy(), () => stopDrag(), () => clearInterval(nowTimer));

  return () => { cleanups.forEach((fn) => fn()); };
}

/* local alias to keep the hyperscript readable */
function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
