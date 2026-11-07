/**
 * views/browse.js — the organization hub: areas → projects, labels, smart
 * lists, plus links to the built-in tools (matrix, habits, focus, settings).
 * Also hosts the smart-list builder.
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';

export function renderBrowse(container) {
  container.innerHTML = '';

  container.append(h('div', { class: 'view-head row' },
    h('div', { class: 'grow' },
      h('h2', { class: 'view-title' }, 'Browse'),
      h('div', { class: 'view-sub muted small' }, 'Areas, projects, labels & tools'),
    ),
  ));

  /* Mindful banner */
  const mindfulBanner = h('div', { class: 'mindful-banner' },
    h('div', { class: 'mindful-content' },
      h('div', { class: 'mindful-tag' },
        ui.icon('sparkle', 14),
        h('span', {}, 'Daily Philosophy'),
      ),
      h('div', { class: 'mindful-quote' }, '“Simplicity is about subtracting the obvious and adding the meaningful.”'),
      h('div', { class: 'mindful-sub' }, 'Organize space to protect deep focus'),
    ),
  );
  container.append(mindfulBanner);

  /* --- Tools (Bento Grid) --- */
  const tools = [
    ['grid', 'Eisenhower', 'Urgent vs important triage', '#/matrix'],
    ['flame', 'Habits', 'Daily cadence & rhythm tracking', '#/habits'],
    ['timer', 'Focus timer', 'Pomodoro & single-task focus', '#/focus'],
    ['settings', 'Settings', 'Preferences, sync & storage', '#/settings'],
  ];
  const toolGrid = h('div', { class: 'tool-grid' });
  for (const [ic, title, sub, href] of tools) {
    toolGrid.append(h('a', { class: 'tool-card', href, onClick: () => { location.hash = href; } },
      h('div', { class: 'tool-icon-wrap' }, ui.icon(ic, 20)),
      h('div', { class: 'tool-meta' },
        h('span', { class: 'tool-name' }, title),
        h('span', { class: 'tool-sub' }, sub),
      ),
    ));
  }
  container.append(h('div', { class: 'section-label' }, 'Spaces & Focus'), toolGrid);

  /* --- Areas & projects --- */
  const projectsCol = h('div', {});
  const areas = store.childrenOf('area', null);

  const projectEntry = (p, indent) => {
    const count = store.activeTasks().filter((t) => !t.parentId && !t.props.completedAt && t.props.projectId === p.id).length;
    return h('a', {
      class: 'nav-entry row' + (indent ? ' indented' : ''), href: '#/project/' + p.id,
    },
      ui.icon('folder', 18),
      h('span', { class: 'grow nav-name' }, p.props.name),
      count > 0 && h('span', { class: 'nav-count muted small' }, String(count)),
      ui.icon('chevronRight', 16),
    );
  };

  for (const area of areas) {
    const count = store.activeTasks().filter((t) => {
      const p = store.projectOf(t);
      return p && !t.parentId && !t.props.completedAt && p.parentId === area.id;
    }).length;
    projectsCol.append(h('a', { class: 'nav-entry row area-entry', href: '#/area/' + area.id },
      ui.icon('box', 18),
      h('span', { class: 'grow nav-name' }, area.props.name),
      count > 0 && h('span', { class: 'nav-count muted small' }, String(count)),
      ui.icon('chevronRight', 16),
    ));
    for (const p of store.childrenOf('project', area.id)) projectsCol.append(projectEntry(p, true));
  }
  const loose = store.childrenOf('project', null);
  for (const p of loose) projectsCol.append(projectEntry(p, false));

  const newArea = h('button', { class: 'btn btn-ghost btn-sm', onClick: () => createNamed('area') }, ui.icon('plus', 14), 'New area');
  const newProject = h('button', { class: 'btn btn-ghost btn-sm', onClick: () => createNamed('project') }, ui.icon('plus', 14), 'New project');
  container.append(h('div', { class: 'section-label row' }, 'Areas & projects', h('span', { class: 'grow' }), newProject, newArea), projectsCol);

  /* --- Smart lists --- */
  const smartCol = h('div', {});
  const smartLists = store.allOfType('smartList');
  for (const s of smartLists) {
    const count = store.activeTasks().filter((t) => !t.parentId && store.matchesSmartFilter(t, s.props.filter)).length;
    smartCol.append(h('div', { class: 'nav-entry row' },
      ui.icon('sparkle', 18),
      h('a', { class: 'grow nav-name', href: '#/smart/' + s.id }, s.props.name),
      h('span', { class: 'nav-count muted small' }, String(count)),
      h('button', { class: 'icon-btn', 'aria-label': 'Edit smart list', onClick: () => editSmartList(s) }, ui.icon('pencil', 16)),
    ));
  }
  container.append(
    h('div', { class: 'section-label row' }, 'Smart lists',
      h('span', { class: 'grow' }),
      h('button', { class: 'btn btn-ghost btn-sm', onClick: () => editSmartList(null) }, ui.icon('plus', 14), 'New filter'),
    ),
    smartCol,
  );

  /* --- Labels --- */
  const labelCol = h('div', { class: 'row', style: 'flex-wrap:wrap; gap:8px; padding:2px 0 12px' });
  const labels = store.allOfType('label');
  if (!labels.length) labelCol.append(h('span', { class: 'muted small' }, 'No labels — add @label in quick add.'));
  for (const l of labels) {
    const count = store.activeTasks().filter((t) => (t.props.labels || []).includes(l.id)).length;
    labelCol.append(h('a', { class: 'chip chip-btn', href: '#/label/' + l.id }, ui.icon('tag', 13), `${l.props.name} · ${count}`));
  }
  container.append(h('div', { class: 'section-label row' }, 'Labels',
    h('span', { class: 'grow' }),
    h('button', { class: 'btn btn-ghost btn-sm', onClick: () => createNamed('label') }, ui.icon('plus', 14), 'New label'),
  ), labelCol);

  return () => {};
}

function createNamed(type) {
  const label = type === 'area' ? 'Area name' : type === 'label' ? 'Label name' : 'Project name';
  const name = prompt(label); // eslint-disable-line no-alert
  if (!name?.trim()) return;
  if (type === 'project') {
    // Offer an area via simple second prompt (kept deliberately lightweight).
    const areas = store.childrenOf('area', null);
    const areaName = areas.length ? prompt(`Area (${areas.map((a) => a.props.name).join(', ')} or leave blank)`, '') : '';
    const area = areaName?.trim() ? areas.find((a) => a.props.name.toLowerCase() === areaName.trim().toLowerCase()) : null;
    store.create({ type: 'project', props: { name: name.trim() }, parentId: area?.id ?? null });
  } else {
    store.create({ type, props: { name: name.trim() } });
  }
  location.reload = null;
  window.__flowReroute?.();
}

/* ---------------- smart list builder ---------------- */

const DUE_OPTIONS = [
  ['', 'Any date'], ['overdue', 'Overdue'], ['today', 'Due today or earlier'], ['week', 'Due within 7 days'], ['none', 'No date'],
];

function editSmartList(smart) {
  const filter = smart ? structuredClone(smart.props.filter) : { priority: null, due: '', labels: [], projectId: null, someday: false };

  const nameInput = h('input', { class: 'input', placeholder: 'Smart list name', 'aria-label': 'Name' });
  nameInput.value = smart?.props.name || '';

  const dueSel = h('select', { class: 'input', 'aria-label': 'Due filter' },
    ...DUE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: (filter.due || '') === v ? '' : null }, l)));
  dueSel.addEventListener('change', () => { filter.due = dueSel.value || null; refreshPreview(); });

  const prioSel = h('select', { class: 'input', 'aria-label': 'Priority filter' },
    h('option', { value: '' }, 'Any priority'),
    ...[1, 2, 3, 4].map((p) => h('option', { value: String(p), selected: filter.priority === p ? '' : null }, p === 4 ? 'No priority' : `P${p}`)));
  prioSel.addEventListener('change', () => { filter.priority = prioSel.value ? +prioSel.value : null; refreshPreview(); });

  const labelChips = h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' });
  const renderLabelChips = () => {
    labelChips.innerHTML = '';
    for (const l of store.allOfType('label')) {
      const on = (filter.labels || []).includes(l.props.name);
      labelChips.append(h('button', {
        class: 'chip chip-btn' + (on ? ' on' : ''), 'aria-pressed': String(on),
        onClick: () => {
          const set = new Set(filter.labels || []);
          set.has(l.props.name) ? set.delete(l.props.name) : set.add(l.props.name);
          filter.labels = [...set];
          renderLabelChips(); refreshPreview();
        },
      }, ui.icon('tag', 13), l.props.name));
    }
    if (!store.allOfType('label').length) labelChips.append(h('span', { class: 'muted small' }, 'No labels yet.'));
  };
  renderLabelChips();

  const preview = h('div', { class: 'muted small', style: 'margin-top:8px' });
  const refreshPreview = () => {
    const tasks = store.activeTasks().filter((t) => !t.parentId && store.matchesSmartFilter(t, filter));
    preview.textContent = `${tasks.length} ${tasks.length === 1 ? 'task matches' : 'tasks match'} right now`;
    preview.textContent += ` — e.g. ${tasks.slice(0, 3).map((t) => `“${t.props.title}”`).join(', ') || 'nothing yet'}`;
  };
  refreshPreview();

  const content = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Due'), dueSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Priority'), prioSel),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Labels (all must match)'), labelChips),
    preview,
    h('div', { class: 'row', style: 'justify-content:flex-end; margin-top:16px; gap:8px' },
      smart && h('button', { class: 'btn btn-danger', onClick: async () => {
        if (await ui.confirmDialog({ title: 'Delete smart list?', danger: true, confirmLabel: 'Delete' })) {
          store.softDelete(smart.id); sheet.close(); window.__flowReroute?.();
        }
      } }, 'Delete'),
      h('button', { class: 'btn btn-primary', onClick: () => {
        const name = nameInput.value.trim();
        if (!name) return nameInput.focus();
        if (smart) store.update(smart.id, { name, filter });
        else store.create({ type: 'smartList', props: { name, filter } });
        sheet.close();
        window.__flowReroute?.();
      } }, 'Save'),
    ),
  );
  const sheet = ui.openSheet({ title: smart ? 'Edit smart list' : 'New smart list', content });
}

/* local alias to keep the hyperscript readable */
function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
