/**
 * views/palette.js — command palette / instant search (Ctrl/Cmd+K, the
 * header search icon, or "/"). Searches tasks (title + notes), projects,
 * areas, labels and habits as you type, plus app commands. Full keyboard
 * support: ↑/↓ move, Enter runs, Esc closes.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';
import { openTaskDetail } from './detail.js';

export function openPalette() {
  let activeIndex = 0;
  let results = [];

  const input = h('input', {
    class: 'input palette-input', placeholder: 'Search tasks, projects, labels… or type a command',
    'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const content = h('div', {}, input, list);

  const sheet = ui.openSheet({ title: 'Search & commands', content, className: 'palette-sheet' });
  input.focus();

  const commands = () => [
    { icon: 'plus', label: 'New task', hint: 'Quick add', run: () => window.__flowQuickAdd?.() },
    { icon: 'sun', label: 'Go to Today', hint: 'View', run: () => go('#/today') },
    { icon: 'inbox', label: 'Go to Inbox', hint: 'View', run: () => go('#/inbox') },
    { icon: 'calendar', label: 'Go to Upcoming', hint: 'View', run: () => go('#/upcoming') },
    { icon: 'layers', label: 'Go to Anytime', hint: 'View', run: () => go('#/anytime') },
    { icon: 'someday', label: 'Go to Someday', hint: 'View', run: () => go('#/someday') },
    { icon: 'archive', label: 'Go to Logbook', hint: 'View', run: () => go('#/logbook') },
    { icon: 'grid', label: 'Eisenhower matrix', hint: 'Tool', run: () => go('#/matrix') },
    { icon: 'flame', label: 'Habits', hint: 'Tool', run: () => go('#/habits') },
    { icon: 'timer', label: 'Focus timer', hint: 'Tool', run: () => go('#/focus') },
    { icon: 'settings', label: 'Settings', hint: 'View', run: () => go('#/settings') },
    { icon: 'moon', label: 'Toggle theme', hint: 'Command', run: () => {
      const cur = store.settings.theme;
      window.__flowApplyTheme?.(cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
    } },
    { icon: 'download', label: 'Export data (JSON)', hint: 'Command', run: () => window.__flowExportJSON?.() },
    { icon: 'upload', label: 'Import calendar (.ics)', hint: 'Command', run: () => window.__flowImportICS?.() },
    { icon: 'help', label: 'Keyboard shortcuts', hint: 'Help', run: () => window.__flowShortcuts?.() },
  ];

  function go(hash) { location.hash = hash; sheet.close(); }

  function search(q) {
    q = q.trim().toLowerCase();
    const out = [];
    if (!q) return commands().slice(0, 8);
    for (const c of commands()) {
      if (c.label.toLowerCase().includes(q)) out.push({ icon: c.icon, label: c.label, hint: c.hint, run: c.run });
    }
    const s = store.searchAll(q, 10);
    for (const p of s.projects) out.push({ icon: p.type === 'area' ? 'box' : 'folder', label: p.props.name, hint: p.type, run: () => go(`#/${p.type}/${p.id}`) });
    for (const l of s.labels) out.push({ icon: 'tag', label: '@' + l.props.name, hint: 'Label', run: () => go(`#/label/${l.id}`) });
    for (const hb of s.habits) out.push({ icon: 'flame', label: hb.props.name, hint: 'Habit', run: () => go('#/habits') });
    for (const t of s.tasks) {
      const day = store.taskDay(t);
      out.push({
        icon: 'check', label: t.props.title,
        hint: [day ? U.dayLabel(day) : null, t.props.priority && t.props.priority < 4 ? `P${t.props.priority}` : null].filter(Boolean).join(' · ') || 'Task',
        run: () => { sheet.close(); openTaskDetail(t.id); },
      });
    }
    return out.slice(0, 24);
  }

  function renderList() {
    results = search(input.value);
    activeIndex = U.clamp(activeIndex, 0, Math.max(0, results.length - 1));
    list.innerHTML = '';
    if (!results.length) {
      list.append(h('div', { class: 'empty-state', style: 'padding:28px' },
        h('div', { class: 'empty-title' }, 'No matches'),
        h('div', { class: 'empty-body small' }, 'Try fewer words — or press Esc and capture it with +')));
      return;
    }
    results.forEach((r, i) => {
      list.append(h('button', {
        class: 'palette-item' + (i === activeIndex ? ' active' : ''), role: 'option',
        'aria-selected': String(i === activeIndex),
        onClick: () => { sheet.close(); r.run(); },
        onPointerenter: () => { activeIndex = i; markActive(); },
      },
        ui.icon(r.icon, 18),
        h('span', { class: 'palette-label' }, r.label),
        h('span', { class: 'palette-hint muted small' }, r.hint),
      ));
    });
  }
  function markActive() {
    [...list.children].forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      el.setAttribute('aria-selected', String(i === activeIndex));
    });
    list.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => { activeIndex = 0; renderList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, results.length - 1); markActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); markActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[activeIndex]; if (r) { sheet.close(); r.run(); } }
    else if (e.key === 'Home') { activeIndex = 0; markActive(); }
    else if (e.key === 'End') { activeIndex = results.length - 1; markActive(); }
  });

  renderList();
  return sheet;
}

function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
