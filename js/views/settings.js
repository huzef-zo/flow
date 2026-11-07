/**
 * views/settings.js — preferences, data ownership, notifications, and the
 * Developer panel (sync simulation, stress data).
 */

import * as store from '../store.js';
import * as ui from '../ui.js';
import * as U from '../utils.js';
import * as sync from '../sync.js';
import { parseICS, toICS } from '../ics.js';

const ACCENTS = [
  ['indigo', 'Indigo', '#4F46E5'], ['teal', 'Teal', '#0D9488'], ['green', 'Green', '#15803D'],
  ['amber', 'Amber', '#B45309'], ['rose', 'Rose', '#BE123C'], ['violet', 'Violet', '#7C3AED'],
];

export function renderSettings(container) {
  function render() {
    container.innerHTML = '';
    container.append(h('div', { class: 'view-head row' },
      h('div', { class: 'grow muted small' }, 'Your data stays on this device'),
    ));

    container.append(section('General',
      row('Theme', ui.seg([{ label: 'System', value: 'system' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }],
        store.settings.theme, (v) => { window.__flowApplyTheme?.(v); }).el),
      stackedRow('Accent color', h('div', { class: 'row', style: 'flex-wrap:wrap; gap:10px; padding-top:4px' },
        ...ACCENTS.map(([key, label, hex]) => h('button', {
          class: 'accent-swatch' + (store.settings.accent === key ? ' on' : ''),
          style: { background: hex },
          'aria-label': label, title: label, dataset: { accent: key },
          onClick: (e) => { window.__flowApplyAccent?.(key); e.currentTarget.blur(); render(); },
        })))),
      row('Week starts on', ui.seg([{ label: 'Sunday', value: 0 }, { label: 'Monday', value: 1 }],
        store.settings.weekStart, (v) => store.setSettings({ weekStart: v })).el),
      row('Time format', ui.seg([{ label: '12 h', value: false }, { label: '24 h', value: true }],
        store.settings.use24h, (v) => store.setSettings({ use24h: v })).el),
      inputRow('Default reminder time', 'time', store.settings.defaultReminderTime, (v) => store.setSettings({ defaultReminderTime: v || '09:00' })),
      toggleRow('Automatic reminders', 'When a task has a date/time, remind me at that time (or the default time).', store.settings.autoReminders, (v) => store.setSettings({ autoReminders: v })),
      toggleRow('Hide tasks until start date', 'Tasks with a future start date stay out of Today/Anytime.', store.settings.hideUntilStart, (v) => store.setSettings({ hideUntilStart: v })),
      toggleRow('Evening “Plan tomorrow” prompt', 'A gentle nudge after 6pm if tomorrow looks empty.', store.settings.planPrompt, (v) => store.setSettings({ planPrompt: v })),
    ));

    const p = store.settings.pomodoro;
    container.append(section('Focus timer',
      inputRow('Focus length (minutes)', 'number', String(p.focus), (v) => setPomo({ focus: U.clamp(+v || 25, 5, 120) })),
      inputRow('Short break (minutes)', 'number', String(p.break), (v) => setPomo({ break: U.clamp(+v || 5, 1, 60) })),
      inputRow('Long break (minutes)', 'number', String(p.longBreak), (v) => setPomo({ longBreak: U.clamp(+v || 15, 5, 90) })),
      inputRow('Rounds before long break', 'number', String(p.rounds), (v) => setPomo({ rounds: U.clamp(+v || 4, 2, 8) })),
      toggleRow('Auto-start breaks', '', p.autoStartBreaks, (v) => setPomo({ autoStartBreaks: v })),
      toggleRow('Sound when a round ends', '', p.sound, (v) => setPomo({ sound: v })),
    ));

    container.append(notificationsSection());
    container.append(dataSection());
    container.append(section('Developer',
      toggleRow('Show sync developer tools', 'Simulate a second device, force offline, create conflicts, stress-test with 1,000 tasks.', store.settings.devPanel, (v) => store.setSettings({ devPanel: v })),
    ));
    if (store.settings.devPanel) container.append(devPanel());

    container.append(section('About',
      h('div', { class: 'muted small', style: 'line-height:1.7' },
        `Flow v${window.__flowVersion || '1.0.0'} — an offline-first task planner. `,
        'Quick-add cheat sheet: ',
        cheat()),
    ));
  }

  function cheat() {
    return h('div', { class: 'cheatsheet small' },
      code('today / tomorrow / next friday / in 3 days'), code('jun 12 / 12/06'),
      code('at 5pm / 17:30 / from 2pm to 3pm / for 90m'),
      code('p1…p4 or !!! '), code('#Project '), code('@label '), code('&Area '), code('someday'),
      code('every day / every weekday / every 2 weeks / every 3rd wednesday / after 2 days from completion'),
    );
  }
  const code = (s) => h('code', { class: 'cheat-code' }, s);

  function setPomo(patch) { store.setSettings({ pomodoro: { ...store.settings.pomodoro, ...patch } }); }

  function notificationsSection() {
    const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    const body = h('div', {});
    const status = h('div', { class: 'muted small', style: 'margin-top:6px; line-height:1.6' },
      perm === 'granted'
        ? 'Notifications are enabled. Reminders fire while the app is open (or recently backgrounded).'
        : perm === 'denied'
          ? 'Notifications are blocked in your browser settings. In-app reminder banners still work.'
          : perm === 'unsupported'
            ? 'This browser does not support web notifications. In-app reminder banners still work.'
            : 'Enable reminders for time-based notifications.');
    body.append(status);
    if (perm === 'default') {
      body.append(h('button', { class: 'btn', style: 'margin-top:10px', onClick: async () => {
        if ('Notification' in window) {
          const res = await Notification.requestPermission();
          if (res === 'granted') window.__flowSWreg?.showNotification('Flow', { body: 'Reminders are on.', tag: 'flow-test' });
        }
        render();
      } }, ui.icon('bell', 16), 'Enable notifications'));
    }
    body.append(h('div', { class: 'muted small', style: 'margin-top:10px; padding:10px 12px; background:var(--surface-2); border-radius:10px' },
      ui.icon('info', 14), ' Honest limits: mobile browsers pause web apps in the background. Install the PWA for the best chance of reminders while the phone is idle; while the app is closed, reminders queue and appear the next time you open Flow.'));
    return section('Notifications', body);
  }

  function dataSection() {
    const body = h('div', {});
    body.append(h('div', { class: 'settings-actions' },
      h('button', { class: 'btn', onClick: exportJSON }, ui.icon('download', 16), 'Export JSON'),
      h('button', { class: 'btn', onClick: exportCSV }, ui.icon('download', 16), 'Export CSV'),
      h('button', { class: 'btn', onClick: exportICS }, ui.icon('calendar', 16), 'Export .ics'),
      h('button', { class: 'btn', onClick: importJSON }, ui.icon('upload', 16), 'Import JSON'),
      h('button', { class: 'btn', onClick: () => window.__flowImportICS?.() }, ui.icon('upload', 16), 'Import .ics'),
    ));

    const storage = h('div', { class: 'muted small', style: 'margin-top:12px' }, 'Checking storage…');
    body.append(storage);
    store.storageStatus().then((s) => {
      storage.textContent = s.persisted
        ? `Storage is persistent — the browser will not evict your data. ${usage(s)}`
        : s.supported
          ? `Storage is best-effort ${usage(s)}. Ask the browser to persist your data so nothing is evicted under pressure.`
          : 'Storage persistence is not supported in this browser.';
      if (!s.persisted && s.supported) {
        storage.append(h('button', { class: 'btn btn-sm', style: 'margin-left:8px', onClick: async () => {
          const ok = await store.requestPersistence();
          ui.toast(ok ? 'Storage is now persistent' : 'The browser declined — try again after installing the app');
          render();
        } }, 'Request persistent storage'));
      }
    });

    body.append(h('div', { class: 'settings-actions', style: 'margin-top:14px' },
      h('button', { class: 'btn', onClick: async () => {
        const n = await store.clearSampleData();
        ui.toast(n ? `Removed ${n} sample blocks` : 'No sample data found');
      } }, ui.icon('close', 16), 'Clear sample data'),
      h('button', { class: 'btn btn-danger', onClick: async () => {
        if (!await ui.confirmDialog({ title: 'Erase everything?', message: 'All tasks, projects, habits, events and settings on this device (and the mock sync server) will be deleted.', confirmLabel: 'Erase all data', danger: true })) return;
        await store.wipeAll();
        location.reload();
      } }, ui.icon('trash', 16), 'Erase all data'),
    ));
    return section('Data ownership', body);
  }

  function usage(s) {
    if (s.usage == null) return '';
    return `· ${(s.usage / 1048576).toFixed(1)} MB used${s.quota ? ` of ~${(s.quota / 1048576).toFixed(0)} MB` : ''}`;
  }

  /* ---------------- developer panel ---------------- */

  function devPanel() {
    const body = h('div', { class: 'devpanel' });

    /* sync status */
    const statusLine = h('div', { class: 'muted small' }, '…');
    const refreshStatus = () => {
      const s = sync.syncState;
      statusLine.textContent = `Status: ${s.status} · ${s.pending} pending op(s)` +
        (s.lastSync ? ` · last sync ${new Date(s.lastSync).toLocaleTimeString()}` : '') +
        (s.lastError ? ` · error: ${s.lastError}` : '');
    };
    refreshStatus();
    sync.subscribeSync(refreshStatus);
    body.append(h('div', { class: 'row' }, statusLine, h('span', { class: 'grow' }),
      h('button', { class: 'btn btn-sm', onClick: () => sync.forceSyncNow() }, 'Sync now')));

    /* offline / latency */
    body.append(h('div', { class: 'row', style: 'margin-top:10px' },
      ui.switchEl(sync.syncState.forcedOffline, (v) => sync.setForcedOffline(v), 'Force offline').el,
      h('span', { class: 'small muted' }, 'Force offline (simulate losing the network)'),
    ));
    body.append(h('label', { class: 'row small', style: 'margin-top:8px' },
      'Server latency',
      h('input', { class: 'input', type: 'range', min: '0', max: '3000', step: '100', value: String(sync.mockAdapter.latency),
        onInput: (e) => { sync.mockAdapter.latency = +e.target.value; e.target.nextElementSibling.textContent = `${e.target.value} ms`; } }),
      h('span', { class: 'muted' }, `${sync.mockAdapter.latency} ms`),
    ));

    /* Device B */
    body.append(h('div', { class: 'dev-sub' }, 'Device B (phantom second device)'));
    const bTitle = h('input', { class: 'input', placeholder: 'Task title to create as Device B', 'aria-label': 'Device B task title' });
    body.append(h('div', { class: 'row', style: 'margin-top:6px' }, bTitle,
      h('button', { class: 'btn btn-sm', onClick: async () => {
        if (!bTitle.value.trim()) return;
        const block = { id: U.uuidv7(), type: 'task', parentId: null, order: 'a0', workspaceId: 'ws:default',
          props: { title: bTitle.value.trim(), priority: 4, labels: [] }, fieldHlcs: { title: sync.hlc.now() },
          createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, version: 1, deviceId: 'device-b' };
        await sync.devOpAsDeviceB({ type: 'create', entityId: block.id, block });
        ui.toast('Device B created a task on the server — pulling…');
      } }, 'Push'),
    ));
    body.append(h('div', { class: 'settings-actions', style: 'margin-top:8px' },
      h('button', { class: 'btn btn-sm', onClick: async () => {
        const tasks = store.activeTasks();
        if (!tasks.length) return ui.toast('Create a task first');
        const t = tasks[0];
        await sync.devOpAsDeviceB({
          type: 'update', entityId: t.id,
          patch: { props: { title: t.props.title + ' (edited by B)' }, fieldHlcs: { title: sync.hlc.pack(Date.now() + 5000, 1, 'device-b') } },
        });
        ui.toast(`Device B edited “${t.props.title.slice(0, 24)}…” with a FUTURE clock — B should win`);
      } }, 'B edits a task (future clock → B wins)'),
      h('button', { class: 'btn btn-sm', onClick: async () => {
        const tasks = store.activeTasks();
        if (!tasks.length) return ui.toast('Create a task first');
        const t = tasks[0];
        store.update(t.id, { title: t.props.title + ' (local edit)' });
        await sync.devOpAsDeviceB({
          type: 'update', entityId: t.id,
          patch: { props: { title: t.props.title + ' (stale B edit)' }, fieldHlcs: { title: sync.hlc.pack(Date.now() - 60000, 1, 'device-b') } },
        });
        ui.toast('Conflict injected — the LOCAL edit should win (older HLC loses)');
      } }, 'Inject conflict'),
    ));

    /* op log */
    body.append(h('div', { class: 'dev-sub' }, 'Outbox (recent ops)'));
    const log = h('div', { class: 'dev-log small muted' });
    const ops = store.recentOps(14);
    if (!ops.length) log.append('No operations yet.');
    for (const op of ops) {
      log.append(h('div', {},
        `${op.status === 'pending' ? '●' : '○'} ${op.type.padEnd(6)} ${(op.entityId || '').slice(0, 8)} · ${op.deviceId} · ${new Date(op.timestamp).toLocaleTimeString()}${op.tries ? ` · tries ${op.tries}` : ''}`));
    }
    body.append(log);

    /* stress + reset */
    body.append(h('div', { class: 'settings-actions', style: 'margin-top:10px' },
      h('button', { class: 'btn btn-sm', onClick: () => {
        const n = store.generateStressTasks(1000);
        ui.toast(`Generated ${n} tasks — try the Inbox and Upcoming views`);
      } }, 'Generate 1,000 tasks'),
      h('button', { class: 'btn btn-sm btn-danger', onClick: async () => {
        if (!await ui.confirmDialog({ title: 'Reset mock server?', message: 'Clears the simulated server store. Your local data stays.', confirmLabel: 'Reset', danger: true })) return;
        await sync.devResetServer();
        ui.toast('Mock server cleared');
      } }, 'Reset mock server'),
    ));
    return section('Developer · sync playground', body);
  }

  /* ---------------- import/export ---------------- */

  function exportJSON() {
    const data = store.exportJSON();
    U.download(`flow-backup-${U.todayStr()}.json`, 'application/json', JSON.stringify(data, null, 2));
    ui.toast('Backup downloaded');
  }
  function exportCSV() {
    U.download(`flow-tasks-${U.todayStr()}.csv`, 'text/csv', store.exportCSV());
    ui.toast('CSV downloaded');
  }
  function exportICS() {
    const today = U.todayStr();
    const records = [
      ...store.activeTasks().filter((t) => store.taskDay(t)).map((t) => ({
        title: t.props.title, date: t.props.schedule?.date || t.props.dueDate,
        time: t.props.schedule?.start ?? null, dur: t.props.schedule?.dur || 30, allDay: false,
        description: t.props.notes || undefined,
      })),
      ...store.allOfType('event').map((e) => ({
        title: e.props.title, date: e.props.date, time: e.props.start, dur: e.props.dur, allDay: e.props.allDay,
      })),
    ].filter((r) => r.date >= today || (r.time != null));
    U.download(`flow-${today}.ics`, 'text/calendar', toICS(records));
    ui.toast('Calendar exported');
  }
  function importJSON() {
    const input = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!await ui.confirmDialog({ title: 'Import backup?', message: `This replaces the current data on this device (${data.blocks?.length ?? 0} blocks found).`, confirmLabel: 'Import', danger: true })) return;
        await store.importJSON(data);
        ui.toast('Backup imported');
        window.__flowReroute?.();
      } catch (err) {
        ui.toast(`Import failed: ${err.message}`);
      } finally {
        input.remove();
      }
    });
    input.click();
  }

  render();
  const unsub = store.subscribe(render);
  const unsubSync = sync.subscribeSync(render);
  return () => { unsub(); unsubSync(); };
}

/* ---------------- little builders ---------------- */

function section(title, ...children) {
  return h('section', { class: 'settings-section' }, h('h3', { class: 'settings-h' }, title), ...children);
}
function row(label, control) {
  return h('div', { class: 'settings-row' }, h('div', { class: 'settings-label' }, label), control);
}
/** Label above the control (for wide controls like the accent swatches). */
function stackedRow(label, control) {
  return h('div', { class: 'settings-row stacked' }, h('div', { class: 'settings-label' }, label), control);
}
function inputRow(label, type, value, onChange) {
  const input = h('input', { class: 'input', type, style: 'max-width:150px', 'aria-label': label });
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return row(label, input);
}
function toggleRow(label, hint, value, onChange) {
  const sw = ui.switchEl(!!value, onChange, label);
  const el = h('div', { class: 'settings-row' },
    h('div', {}, h('div', { class: 'settings-label' }, label), hint && h('div', { class: 'muted small' }, hint)),
    sw.el);
  return el;
}

function h(tag, attrs, ...children) { return ui.h(tag, attrs, ...children); }
