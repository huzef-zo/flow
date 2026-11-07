/**
 * views/list.js — one generic list renderer behind Inbox, Anytime, Someday,
 * Logbook, Project, Area, Label and Smart-list views.
 *
 * Lists over VIRTUALIZE_THRESHOLD rows switch to windowed rendering
 * (ui.VirtualScroller) so 1,000+ tasks stay smooth.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';
import { openTaskDetail, taskContextMenu, completeWithUndo, deleteTask, quickScheduleMenu, pickProject, priorityMenu } from './detail.js';

const VIRTUALIZE_THRESHOLD = 200;
const ROW_H = 66;      // uniform task row height (2-line title + meta)
const GROUP_H = 44;    // group header height

/* sort preference per view (in-memory is plenty) */
const sortPrefs = new Map();

export function renderList(container, spec, params = {}) {
  const sortKey = sortPrefs.get(spec.key) || spec.sort || 'manual';
  const state = { sort: sortKey };
  const selection = ui.createSelection({ onChange: () => render() });
  let scroller = null;

  function tasksFor() {
    let tasks = store.activeTasks().filter((t) => !t.deletedAt && spec.match(t, params));
    if (state.sort === 'due') {
      tasks.sort((a, b) => String(store.taskDay(a) ?? '9999').localeCompare(String(store.taskDay(b) ?? '9999')) || a.createdAt - b.createdAt);
    } else if (state.sort === 'priority') {
      tasks.sort((a, b) => (a.props.priority ?? 4) - (b.props.priority ?? 4) || U.FI.cmp(a.order, b.order));
    } else if (state.sort === 'title') {
      tasks.sort((a, b) => (a.props.title || '').localeCompare(b.props.title || ''));
    } else if (state.sort === 'completed') {
      tasks.sort((a, b) => (b.props.completedAt || 0) - (a.props.completedAt || 0));
    } else {
      tasks.sort((a, b) => U.FI.cmp(a.order, b.order) || a.createdAt - b.createdAt);
    }
    return tasks;
  }

  function groups(tasks) {
    if (spec.key === 'logbook') {
      const byDay = new Map();
      for (const t of tasks) {
        const day = U.dateStrFromMs(t.props.completedAt || t.createdAt);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(t);
      }
      return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, list]) => ({ key: day, title: U.dayLabel(day), tasks: list }));
    }
    if (spec.groupBy) {
      const byGroup = new Map();
      for (const t of tasks) {
        const key = spec.groupBy(t) ?? '__none';
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key).push(t);
      }
      return [...byGroup.entries()].map(([key, list]) => ({ key, title: spec.groupTitle ? spec.groupTitle(key, list) : key, tasks: list }));
    }
    return [{ key: '__all', title: null, tasks }];
  }

  function render() {
    selection.el.remove();
    document.body.append(selection.el);
    container.innerHTML = '';

    const tasks = tasksFor();
    const allGroups = groups(tasks);

    /* --- header --- */
    const SORTS = [['Manual order', 'manual'], ['Date', 'due'], ['Priority', 'priority'], ['Title', 'title']];
    const sortMenuBtn = h('button', { class: 'icon-btn', 'aria-label': 'Sort options', title: 'Sort', onClick: (e) => {
      ui.menu(SORTS.map(([label, key]) => ({
        label, icon: 'sort', fn: () => { setSort(key); },
      })), e.currentTarget);
    } }, ui.icon('sort', 20));

    const addBtn = h('button', { class: 'icon-btn accent', 'aria-label': 'Add task', onClick: () => window.__flowQuickAdd?.(spec.addPrefill?.() || '') }, ui.icon('plus', 22));
    container.append(h('div', { class: 'view-head row' },
      h('div', { class: 'grow' },
        h('h2', { class: 'view-title' }, spec.title(params)),
        h('div', { class: 'view-sub muted small' }, subtitle(tasks)),
      ),
      sortMenuBtn, addBtn,
    ));

    /* --- empty state --- */
    if (!tasks.length) {
      container.append(ui.emptyState({
        icon: spec.emptyIcon || 'sun',
        title: spec.emptyTitle || 'All clear',
        body: spec.emptyBody || 'Nothing here right now.',
        actionLabel: spec.emptyActionLabel || null,
        onAction: spec.emptyAction || null,
      }));
      return;
    }

    /* --- rows (plain or windowed) --- */
    const flat = [];
    for (const g of allGroups) {
      if (g.title != null || allGroups.length > 1) {
        flat.push({ kind: 'group', key: 'g:' + g.key, h: GROUP_H, title: g.title ?? '', count: g.tasks.length });
      }
      for (const t of g.tasks) flat.push({ kind: 'task', key: t.id, h: ROW_H, block: t });
    }

    const buildRow = (item) => item.kind === 'group' ? groupHeader(item) : row(item.block);

    if (flat.length > VIRTUALIZE_THRESHOLD) {
      scroller = new ui.VirtualScroller(container, { renderItem: buildRow });
      scroller.setItems(flat);
    } else {
      const list = h('div', { class: 'task-list', role: 'list' });
      for (const item of flat) list.append(buildRow(item));
      container.append(list);
    }

    if (spec.footerNote) container.append(h('div', { class: 'view-foot muted small' }, spec.footerNote(tasks)));
  }

  function setSort(key) { state.sort = key; sortPrefs.set(spec.key, key); render(); }

  function groupHeader(item) {
    return h('div', { class: 'group-head' },
      h('span', { class: 'group-title' }, item.title),
      h('span', { class: 'group-count muted small' }, String(item.count)),
    );
  }

  function row(block) {
    const r = ui.taskRow(block, {
      showProject: spec.showProject !== false,
      selection,
      onOpen: (b) => openTaskDetail(b.id),
      onComplete: (b) => completeWithUndo(b),
      onUncomplete: (b) => { store.uncompleteTask(b.id); ui.toast('Task reopened'); },
      onSchedule: (b) => quickScheduleMenu(b.id, render),
    });
    r.addEventListener('contextmenu', (e) => { e.preventDefault(); taskContextMenu(block, render); });
    return r;
  }

  /* --- bulk actions --- */
  selection.onBulk('complete', async (ids) => {
    for (const id of ids) store.completeTask(id);
    U.vibrate([12, 30, 12]);
    ui.undoToast(`${ids.length} completed`, () => ids.forEach((id) => store.uncompleteTask(id)));
    selection.exit();
  });
  selection.onBulk('delete', async (ids) => {
    const ok = await ui.confirmDialog({ title: `Delete ${ids.length} tasks?`, message: 'You can undo right after.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    ids.forEach((id) => store.softDelete(id));
    ui.undoToast(`${ids.length} deleted`, () => ids.forEach((id) => store.restore(id)));
    selection.exit();
  });
  selection.onBulk('date', async (ids) => {
    selection.exit();
    ui.menu(ui.scheduleMenuItems({ props: {} }, (v) => {
      if (v === 'pick') {
        // reuse picker on first task
        const id = ids[0];
        import('./detail.js').then(({ openSchedulePicker }) => openSchedulePicker(id, render));
        return;
      }
      for (const id of ids) {
        const b = store.get(id);
        if (!b) continue;
        store.update(id, v == null ? { schedule: null, dueDate: null }
          : { schedule: { date: v.date, start: v.start ?? b.props.schedule?.start ?? null, dur: b.props.schedule?.dur ?? 30 } });
      }
      render();
    }), document.activeElement || { x: 24, y: 24 });
  });
  selection.onBulk('priority', async (ids) => {
    selection.exit();
    priorityBulk(ids);
  });
  selection.onBulk('move', async (ids) => {
    selection.exit();
    pickProject(null, (pid) => {
      ids.forEach((id) => store.update(id, { projectId: pid }));
      render();
    });
  });

  function priorityBulk(ids) {
    ui.menu([1, 2, 3, 4].map((p) => ({
      label: p === 4 ? 'None' : `P${p}`, icon: 'flag',
      fn: () => { ids.forEach((id) => store.update(id, { priority: p })); render(); },
    })), document.activeElement || { x: 24, y: 24 });
  }

  render();
  return () => { selection.destroy(); scroller?.destroy(); };
}

function subtitle(tasks) {
  const done = tasks.filter((t) => t.props.completedAt).length;
  const s = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
  return done ? `${s} · ${done} done` : s;
}

/* ================================================================== *
 * Route specs
 * ================================================================== */

const isTop = (t) => !t.parentId;
const started = (t) => store.isStarted(t);

export function renderInbox(container) {
  return renderList(container, {
    key: 'inbox', title: () => 'Inbox',
    match: (t) => isTop(t) && !t.props.projectId && !t.props.completedAt,
    emptyIcon: 'inbox', emptyTitle: 'Inbox zero',
    emptyBody: 'Everything you capture lands here first. Tap + and just type — try “Call mom tomorrow 5pm p2”.',
    emptyActionLabel: 'Add a task', emptyAction: () => window.__flowQuickAdd?.(),
    sort: 'manual', showProject: false,
  });
}

export function renderAnytime(container) {
  return renderList(container, {
    key: 'anytime', title: () => 'Anytime',
    match: (t) => isTop(t) && !t.props.completedAt && !t.props.someday && started(t) &&
      (!store.taskDay(t) || store.taskDay(t) <= U.todayStr()),
    groupBy: (t) => t.props.projectId || '__inbox',
    groupTitle: (key) => key === '__inbox' ? 'Inbox' : (store.get(key)?.props.name || 'Project'),
    emptyIcon: 'layers', emptyTitle: 'Nothing to do right now',
    emptyBody: 'Undated tasks you can start anytime will appear here.',
    sort: 'manual',
  });
}

export function renderSomeday(container) {
  return renderList(container, {
    key: 'someday', title: () => 'Someday',
    match: (t) => isTop(t) && !t.props.completedAt && t.props.someday,
    groupBy: (t) => t.props.projectId || '__inbox',
    groupTitle: (key) => key === '__inbox' ? 'Inbox' : (store.get(key)?.props.name || 'Project'),
    emptyIcon: 'someday', emptyTitle: 'No “someday” ideas yet',
    emptyBody: 'Type “someday” in quick add to park a task here without pressure.',
    sort: 'manual',
  });
}

export function renderLogbook(container) {
  return renderList(container, {
    key: 'logbook', title: () => 'Logbook',
    match: (t) => !!t.props.completedAt,
    emptyIcon: 'archive', emptyTitle: 'Nothing completed yet',
    emptyBody: 'Completed tasks live here, grouped by day — with undo.',
    sort: 'completed',
  });
}

export function renderProject(container, params) {
  const project = store.get(params.id);
  if (!project) { container.append(ui.emptyState({ icon: 'folder', title: 'Project not found', body: 'It may have been deleted.' })); return; }
  return renderList(container, {
    key: 'project:' + params.id,
    title: () => project.props.name,
    match: (t) => isTop(t) && !t.props.completedAt && t.props.projectId === params.id,
    emptyIcon: 'folder', emptyTitle: 'No tasks in this project',
    emptyBody: 'Add the first one — or capture into Inbox and move it later.',
    emptyActionLabel: 'Add task', emptyAction: () => window.__flowQuickAdd?.(`#${project.props.name} `),
    sort: 'manual', showProject: false,
    addPrefill: () => `#${project.props.name} `,
  });
}

export function renderArea(container, params) {
  const area = store.get(params.id);
  if (!area) { container.append(ui.emptyState({ icon: 'box', title: 'Area not found' })); return; }
  const projects = store.childrenOf('project', area.id);
  const wrap = h('div', {});
  container.append(wrap);
  const cleanupFns = projects.map((p) => renderProject(wrap, { id: p.id }));
  if (!projects.length) {
    container.prepend(h('div', { class: 'view-head row' }, h('div', { class: 'grow' }, h('h2', { class: 'view-title' }, area.props.name))));
    container.append(ui.emptyState({
      icon: 'box', title: 'No projects in this area',
      body: 'Create one from Browse → Projects.',
      actionLabel: 'New project', onAction: () => {
        const name = prompt('Project name'); // eslint-disable-line no-alert
        if (name?.trim()) store.create({ type: 'project', props: { name: name.trim() }, parentId: area.id });
      },
    }));
    return;
  }
  return () => cleanupFns.forEach((fn) => fn?.());
}

export function renderLabel(container, params) {
  const label = store.get(params.id);
  if (!label) { container.append(ui.emptyState({ icon: 'tag', title: 'Label not found' })); return; }
  return renderList(container, {
    key: 'label:' + params.id,
    title: () => '@' + label.props.name,
    match: (t) => isTop(t) && !t.props.completedAt && (t.props.labels || []).includes(params.id),
    emptyIcon: 'tag', emptyTitle: 'No tasks with this label',
    emptyBody: 'Add @' + label.props.name + ' in quick add to tag tasks.',
    sort: 'due',
  });
}

export function renderSmart(container, params) {
  const smart = store.get(params.id);
  if (!smart) { container.append(ui.emptyState({ icon: 'sparkle', title: 'Smart list not found' })); return; }
  const filter = smart.props.filter || {};
  return renderList(container, {
    key: 'smart:' + params.id,
    title: () => smart.props.name,
    match: (t) => isTop(t) && !t.props.completedAt && store.matchesSmartFilter(t, filter),
    emptyIcon: 'sparkle', emptyTitle: 'Nothing matches',
    emptyBody: 'This is a saved filter — edit it from Browse → Smart lists.',
    sort: 'due',
  });
}

/* local alias to keep the hyperscript readable */
function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
