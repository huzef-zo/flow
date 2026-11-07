/**
 * views/habits.js — habit tracker: daily/weekly check-ins, streaks, a
 * GitHub-style heatmap, and per-habit stats. Habits and their logs are
 * ordinary blocks (habit / habitLog), so they sync like everything else.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';

const HEATMAP_WEEKS = 14;

export function renderHabits(container) {
  function render() {
    container.innerHTML = '';
    const habits = store.childrenOf('habit', null);
    const today = U.todayStr();

    container.append(h('div', { class: 'view-head row' },
      h('div', { class: 'grow' },
        h('h2', { class: 'view-title' }, 'Habits'),
        h('div', { class: 'view-sub muted small' }, 'Small loops, kept gently.'),
      ),
      h('button', { class: 'icon-btn accent', 'aria-label': 'New habit', onClick: () => newHabitSheet() }, ui.icon('plus', 22)),
    ));

    if (!habits.length) {
      container.append(ui.emptyState({
        icon: 'flame',
        title: 'Build a gentle loop',
        body: 'Track daily habits like “Drink water” or a weekly ritual like “Weekly review”.',
        actionLabel: 'New habit', onAction: () => newHabitSheet(),
      }));
      return;
    }

    for (const habit of habits) {
      container.append(habitCard(habit, today));
    }
  }

  function habitCard(habit, today) {
    const cadence = habit.props.cadence === 'weekly' ? 'weekly' : 'daily';
    const streak = store.habitStreak(habit);
    const doneToday = cadence === 'daily' ? store.habitDoneOn(habit.id, today) : weekDone(habit, today);

    const check = h('button', {
      class: 'habit-check' + (doneToday ? ' done' : ''),
      'aria-label': doneToday ? `Mark ${habit.props.name} as not done` : `Mark ${habit.props.name} as done`,
      'aria-pressed': String(doneToday),
      onClick: () => {
        if (cadence === 'daily') {
          store.toggleHabit(habit.id, today);
        } else {
          // weekly: check today as the representative day of this week
          store.toggleHabit(habit.id, today);
        }
        U.vibrate(12);
        render();
      },
    }, ui.icon('check', 24));

    const weekStrip = h('div', { class: 'habit-week' });
    const days = [];
    if (cadence === 'daily') {
      for (let i = 6; i >= 0; i--) days.push(U.addDays(today, -i));
      for (const d of days) {
        const done = store.habitDoneOn(habit.id, d);
        weekStrip.append(h('span', {
          class: 'habit-day' + (done ? ' done' : '') + (d === today ? ' today' : ''),
          title: `${U.fmtDateWithWeekday(d)}${done ? ' · done' : ''}`,
        }, U.weekdayShort(d).slice(0, 1)));
      }
    } else {
      for (let i = 6; i >= 0; i--) {
        const ws = U.weekStartOf(U.addDays(today, -i * 7), store.settings.weekStart);
        const done = [...Array(7).keys()].some((k) => store.habitDoneOn(habit.id, U.addDays(ws, k)));
        weekStrip.append(h('span', {
          class: 'habit-day' + (done ? ' done' : '') + (i === 0 ? ' today' : ''),
          title: `Week of ${U.fmtDate(ws)}`,
        }, 'W'));
      }
    }

    const card = h('div', { class: 'habit-card' },
      h('div', { class: 'row' },
        check,
        h('div', { class: 'grow' },
          h('div', { class: 'habit-name' }, habit.props.name),
          h('div', { class: 'muted small' }, cadence === 'daily' ? 'Every day' : 'Every week'),
        ),
        streak > 0 && h('span', { class: 'habit-streak', title: `${streak}-day streak` }, ui.icon('flame', 16), String(streak)),
        h('button', { class: 'icon-btn', 'aria-label': 'Habit options', onClick: (e) => {
          ui.menu([
            { label: 'Rename', icon: 'pencil', fn: () => renameHabit(habit) },
            { label: 'Delete habit', icon: 'trash', danger: true, fn: async () => {
              if (await ui.confirmDialog({ title: 'Delete habit?', message: 'Its history will be removed too.', confirmLabel: 'Delete', danger: true })) {
                store.softDelete(habit.id);
                for (const b of store.allBlocks(true)) if (b.type === 'habitLog' && b.id.startsWith(habit.id + ':')) store.softDelete(b.id);
                render();
              }
            } },
          ], e.currentTarget);
        } }, ui.icon('dots', 18)),
      ),
      weekStrip,
    );

    /* heatmap (expandable) */
    const details = h('details', { class: 'habit-details' },
      h('summary', { class: 'small muted' }, 'Show history'),
      h('div', {}, heatmap(habit, cadence), statsLine(habit)),
    );
    card.append(details);
    return card;
  }

  function weekDone(habit, today) {
    const ws = U.weekStartOf(today, store.settings.weekStart);
    return [...Array(7).keys()].some((k) => store.habitDoneOn(habit.id, U.addDays(ws, k)));
  }

  function heatmap(habit, cadence) {
    const today = U.todayStr();
    const endWeek = U.weekStartOf(today, store.settings.weekStart);
    const grid = h('div', { class: 'heatmap', role: 'img', 'aria-label': `${habit.props.name} history` });
    for (let w = HEATMAP_WEEKS - 1; w >= 0; w--) {
      const col = h('div', { class: 'heat-col' });
      for (let dd = 0; dd < 7; dd++) {
        const date = U.addDays(endWeek, -w * 7 + dd);
        const future = date > today;
        const done = store.habitDoneOn(habit.id, date);
        col.append(h('span', {
          class: 'heat-cell' + (done ? ' hot' : '') + (future ? ' future' : ''),
          title: `${U.fmtDateWithWeekday(date)}${done ? ' · done' : ''}`,
        }));
      }
      grid.append(col);
    }
    void cadence;
    return grid;
  }

  function statsLine(habit) {
    let total = 0, best = 0, cur = 0;
    const today = U.todayStr();
    for (let i = 365; i >= 0; i--) {
      const d = U.addDays(today, -i);
      const done = store.habitDoneOn(habit.id, d);
      if (done) { total++; cur++; best = Math.max(best, cur); } else if (d !== today) cur = 0;
    }
    return h('div', { class: 'muted small', style: 'margin-top:8px' },
      `${total} check-ins this year · best streak ${best}`);
  }

  function newHabitSheet() {
    const name = h('input', { class: 'input', placeholder: 'e.g. Drink water', 'aria-label': 'Habit name' });
    const cadence = ui.seg([{ label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }], 'daily', () => {});
    const content = h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Cadence'), cadence.el),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn btn-primary', onClick: () => {
          if (!name.value.trim()) return name.focus();
          store.create({ type: 'habit', props: { name: name.value.trim(), cadence: cadence.el.querySelector('.active')?.textContent === 'Weekly' ? 'weekly' : 'daily' } });
          sheet.close();
          render();
        } }, 'Create'),
      ),
    );
    const sheet = ui.openSheet({ title: 'New habit', content });
    name.focus();
  }

  function renameHabit(habit) {
    const name = prompt('New name', habit.props.name); // eslint-disable-line no-alert
    if (name?.trim()) store.update(habit.id, { name: name.trim() });
    render();
  }

  render();
  const unsub = store.subscribe(render);
  return () => unsub();
}

function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
