/**
 * views/upcoming.js — day-by-day plan for the next two weeks, plus a
 * "Later" bucket and imported calendar events. Each day group is
 * collapsible; the day header shows planned minutes.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';
import { openTaskDetail, completeWithUndo, quickScheduleMenu, taskContextMenu } from './detail.js';

const DAYS = 14;

export function renderUpcoming(container, params = {}) {
  const collapsed = new Set();
  let cleanup = null;

  function render() {
    cleanup?.();
    container.innerHTML = '';
    const today = U.todayStr();
    const selection = ui.createSelection({ onChange: () => render() });

    container.append(h('div', { class: 'view-head row' },
      h('div', { class: 'grow' },
        h('h2', { class: 'view-title' }, 'Upcoming'),
        h('div', { class: 'view-sub muted small' }, 'Next two weeks'),
      ),
      h('button', { class: 'icon-btn', 'aria-label': 'Import calendar', title: 'Import .ics calendar', onClick: () => window.__flowImportICS?.() }, ui.icon('upload', 20)),
      h('button', { class: 'icon-btn accent', 'aria-label': 'Add task', onClick: () => window.__flowQuickAdd?.() }, ui.icon('plus', 22)),
    ));

    let total = 0;
    for (let i = 0; i < DAYS; i++) {
      const date = U.addDays(today, i);
      const tasks = store.activeTasks().filter((t) => !t.parentId && !t.props.completedAt && store.taskDay(t) === date);
      const events = store.allOfType('event').filter((e) => e.props.date === date);
      const hidden = store.settings.hideUntilStart ? tasks.filter((t) => t.props.startDate && t.props.startDate > today) : [];
      const visible = tasks.filter((t) => !hidden.includes(t));
      total += visible.length;

      const group = dayGroup(date, visible, events, hidden.length, selection);
      container.append(group);
    }

    /* --- Later --- */
    const laterDay = U.addDays(today, DAYS);
    const later = store.activeTasks().filter((t) => !t.parentId && !t.props.completedAt &&
      !t.props.someday && store.taskDay(t) && store.taskDay(t) >= laterDay);
    if (later.length) {
      const g = h('div', { class: 'day-group' },
        h('button', { class: 'day-head row', onClick: (e) => toggleCollapse('later', e) },
          h('span', { class: 'day-name' }, 'Later'),
          h('span', { class: 'group-count muted small' }, String(later.length)),
          ui.icon('chevronDown', 18),
        ),
        h('div', { class: 'day-tasks' },
          ...later.slice(0, 30).map((t) => taskRowEl(t, selection)),
          later.length > 30 && h('div', { class: 'muted small', style: 'padding:8px 4px' }, `+${later.length - 30} more`),
        ),
      );
      container.append(g);
    }

    if (total === 0) {
      container.append(ui.emptyState({
        icon: 'calendar',
        title: 'Clear horizon',
        body: 'Nothing scheduled for the next two weeks. Quick add “friday” or “in 3 weeks” to plan ahead.',
        actionLabel: 'Plan a task', onAction: () => window.__flowQuickAdd?.(),
      }));
    }
    document.body.append(selection.el);

    cleanup = () => { selection.destroy(); };
    void collapsed;
  }

  function toggleCollapse(key, e) {
    const head = e.currentTarget;
    const body = head.nextElementSibling;
    const isCollapsed = body.classList.toggle('collapsed');
    head.querySelector('svg:last-child')?.rotate;
    head.setAttribute('aria-expanded', String(!isCollapsed));
    if (isCollapsed) collapsed.add(key); else collapsed.delete(key);
  }

  function dayGroup(date, tasks, events, hiddenCount, selection) {
    const body = h('div', { class: 'day-tasks' });
    if (collapsed.has(date)) body.classList.add('collapsed');

    const plannedMin = tasks.reduce((a, t) => a + (t.props.schedule?.dur || 0), 0) +
      events.reduce((a, e) => a + (e.props.allDay ? 0 : e.props.dur || 60), 0);

    for (const ev of events) body.append(eventRow(ev));
    for (const t of tasks) body.append(taskRowEl(t, selection));
    if (hiddenCount) body.append(h('div', { class: 'muted small', style: 'padding:4px 10px' }, `${hiddenCount} hidden until their start date`));
    if (!tasks.length && !events.length && !hiddenCount) {
      body.append(h('div', { class: 'muted small day-empty' }, 'Nothing planned'));
    }
    body.append(h('button', { class: 'day-add small', onClick: () => window.__flowQuickAdd?.() }, ui.icon('plus', 14), 'Add'));

    const head = h('button', { class: 'day-head row', 'aria-expanded': String(!collapsed.has(date)), onClick: (e) => toggleCollapse(date, e) },
      h('span', { class: 'day-name' }, U.dayLabel(date)),
      h('span', { class: 'day-date muted small' }, U.fmtDateWithWeekday(date) === U.dayLabel(date) ? '' : U.weekdayShort(date)),
      plannedMin > 0 && h('span', { class: 'chip chip-time' }, U.fmtDuration(plannedMin)),
      h('span', { class: 'grow' }),
      h('span', { class: 'group-count muted small' }, String(tasks.length + events.length || '')),
      ui.icon('chevronDown', 18),
    );
    return h('div', { class: 'day-group' + (date === U.todayStr() ? ' is-today' : '') }, head, body);
  }

  function taskRowEl(t, selection) {
    const row = ui.taskRow(t, {
      selection,
      onOpen: (b) => openTaskDetail(b.id),
      onComplete: completeWithUndo,
      onUncomplete: (b) => store.uncompleteTask(b.id),
      onSchedule: (b) => quickScheduleMenu(b.id, render),
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); taskContextMenu(t, render); });
    return row;
  }

  function eventRow(ev) {
    return h('div', { class: 'task-row event-row' },
      h('div', { class: 'tr-inner' },
        h('span', { class: 'ev-icon' }, ui.icon('calendar', 18)),
        h('div', { class: 'tr-main' },
          h('div', { class: 'tr-title' }, ev.props.title),
          h('div', { class: 'tr-meta' },
            ev.props.allDay
              ? h('span', { class: 'chip' }, 'All day')
              : h('span', { class: 'chip chip-time' }, `${U.fmtTime(ev.props.start, store.settings.use24h)} · ${U.fmtDuration(ev.props.dur)}`),
            ev.props.location && h('span', { class: 'chip' }, ev.props.location),
          ),
        ),
      ),
    );
  }

  render();
  // Deep-link: #/upcoming?expand=<date> opens a specific day (used by the
  // "plan tomorrow" prompt).
  if (params.expand) {
    const head = [...container.querySelectorAll('.day-head')].find((el) => el.textContent.includes(U.dayLabel(params.expand)));
    head?.scrollIntoView({ block: 'center' });
  }
  return () => cleanup?.();
}

/* local alias to keep the hyperscript readable */
function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
