/**
 * views/detail.js — task detail sheet + shared pickers (project, labels,
 * schedule, priority) used by every other view.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';

const PRIORITIES = [
  { value: 1, label: 'P1 · High' },
  { value: 2, label: 'P2 · Medium' },
  { value: 3, label: 'P3 · Low' },
  { value: 4, label: 'None' },
];

/* ================================================================== *
 * Task detail sheet
 * ================================================================== */

export function openTaskDetail(id, { focusField = null } = {}) {
  let block = store.get(id);
  if (!block) return;
  let notesPreview = false;
  let customRecOpen = false;

  const content = h('div', { class: 'detail' });
  const sheet = ui.openSheet({
    title: 'Task',
    content,
    onClose: () => cleanup(),
  });

  const unsub = store.subscribe(() => {
    // Keep alive across sync merges; rebuild only when not editing.
    const fresh = store.get(id);
    if (!fresh || fresh.deletedAt) { sheet.close(); return; }
    if (document.activeElement && content.contains(document.activeElement)) return;
    block = fresh;
    render();
  });
  const cleanup = () => unsub();

  const save = (patch) => {
    block = store.update(id, patch) || block;
  };
  const debouncedSave = U.debounce((patch) => save(patch), 250);

  function render() {
    block = store.get(id) || block;
    const t = block.props;
    content.innerHTML = '';

    /* --- header bar: focus indicator + complete pill --- */
    const completeBtn = h('button', {
      class: 'btn ' + (t.completedAt ? '' : 'btn-primary') + ' detail-complete-btn',
      onClick: () => {
        if (t.completedAt) {
          store.uncompleteTask(id);
          ui.toast('Task reopened');
        } else {
          const { spawnedId } = store.completeTask(id);
          U.vibrate(14);
          ui.undoToast(spawnedId ? 'Completed — next occurrence scheduled' : 'Task completed', () => {
            store.uncompleteTask(id);
            if (spawnedId) store.softDelete(spawnedId);
          });
        }
        render();
      },
    }, icon('check', 16), t.completedAt ? 'Reopen' : 'Mark Complete');

    const focusIndicator = h('div', { class: 'detail-focus-tag' },
      icon('sparkle', 14),
      h('span', {}, 'Focus Task'),
    );

    /* --- title with stationery look --- */
    const titleInput = h('textarea', {
      class: 'detail-title-input', rows: '1', placeholder: 'What needs doing?',
      'aria-label': 'Task title',
    });
    titleInput.value = t.title || '';
    autoGrow(titleInput);
    titleInput.addEventListener('input', () => {
      autoGrow(titleInput);
      debouncedSave({ title: titleInput.value });
    });

    const titleSub = h('div', { class: 'detail-title-sub' },
      icon('pencil', 13),
      h('span', {}, 'Click title to edit · Auto-saved'),
    );

    content.append(
      h('div', { class: 'detail-head-bar' }, focusIndicator, completeBtn),
      h('div', { class: 'detail-title-wrap' }, titleInput, titleSub),
    );

    /* --- quick chips row --- */
    const chips = h('div', { class: 'row detail-chips' });
    chips.append(chipBtn('calendar', whenLabel(t), () => quickScheduleMenu(id, render)));
    chips.append(chipBtn('flag', PRIORITIES.find((p) => p.value === (t.priority ?? 4))?.label ?? 'None', () => priorityMenu(id, render)));
    const project = t.projectId ? store.get(t.projectId) : null;
    chips.append(chipBtn('folder', project ? project.props.name : 'Inbox', () => pickProject(t.projectId, (pid) => { save({ projectId: pid }); render(); })));
    const labels = (t.labels || []).map((l) => store.get(l)?.props.name).filter(Boolean);
    chips.append(chipBtn('tag', labels.length ? labels.join(', ') : 'Labels', () => pickLabelsSheet(t.labels || [], (ids) => { save({ labels: ids }); render(); })));
    if (t.recurrence) chips.append(chipBtn('repeat', store.describeRule(t.recurrence), () => render()));
    content.append(chips);

    /* --- When section --- */
    const when = h('div', { class: 'detail-section' }, h('div', { class: 'detail-section-title' }, 'When'));
    const sched = t.schedule;
    when.append(
      dateField('Planned day', sched?.date || null, (v) => {
        const next = v ? { date: v, start: sched?.start ?? null, dur: sched?.dur ?? 30 } : null;
        save({ schedule: next, dueDate: t.dueDate && !v ? null : t.dueDate });
        render();
      }),
      sched?.date && timeField('Start time', sched?.start, (v) => {
        save({ schedule: { ...sched, start: v } });
        render();
      }),
      sched?.start != null && numberField('Duration (min)', sched.dur || 30, 15, 720, 15, (v) => save({ schedule: { ...sched, dur: v } })),
      dateField('Start date (hidden until)', t.startDate, (v) => save({ startDate: v })),
      dateField('Due date', t.dueDate, (v) => save({ dueDate: v })),
      t.dueDate && timeField('Due time', U.parseClock(t.dueTime || '') ?? null, (v) => save({ dueTime: v == null ? null : U.timeStr(v) })),
      timeField('Reminder', U.parseClock(t.reminder || '') ?? null, (v) => save({ reminder: v == null ? null : U.timeStr(v) })),
      somedayToggle(id, t.someday, render),
    );
    when.append(recurrenceEditor(id, t.recurrence));
    content.append(when);

    /* --- Notes --- */
    const notesWrap = h('div', { class: 'detail-section' }, h('div', { class: 'detail-section-title row' }, 'Notes', h('span', { class: 'grow' }),
      h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { notesPreview = !notesPreview; render(); } }, notesPreview ? 'Edit' : 'Preview')));
    if (notesPreview) {
      const md = ui.markdown(t.notes || '', (i) => save({ notes: U.toggleMdCheckbox(t.notes || '', i) }));
      if (!t.notes) md.append(h('div', { class: 'muted small' }, 'Nothing to preview yet.'));
      notesWrap.append(h('div', { class: 'detail-notes-preview' }, md));
    } else {
      const notes = h('textarea', { class: 'textarea', placeholder: 'Notes — **bold**, *italic*, lists, - [ ] checkboxes, [links](https://…)', 'aria-label': 'Notes' });
      notes.value = t.notes || '';
      notes.addEventListener('input', () => debouncedSave({ notes: notes.value }));
      notesWrap.append(notes);
    }
    content.append(notesWrap);

    /* --- Subtasks (up to 3 levels) --- */
    content.append(subtasksSection(id, render));

    /* --- Focus --- */
    if (t.focusMinutes > 0) {
      content.append(h('div', { class: 'detail-section' },
        h('div', { class: 'detail-section-title' }, 'Focus'),
        h('div', { class: 'muted small' }, `${U.fmtDuration(t.focusMinutes)} logged on this task`),
      ));
    }

    /* --- Meta + actions --- */
    content.append(h('div', { class: 'detail-meta small muted' },
      `Created ${U.fmtDateLong(U.dateStrFromMs(block.createdAt))} · updated ${new Date(block.updatedAt).toLocaleString()}`));
    content.append(h('div', { class: 'detail-actions row' },
      h('button', { class: 'btn', onClick: () => { duplicateTask(id); sheet.close(); } }, icon('copy', 16), 'Duplicate'),
      h('button', { class: 'btn', onClick: () => { moveTask(id); sheet.close(); } }, icon('folder', 16), 'Move'),
      h('button', { class: 'btn btn-danger', onClick: () => deleteTask(id, () => sheet.close()) }, icon('trash', 16), 'Delete'),
    ));

    if (focusField === 'title') titleInput.focus();
  }
  render();
  return sheet;
}

/* ------------------------------------------------------------------ */

function icon(name, size = 18) { return ui.icon(name, size); }

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
}

function chipBtn(ic, label, onClick) {
  return h('button', { class: 'chip chip-btn', onClick }, icon(ic, 13), label || '—');
}

function dateField(label, value, onChange) {
  const input = h('input', { class: 'input', type: 'date', 'aria-label': label });
  input.value = value || '';
  input.addEventListener('change', () => onChange(input.value || null));
  const clear = h('button', { class: 'icon-btn', 'aria-label': `Clear ${label}`, onClick: () => { input.value = ''; onChange(null); } }, icon('close', 16));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
    h('div', { class: 'row' }, input, h('span', { class: 'grow' }), value && clear));
}

function timeField(label, valueMinutes, onChange) {
  const input = h('input', { class: 'input', type: 'time', 'aria-label': label });
  if (valueMinutes != null) input.value = U.timeStr(valueMinutes);
  input.addEventListener('change', () => onChange(U.parseClock(input.value)));
  const clear = h('button', { class: 'icon-btn', 'aria-label': `Clear ${label}`, onClick: () => { input.value = ''; onChange(null); } }, icon('close', 16));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
    h('div', { class: 'row' }, input, h('span', { class: 'grow' }), valueMinutes != null && clear));
}

function numberField(label, value, min, max, step, onChange) {
  const input = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step: String(step), 'aria-label': label });
  input.value = String(value);
  input.addEventListener('change', () => onChange(U.clamp(+input.value || min, min, max)));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
}

function somedayToggle(id, value, rerender) {
  const sw = ui.switchEl(!!value, (v) => { store.update(id, { someday: v }); rerender?.(); }, 'Someday');
  return h('div', { class: 'row', style: 'min-height:44px' },
    h('span', { class: 'small muted grow' }, 'Someday — no pressure, hidden from Today'), sw.el);
}

function whenLabel(t) {
  const day = t.schedule?.date || t.dueDate;
  if (!day) return 'No date';
  let s = U.dayLabel(day);
  if (t.schedule?.start != null) s += ` ${U.fmtTime(t.schedule.start, store.settings.use24h)}`;
  return s;
}

/* --- recurrence editor --- */
const REC_PRESETS = [
  { label: 'None', value: '' },
  { label: 'Every day', value: 'd1' },
  { label: 'Every weekday', value: 'wd' },
  { label: 'Every week', value: 'w1' },
  { label: 'Every 2 weeks', value: 'w2' },
  { label: 'Every month', value: 'm1' },
  { label: 'Every year', value: 'y1' },
  { label: 'Custom…', value: 'custom' },
];

function recurrenceEditor(taskId, rule) {
  const wrap = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Repeat'));
  const currentKey = !rule ? '' : rule.custom ? 'custom' :
    rule.freq === 'day' && rule.interval === 1 && !rule.fromCompletion ? 'd1' :
    rule.freq === 'week' && rule.byDay?.length === 5 ? 'wd' :
    rule.freq === 'week' && rule.interval === 1 ? 'w1' :
    rule.freq === 'week' && rule.interval === 2 ? 'w2' :
    rule.freq === 'month' && rule.interval === 1 ? 'm1' :
    rule.freq === 'year' ? 'y1' : 'custom';
  const select = h('select', { class: 'input', 'aria-label': 'Repeat' },
    ...REC_PRESETS.map((p) => h('option', { value: p.value, selected: currentKey === p.value ? '' : null }, p.label)));
  select.addEventListener('change', () => {
    const v = select.value;
    if (v === '') return store.update(taskId, { recurrence: null });
    if (v === 'custom') { custom.style.display = ''; return; }
    custom.style.display = 'none';
    const today = U.todayStr();
    const rules = {
      d1: { freq: 'day', interval: 1, anchor: today },
      wd: { freq: 'week', interval: 1, byDay: [1, 2, 3, 4, 5], anchor: today },
      w1: { freq: 'week', interval: 1, anchor: today },
      w2: { freq: 'week', interval: 2, anchor: today },
      m1: { freq: 'month', interval: 1, anchor: today },
      y1: { freq: 'year', interval: 1, anchor: today },
    };
    if (rules[v]) store.update(taskId, { recurrence: rules[v] });
  });

  // Custom editor
  const custom = h('div', { class: 'rec-custom', style: currentKey === 'custom' ? '' : 'display:none' });
  if (rule) {
    const freqSel = h('select', { class: 'input', 'aria-label': 'Frequency' },
      h('option', { value: 'day', selected: rule.freq === 'day' ? '' : null }, 'Days'),
      h('option', { value: 'week', selected: rule.freq === 'week' ? '' : null }, 'Weeks'),
      h('option', { value: 'month', selected: rule.freq === 'month' ? '' : null }, 'Months'),
      h('option', { value: 'year', selected: rule.freq === 'year' ? '' : null }, 'Years'));
    const interval = h('input', { class: 'input', type: 'number', min: '1', max: '52', 'aria-label': 'Every' });
    interval.value = String(rule.interval || 1);
    const apply = () => store.update(taskId, {
      recurrence: { ...rule, custom: true, freq: freqSel.value, interval: U.clamp(+interval.value || 1, 1, 52) },
    });
    freqSel.addEventListener('change', apply);
    interval.addEventListener('change', apply);
    custom.append(h('div', { class: 'row' },
      h('span', { class: 'small muted' }, 'Every'),
      interval, freqSel));
    if (rule.freq === 'week') {
      const days = h('div', { class: 'row rec-days' });
      for (let d = 0; d < 7; d++) {
        const on = rule.byDay?.includes(d);
        days.append(h('button', {
          class: 'day-dot' + (on ? ' on' : ''), 'aria-pressed': String(!!on), 'aria-label': U.weekdayLong(U.addDays('2023-01-01', d)),
          onClick: (e) => {
            const b = e.currentTarget;
            b.classList.toggle('on');
            const set = new Set([...custom.querySelectorAll('.day-dot.on')].map((x) => +x.dataset.d));
            store.update(taskId, { recurrence: { ...rule, custom: true, byDay: [...set] } });
          },
          dataset: { d: String(d) },
        }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d]));
      }
      custom.append(days);
    }
    const fromCompletion = ui.switchEl(!!rule.fromCompletion, (v) =>
      store.update(taskId, { recurrence: { ...rule, custom: true, fromCompletion: v } }), 'Restart from completion');
    custom.append(h('div', { class: 'row rec-fc' }, h('span', { class: 'small muted grow' }, 'Restart count from completion day'), fromCompletion.el));
  } else {
    custom.append(h('div', { class: 'small muted' }, 'Pick “Custom…” with a preset first, then adjust.'));
  }

  wrap.append(select, custom);
  return wrap;
}

/* --- subtasks --- */
function subtasksSection(id, render, save) {
  const section = h('div', { class: 'detail-section' }, h('div', { class: 'detail-section-title' }, 'Subtasks'));
  const all = [];

  function addLevel(parentId, level) {
    for (const child of store.childrenOf('task', parentId)) {
      all.push({ block: child, level });
      if (level < 3) addLevel(child.id, level + 1);
    }
  }
  addLevel(id, 1);

  if (!all.length) section.append(h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'Break it down into concrete steps.'));
  for (const { block, level } of all) {
    if (level > 3) continue;
    section.append(ui.taskRow(block, {
      indent: Math.min(level, 3),
      showProject: false,
      onOpen: (b) => openTaskDetail(b.id),
      onComplete: (b) => {
        store.completeTask(b.id);
        U.vibrate(12);
        render();
      },
      onUncomplete: (b) => { store.uncompleteTask(b.id); render(); },
      onSchedule: (b) => quickScheduleMenu(b.id, render),
    }));
  }

  const addInput = h('input', { class: 'input', placeholder: 'Add subtask…', 'aria-label': 'Add subtask' });
  const addBtn = h('button', { class: 'icon-btn accent', 'aria-label': 'Add subtask', onClick: () => addSub() }, icon('plus', 20));
  const addSub = () => {
    const title = addInput.value.trim();
    if (!title) return;
    const parent = all.length ? all[all.length - 1] : null;
    // Insert as sibling of the last subtask (or child of the task itself).
    store.create({ type: 'task', props: { title, projectId: store.get(id)?.props.projectId }, parentId: id });
    addInput.value = '';
    addInput.focus();
    render();
  };
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSub(); });
  section.append(h('div', { class: 'row' }, addInput, addBtn));
  return section;
}

/* ================================================================== *
 * Shared menus & pickers
 * ================================================================== */

export function priorityMenu(id, rerender = null) {
  const t = store.get(id);
  if (!t) return;
  ui.menu(PRIORITIES.map((p) => ({
    label: p.label, icon: 'flag', danger: false,
    fn: () => { store.update(id, { priority: p.value }); rerender?.(); },
  })), document.activeElement || { x: 20, y: 20 });
}

/** Quick schedule menu (swipe-left / chips / row menu). */
export function quickScheduleMenu(id, rerender = null) {
  const block = store.get(id);
  if (!block) return;
  const apply = (v) => {
    if (v === 'pick') return openSchedulePicker(id, rerender);
    if (v == null) { store.update(id, { schedule: null, dueDate: null }); }
    else {
      const prev = block.props.schedule;
      store.update(id, { schedule: { date: v.date, start: v.start ?? prev?.start ?? null, dur: prev?.dur ?? 30 } });
    }
    U.vibrate(10);
    rerender?.();
  };
  ui.menu(ui.scheduleMenuItems(block, apply), document.activeElement || { x: 20, y: 20 });
}

/** Sheet with native date/time/duration inputs. */
export function openSchedulePicker(id, rerender = null) {
  const block = store.get(id);
  if (!block) return;
  const s = block.props.schedule;
  const date = h('input', { class: 'input', type: 'date', 'aria-label': 'Date' });
  date.value = s?.date || U.todayStr();
  const time = h('input', { class: 'input', type: 'time', 'aria-label': 'Start time' });
  if (s?.start != null) time.value = U.timeStr(s.start);
  const dur = h('input', { class: 'input', type: 'number', min: '15', max: '720', step: '15', 'aria-label': 'Duration minutes' });
  dur.value = String(s?.dur || 30);
  const content = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Date'), date),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Start time (optional)'), time),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Duration (minutes)'), dur),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn btn-primary', onClick: () => {
        const t = U.parseClock(time.value);
        store.update(id, {
          schedule: date.value ? { date: date.value, start: t, dur: U.clamp(+dur.value || 30, 15, 720) } : null,
        });
        modal.close();
        rerender?.();
      } }, 'Save')),
  );
  const modal = ui.openSheet({ title: 'Schedule task', content });
}

/** Project picker sheet (also creates projects inline). */
export function pickProject(currentId, onPick) {
  const content = h('div', {});
  const choose = (pid) => { sheet.close(); onPick(pid); };

  content.append(h('button', { class: 'menu-item', onClick: () => choose(null) }, icon('inbox', 18), h('span', { class: 'grow' }, 'Inbox'), !currentId && icon('check', 18)));
  for (const area of store.childrenOf('area', null)) {
    content.append(h('div', { class: 'picker-group muted small' }, area.props.name));
    for (const p of store.childrenOf('project', area.id)) {
      content.append(projectRow(p, choose, currentId));
    }
  }
  const loose = store.childrenOf('project', null);
  if (loose.length) {
    content.append(h('div', { class: 'picker-group muted small' }, 'No area'));
    for (const p of loose) content.append(projectRow(p, choose, currentId));
  }
  const newName = h('input', { class: 'input', placeholder: 'New project name…', 'aria-label': 'New project name' });
  const areaSel = h('select', { class: 'input', 'aria-label': 'Area' },
    h('option', { value: '' }, 'No area'),
    ...store.childrenOf('area', null).map((a) => h('option', { value: a.id }, a.props.name)));
  content.append(h('div', { class: 'picker-new' },
    h('div', { class: 'picker-group muted small' }, 'New project'),
    h('div', { class: 'row' }, newName, areaSel,
      h('button', { class: 'icon-btn accent', 'aria-label': 'Create project', onClick: () => {
        const name = newName.value.trim();
        if (!name) return;
        const areaId = areaSel.value || null;
        const p = store.create({ type: 'project', props: { name }, parentId: areaId });
        choose(p.id);
      } }, icon('plus', 20)))));
  const sheet = ui.openSheet({ title: 'Move to project', content });
}
function projectRow(p, choose, currentId) {
  return h('button', { class: 'menu-item', onClick: () => choose(p.id) }, icon('folder', 18), h('span', { class: 'grow' }, p.props.name), p.id === currentId && icon('check', 18));
}

/** Labels picker sheet. */
export function pickLabelsSheet(currentIds, onPick) {
  const selected = new Set(currentIds || []);
  const content = h('div', {});
  const chips = h('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px' });
  const labels = store.allOfType('label');
  if (!labels.length) chips.append(h('span', { class: 'muted small' }, 'No labels yet — create one below.'));
  const renderChips = () => {
    chips.innerHTML = '';
    for (const l of labels) {
      chips.append(h('button', {
        class: 'chip chip-btn' + (selected.has(l.id) ? ' on' : ''),
        'aria-pressed': String(selected.has(l.id)),
        onClick: () => { selected.has(l.id) ? selected.delete(l.id) : selected.add(l.id); renderChips(); },
      }, icon('tag', 13), l.props.name, selected.has(l.id) && icon('check', 13)));
    }
  };
  renderChips();
  const newName = h('input', { class: 'input', placeholder: 'New label…', 'aria-label': 'New label' });
  content.append(chips, h('div', { class: 'row', style: 'margin-top:12px' }, newName,
    h('button', { class: 'icon-btn accent', 'aria-label': 'Create label', onClick: () => {
      const name = newName.value.trim();
      if (!name) return;
      const l = store.create({ type: 'label', props: { name } });
      labels.push(l); selected.add(l.id);
      newName.value = '';
      renderChips();
    } }, icon('plus', 20))),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
      h('button', { class: 'btn btn-primary', onClick: () => { sheet.close(); onPick([...selected]); } }, 'Done')));
  const sheet = ui.openSheet({ title: 'Labels', content });
}

/* --- row-level actions used across views --- */

export function taskContextMenu(block, rerender) {
  const t = block.props;
  const id = block.id;
  ui.menu([
    t.completedAt
      ? { label: 'Reopen', icon: 'reset', fn: () => { store.uncompleteTask(id); rerender?.(); } }
      : { label: 'Complete', icon: 'check', fn: () => { completeWithUndo(block); rerender?.(); } },
    { label: 'Edit details', icon: 'pencil', fn: () => openTaskDetail(id) },
    '---',
    ...ui.scheduleMenuItems(block, (v) => { if (v === 'pick') openSchedulePicker(id, rerender); else if (v == null) store.update(id, { schedule: null, dueDate: null }); else store.update(id, { schedule: { date: v.date, start: v.start ?? t.schedule?.start ?? null, dur: t.schedule?.dur ?? 30 } }); rerender?.(); }),
    '---',
    ...PRIORITIES.map((p) => ({ label: p.label, icon: 'flag', fn: () => { store.update(id, { priority: p.value }); rerender?.(); } })),
    '---',
    { label: 'Move to project…', icon: 'folder', fn: () => pickProject(t.projectId, (pid) => { store.update(id, { projectId: pid }); rerender?.(); }) },
    { label: 'Duplicate', icon: 'copy', fn: () => { duplicateTask(id); rerender?.(); } },
    { label: 'Delete', icon: 'trash', danger: true, fn: () => deleteTask(id, rerender) },
  ], document.activeElement || { x: 20, y: 20 });
}

export function completeWithUndo(block) {
  const { spawnedId } = store.completeTask(block.id);
  U.vibrate(14);
  ui.undoToast(spawnedId ? 'Completed — next occurrence scheduled' : 'Task completed', () => {
    store.uncompleteTask(block.id);
    if (spawnedId) store.softDelete(spawnedId);
  });
}

export function deleteTask(id, rerender) {
  const block = store.get(id);
  if (!block) return;
  ui.confirmDialog({
    title: 'Delete task?',
    message: block.props.title || 'This task',
    confirmLabel: 'Delete', danger: true,
  }).then((ok) => {
    if (!ok) return;
    store.softDelete(id);
    ui.undoToast('Task deleted', () => store.restore(id));
    rerender?.();
  });
}

export function duplicateTask(id) {
  const b = store.get(id);
  if (!b) return;
  const copy = store.create({
    type: 'task',
    props: { ...structuredClone(b.props), completedAt: null, focusMinutes: 0, notifiedAt: null },
    parentId: b.parentId,
    order: U.FI.between(b.order, null),
  });
  ui.toast('Task duplicated');
  return copy;
}

function moveTask(id) {
  const b = store.get(id);
  pickProject(b?.props.projectId ?? null, (pid) => store.update(id, { projectId: pid }));
}

/* local alias to keep the hyperscript readable */
function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
