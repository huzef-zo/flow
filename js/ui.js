/**
 * ui.js — shared UI toolkit: hyperscript DOM builder, icon set, toasts &
 * undo, bottom sheets / modals (with Android-back integration), menus,
 * progress rings, the reusable task row (swipe + long-press multi-select),
 * a windowed list renderer, and small form controls.
 *
 * No view logic lives here — views import these primitives.
 */

import * as U from './utils.js';

/* ================================================================== *
 * DOM builder
 * ================================================================== */

/**
 * h('div', {class: 'x', onClick: fn, 'data-id': 1, ariaLabel: 'y'}, children…)
 * Attributes starting with "on" are event listeners; everything else is
 * set via setAttribute (so aria-* / data-* pass through).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  }
  appendChildren(el, children);
  return el;
}
function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/* ================================================================== *
 * Icons (inline SVG, stroke-based, 24×24 viewBox)
 * ================================================================== */

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13l2-7h12l2 7v6H4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  undo: '<path d="M4 10h9a5 5 0 0 1 0 10h-3"/><path d="M8 6l-4 4 4 4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4c4-2 6 2 10 0v8c-4 2-6-2-10 0"/>',
  tag: '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z"/><circle cx="7.5" cy="7.5" r="1"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  flame: '<path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-2 1-3.6 2-5 .6 1.8 1.6 2.8 3 3 0-3-1.5-5 0-7z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M5.2 18.8l2.1-2.1M16.7 7.3l2.1-2.1"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  moon: '<path d="M20 13.5A8.5 8.5 0 1 1 10.5 4a7 7 0 0 0 9.5 9.5z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M21 6H8a4 4 0 0 0-4 4v1"/><path d="M7 22l-4-4 4-4"/><path d="M3 18h13a4 4 0 0 0 4-4v-1"/>',
  pencil: '<path d="M4 20l4.5-1L20 7.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20zM13.5 6.5l3 3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  skip: '<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>',
  reset: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.5 5.9A9.7 9.7 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9M6.6 6.6A16.5 16.5 0 0 0 2 12s3.5 6.5 10 6.5c1.6 0 3-.4 4.2-1"/>',
  sparkle: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z"/><path d="M19 15l.9 2.3L22 18l-2.1.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11.5V16"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-9A6 6 0 0 0 6.2 12 4 4 0 0 0 7 19h10.5z"/>',
  cloudOff: '<path d="M3 3l18 18"/><path d="M8.5 16.5A4.5 4.5 0 0 1 8 7.7M17.5 19H7a4 4 0 0 1-1-7.9"/><path d="M12 8.1A6 6 0 0 1 18 10"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  someday: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  sort: '<path d="M7 4v13M4 14l3 3 3-3M17 20V7M14 10l3-3 3 3"/>',
  volume: '<path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
  dragHandle: '<path d="M12 3v18"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.4-.9 1-.9 1.7M12 17h.01"/>',
};

/** icon('check', 20) → svg element. */
export function icon(name, size = 20, cls = '') {
  const span = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  span.setAttribute('viewBox', '0 0 24 24');
  span.setAttribute('width', size);
  span.setAttribute('height', size);
  span.setAttribute('fill', 'none');
  span.setAttribute('stroke', 'currentColor');
  span.setAttribute('stroke-width', '1.9');
  span.setAttribute('stroke-linecap', 'round');
  span.setAttribute('stroke-linejoin', 'round');
  span.setAttribute('aria-hidden', 'true');
  if (cls) span.setAttribute('class', cls);
  span.innerHTML = P[name] || P.info;
  return span;
}

/* ================================================================== *
 * Toasts + undo
 * ================================================================== */

let toastRoot = null;
function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toast-root', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  return toastRoot;
}

/** Show a toast. action: {label, fn}. */
export function toast(message, { type = 'info', duration = 4200, action = null } = {}) {
  const root = ensureToastRoot();
  const el = h('div', { class: `toast toast-${type}` },
    h('span', { class: 'toast-msg' }, message),
    action && h('button', { class: 'toast-action', onClick: () => { action.fn(); dismiss(); } }, action.label),
    h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onClick: () => dismiss() }, icon('close', 16)),
  );
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

/** Toast with an Undo button — every destructive action calls this. */
export function undoToast(label, undoFn, { duration = 6000 } = {}) {
  U.vibrate(12);
  return toast(label, { action: { label: 'Undo', fn: undoFn }, duration });
}

/* ================================================================== *
 * Layers: sheets & modals (with Android back-button support)
 * ================================================================== */

const layers = [];
let layerSeq = 0;

function layerBase({ dismissible = true } = {}) {
  const backdrop = h('div', { class: 'layer-backdrop' });
  const el = h('div', { class: 'layer-backdrop' }, backdrop); // wrapper removed below
  el.remove();
  return { backdrop };
}

/**
 * openSheet({title, content, onClose}) — bottom sheet (centered panel on
 * wide screens). Returns { el, close, setTitle }. Integrates with the
 * browser back button: opening pushes a history entry; back closes it.
 */
export function openSheet({ title = '', content = null, onClose = null, className = '' } = {}) {
  const token = 'L' + ++layerSeq;
  const body = h('div', { class: `sheet-body ${className}`.trim() });
  const titleEl = h('div', { class: 'sheet-title' }, title);
  const grabber = h('div', { class: 'sheet-grab', 'aria-hidden': 'true' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    grabber, titleEl, body);
  const backdrop = h('div', { class: 'layer-backdrop' });
  const wrap = h('div', { class: 'layer-wrap' }, backdrop, panel);
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));

  const layer = { token, el: wrap, onClose, closed: false };
  layers.push(layer);

  const close = (fromPop = false) => {
    if (layer.closed) return;
    layer.closed = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 240);
    layer.onClose?.();
    if (!fromPop && history.state?.flowLayer === token) history.back();
  };
  layer.close = close;

  // Dismissal: backdrop click, Esc, or dragging the grabber down.
  backdrop.addEventListener('pointerdown', () => close());
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') trapTab(e, panel);
  });
  let dragY = null;
  grabber.addEventListener('pointerdown', (e) => {
    dragY = e.clientY;
    grabber.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  grabber.addEventListener('pointermove', (e) => {
    if (dragY == null) return;
    const dy = Math.max(0, e.clientY - dragY);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (dragY == null) return;
    const dy = e.clientY - dragY;
    dragY = null;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 90) close();
  };
  grabber.addEventListener('pointerup', endDrag);
  grabber.addEventListener('pointercancel', endDrag);

  history.pushState({ flowLayer: token }, '');
  const first = panel.querySelector('input, textarea, button, [tabindex]');
  (first || panel).focus({ preventScroll: true });

  if (content) body.append(content);
  return { el: panel, body, close, setTitle: (t) => { titleEl.textContent = t; panel.setAttribute('aria-label', t); } };
}

/** Centered modal (confirmations, dialogs). Same lifecycle as sheets. */
export function openModal({ title = '', content = null, onClose = null, className = '' } = {}) {
  const token = 'L' + ++layerSeq;
  const body = h('div', { class: `modal-body ${className}`.trim() });
  const titleEl = h('div', { class: 'modal-title' }, title);
  const panel = h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' }, titleEl, body);
  const backdrop = h('div', { class: 'layer-backdrop' });
  const wrap = h('div', { class: 'layer-wrap layer-center' }, backdrop, panel);
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));

  const layer = { token, el: wrap, onClose, closed: false };
  layers.push(layer);
  const close = (fromPop = false) => {
    if (layer.closed) return;
    layer.closed = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
    layer.onClose?.();
    if (!fromPop && history.state?.flowLayer === token) history.back();
  };
  layer.close = close;
  backdrop.addEventListener('pointerdown', () => close());
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') trapTab(e, panel);
  });
  history.pushState({ flowLayer: token }, '');
  if (content) body.append(content);
  return { el: panel, body, close };
}

/** Close the topmost layer (router Esc handling). */
export function closeTopLayer() {
  const top = layers[layers.length - 1];
  if (top) { top.close(); return true; }
  return false;
}
export function hasOpenLayers() { return layers.length > 0; }

// Android back button / browser back closes the topmost layer.
window.addEventListener('popstate', () => {
  const top = layers[layers.length - 1];
  if (top && history.state?.flowLayer !== top.token) top.close(true);
});

function trapTab(e, panel) {
  const focusables = [...panel.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

/** Promise-based confirmation dialog. */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; modal.close(); resolve(v); } };
    const content = h('div', {},
      message && h('p', { class: 'modal-msg' }, message),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onClick: () => finish(false) }, cancelLabel),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => finish(true) }, confirmLabel),
      ),
    );
    const modal = openModal({ title, content, onClose: () => finish(false) });
  });
}

/* ================================================================== *
 * Menus (context / kebab)
 * ================================================================== */

/**
 * menu(items, anchor) — items: {label, icon, danger, disabled, fn} or '---'.
 * Positions below the anchor element (or at {x, y}); closes on outside
 * interaction, Escape or scroll.
 */
export function menu(items, anchor, { align = 'start' } = {}) {
  closeMenus();
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item === '---') { el.append(h('div', { class: 'menu-sep' })); continue; }
    if (item.hidden) continue;
    el.append(h('button', {
      class: `menu-item${item.danger ? ' danger' : ''}`,
      role: 'menuitem',
      disabled: item.disabled || null,
      onClick: () => { closeMenus(); item.fn?.(); },
    },
      item.icon && icon(item.icon, 18),
      h('span', { class: 'menu-label' }, item.label),
    ));
  }
  document.body.append(el);

  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, bottom: anchor.y, top: anchor.y, width: 0 };
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let x = align === 'end' ? rect.right - mw : rect.left;
  x = Math.max(8, Math.min(x, innerWidth - mw - 8));
  let y = rect.bottom + 6;
  if (y + mh > innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  requestAnimationFrame(() => el.classList.add('open'));

  const onDown = (e) => { if (!el.contains(e.target)) closeMenus(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenus(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', closeMenus, { once: true, capture: true });
  }, 0);
  el._cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', closeMenus, true);
  };
  return el;
}
function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) { m._cleanup?.(); m.remove(); }
}

/* ================================================================== *
 * Small components
 * ================================================================== */

/** SVG progress ring; returns {el, set(value)}. */
export function progressRing({ size = 44, stroke = 4, value = 0, label = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.innerHTML =
    `<circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>` +
    `<circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - value)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
  const fg = svg.querySelector('.ring-fg');
  return {
    el: svg,
    set(v) {
      fg.style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(1, v))));
      svg.setAttribute('aria-label', label);
    },
  };
}

/** Segmented control. items: [{label, value}] → {el, set}. */
export function seg(items, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const buttons = items.map((it) => {
    const b = h('button', {
      class: 'seg-btn' + (it.value === value ? ' active' : ''),
      role: 'radio',
      'aria-checked': String(it.value === value),
      onClick: () => { set(it.value); onChange?.(it.value); },
    }, it.label);
    el.append(b);
    return [it.value, b];
  });
  const set = (v) => {
    for (const [val, b] of buttons) {
      b.classList.toggle('active', val === v);
      b.setAttribute('aria-checked', String(val === v));
    }
  };
  return { el, set };
}

/** Toggle switch. Returns {el, set}. */
export function switchEl(checked, onChange, label = '') {
  const b = h('button', { class: 'switch' + (checked ? ' on' : ''), role: 'switch', 'aria-checked': String(checked), 'aria-label': label },
    h('span', { class: 'switch-knob' }));
  b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    onChange?.(on);
  });
  return { el: b, set: (v) => { b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); } };
}

/** Friendly empty state. */
export function emptyState({ icon: ic = 'sun', title = 'Nothing here', body = '', actionLabel = null, onAction = null }) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon(ic, 34)),
    h('div', { class: 'empty-title' }, title),
    body && h('div', { class: 'empty-body' }, body),
    actionLabel && h('button', { class: 'btn btn-primary', onClick: onAction }, actionLabel),
  );
}

/** Markdown renderer with interactive checkboxes. */
export function markdown(text, { onCheckbox = null } = {}) {
  const el = h('div', { class: 'md' });
  el.innerHTML = U.renderMarkdown(text);
  if (onCheckbox) {
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mdcb]');
      if (btn) onCheckbox(Number(btn.dataset.mdcb));
    });
  }
  return el;
}

/* ================================================================== *
 * Task rows (shared by every list view)
 * ================================================================== */

/**
 * taskRow(block, ctx) builds one task row with:
 *  - animated complete button
 *  - swipe right → complete, swipe left → schedule menu
 *  - long-press → enter multi-select (ctx.selection)
 *  - optional drag grip (ctx.onDragStart) for the Today timeline
 * ctx: { onOpen, onComplete, onSchedule, selection, showProject,
 *        onDragStart, indent, viewDate }
 */
export function taskRow(block, ctx = {}) {
  const t = block.props;
  const row = h('div', {
    class: 'task-row' + (ctx.indent ? ` indent-${ctx.indent}` : '') + (ctx.selection?.has(block.id) ? ' selected' : ''),
    role: 'listitem',
    tabindex: '0',
    dataset: { id: block.id },
    'aria-label': ariaLabel(block, ctx),
  });
  const inner = h('div', { class: 'tr-inner' });
  const checkBtn = h('button', {
    class: 'tr-check' + (t.completedAt ? ' done' : '') + ((t.priority ?? 4) <= 3 ? ` p${t.priority}` : ''),
    'aria-label': t.completedAt ? 'Mark as not completed' : 'Complete task',
    onClick: (e) => { e.stopPropagation(); toggleComplete(); },
  }, icon('check', 16));

  const title = h('div', { class: 'tr-title' + (t.completedAt ? ' done' : '') }, t.title || 'Untitled');
  const meta = h('div', { class: 'tr-meta' }, metaChips(block, ctx));
  const main = h('div', { class: 'tr-main' }, title, meta);
  main.addEventListener('click', (e) => {
    if (ctx.selection?.isActive()) { ctx.selection.toggle(block.id); return; }
    ctx.onOpen?.(block);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onOpen?.(block); }
    if (e.key === 'x') { e.preventDefault(); toggleComplete(); }
  });

  const end = h('div', { class: 'tr-end' });
  if ((t.priority ?? 4) <= 3) end.append(h('span', { class: `pflag p${t.priority}`, title: `Priority ${t.priority}` }, icon('flag', 14)));
  if (ctx.onDragStart) {
    const grip = h('button', { class: 'tr-grip', 'aria-label': 'Drag to timeline', touchaction: 'none' }, icon('grip', 18));
    grip.addEventListener('pointerdown', (e) => ctx.onDragStart(e, block));
    end.append(grip);
  }
  inner.append(checkBtn, main, end);
  row.append(
    h('div', { class: 'tr-under tr-under-l' }, icon('check', 22)),
    h('div', { class: 'tr-under tr-under-r' }, icon('calendar', 22)),
    inner,
  );

  /* --- completion (with animation + undo owned by the view) --- */
  let completing = false;
  function toggleComplete() {
    if (completing) return;
    if (t.completedAt) { ctx.onUncomplete?.(block); return; }
    completing = true;
    row.classList.add('completing');
    checkBtn.classList.add('done');
    title.classList.add('done');
    U.vibrate(14);
    setTimeout(() => ctx.onComplete?.(block), 260);
  }

  /* --- swipe gestures (right = complete, left = schedule) --- */
  let sx = 0, sy = 0, dx = 0, mode = null, pointerId = null, longPress = null, longPressed = false;
  inner.style.touchAction = 'pan-y';
  inner.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || ctx.onDragStart && e.target.closest('.tr-grip')) return;
    pointerId = e.pointerId;
    sx = e.clientX; sy = e.clientY; dx = 0; mode = null; longPressed = false;
    if (ctx.selection) {
      longPress = setTimeout(() => {
        longPressed = true;
        U.vibrate([18, 40, 18]);
        ctx.selection.enter(block.id);
      }, 480);
    }
  });
  inner.addEventListener('pointermove', (e) => {
    if (pointerId !== e.pointerId) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (mode === null) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.4) {
        mode = 'swipe';
        clearTimeout(longPress);
        inner.setPointerCapture(e.pointerId);
      } else if (Math.abs(my) > 10) {
        mode = 'scroll';
        clearTimeout(longPress);
      }
      return;
    }
    if (mode !== 'swipe' || longPressed) return;
    dx = mx;
    inner.style.transform = `translateX(${U.clamp(dx, -104, 104)}px)`;
  });
  const endSwipe = (e) => {
    clearTimeout(longPress);
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    if (mode === 'swipe' && !longPressed) {
      inner.style.transform = '';
      if (dx > 68) toggleComplete();
      else if (dx < -68) ctx.onSchedule?.(block);
    }
    mode = null; dx = 0;
  };
  inner.addEventListener('pointerup', endSwipe);
  inner.addEventListener('pointercancel', endSwipe);
  // Long-press select: suppress the click that follows.
  inner.addEventListener('click', (e) => { if (longPressed) { e.stopPropagation(); longPressed = false; } }, true);

  return row;
}

function ariaLabel(block, ctx) {
  const parts = [block.props.title || 'Untitled task'];
  for (const c of metaChips(block, ctx)) parts.push(c.textContent || '');
  return parts.join(', ');
}

/** Small info chips under the title. */
export function metaChips(block, ctx = {}) {
  const s = store => store; // placeholder-free
  const t = block.props;
  const chips = [];
  const today = U.todayStr();
  const project = t.projectId && ctx.showProject ? window.__flowStore?.get(t.projectId) : null;
  if (project) chips.push(h('span', { class: 'chip chip-project' }, project.props.name));
  const day = t.schedule?.date || t.dueDate;
  if (day) {
    const overdue = t.dueDate && t.dueDate < today && !t.completedAt;
    chips.push(h('span', { class: `chip chip-date${overdue ? ' overdue' : day === today ? ' today' : ''}`, title: U.fmtDateLong(day) },
      U.dayLabel(day, today)));
  }
  if (t.schedule?.start != null) chips.push(h('span', { class: 'chip chip-time' }, U.fmtTime(t.schedule.start, window.__flowSettings?.use24h)));
  if (t.recurrence) {
    const lbl = window.__flowStore ? window.__flowStore.describeRule(t.recurrence) : 'Repeats';
    chips.push(h('span', { class: 'chip chip-rec', title: lbl }, icon('repeat', 12), lbl));
  }
  if (t.reminder) chips.push(h('span', { class: 'chip chip-rem', title: `Reminder ${t.reminder}` }, icon('bell', 12)));
  const labels = (t.labels || []).map((id) => window.__flowStore?.get(id)).filter(Boolean);
  for (const l of labels.slice(0, 2)) chips.push(h('span', { class: 'chip chip-label' }, icon('tag', 12), l.props.name));
  if (labels.length > 2) chips.push(h('span', { class: 'chip chip-label' }, `+${labels.length - 2}`));
  const subs = window.__flowStore ? window.__flowStore.childrenOf('task', block.id) : [];
  if (subs.length) {
    const done = subs.filter((x) => x.props.completedAt).length;
    chips.push(h('span', { class: 'chip chip-subs' }, `${done}/${subs.length}`));
  }
  if (t.focusMinutes > 0) chips.push(h('span', { class: 'chip chip-focus' }, icon('timer', 12), U.fmtDuration(t.focusMinutes)));
  if (t.someday) chips.push(h('span', { class: 'chip chip-someday' }, icon('someday', 12), 'Someday'));
  return chips;
}

/* ================================================================== *
 * Multi-select
 * ================================================================== */

/**
 * selection = createSelection({ onChange }) — enter via long-press, toggle
 * rows, exposes a floating action bar with bulk operations.
 */
export function createSelection({ onChange } = {}) {
  const state = { ids: new Set(), active: false };
  const bar = h('div', { class: 'select-bar', role: 'toolbar', 'aria-label': 'Bulk actions' });
  let countEl = null;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(state); onChange?.(state); };

  function renderBar() {
    bar.innerHTML = '';
    if (!state.active) { bar.classList.remove('open'); return; }
    countEl = h('span', { class: 'select-count' }, `${state.ids.size} selected`);
    const mk = (ic, label, fn) => h('button', { class: 'select-action', 'aria-label': label, title: label, onClick: fn }, icon(ic, 20));
    bar.append(
      countEl,
      h('span', { class: 'select-spacer' }),
      mk('check', 'Complete', () => bulk('complete')),
      mk('calendar', 'Date', () => bulk('date')),
      mk('flag', 'Priority', () => bulk('priority')),
      mk('folder', 'Move', () => bulk('move')),
      mk('trash', 'Delete', () => bulk('delete')),
      mk('close', 'Cancel selection', () => api.exit()),
    );
    bar.classList.add('open');
  }

  // Views install handlers for bulk actions.
  const handlers = {};
  const api = {
    el: bar,
    isActive: () => state.active,
    has: (id) => state.active && state.ids.has(id),
    ids: () => [...state.ids],
    count: () => state.ids.size,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onBulk(kind, fn) { handlers[kind] = fn; },
    enter(id) { state.active = true; state.ids = new Set(id ? [id] : []); renderBar(); notify(); },
    toggle(id) {
      if (!state.active) return this.enter(id);
      if (state.ids.has(id)) state.ids.delete(id); else state.ids.add(id);
      if (!state.ids.size) return this.exit();
      renderBar(); notify();
    },
    exit() { state.active = false; state.ids.clear(); renderBar(); notify(); },
    destroy() { state.active = false; state.ids.clear(); bar.remove(); },
  };
  async function bulk(kind) {
    const ids = [...state.ids];
    await handlers[kind]?.(ids);
  }
  renderBar();
  return api;
}

/* ================================================================== *
 * Windowed list rendering (for lists with 200+ rows)
 * ================================================================== */

/**
 * VirtualScroller — absolute-positioned windowed rendering with uniform
 * per-item heights (headers and rows can differ). Attach to the scrolling
 * container; setItems([{key, h, data}]) then renderItem(item) → element.
 */
export class VirtualScroller {
  constructor(container, { renderItem, overhang = 6 } = {}) {
    this.container = container;
    this.renderItem = renderItem;
    this.overhang = overhang;
    this.items = [];
    this.tops = [];
    this.rendered = new Map();
    this.inner = h('div', { class: 'vs-inner' });
    container.append(this.inner);
    this.onScroll = () => this.render();
    container.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(container);
  }
  setItems(items) {
    this.items = items;
    this.tops = new Array(items.length + 1);
    this.tops[0] = 0;
    for (let i = 0; i < items.length; i++) this.tops[i + 1] = this.tops[i] + items[i].h;
    this.inner.style.height = `${this.tops[items.length] || 0}px`;
    this.render(true);
  }
  render(force = false) {
    const st = this.container.scrollTop;
    const vh = this.container.clientHeight || 600;
    const total = this.tops[this.tops.length - 1] || 0;
    let lo = binarySearch(this.tops, st) - this.overhang;
    let hi = binarySearch(this.tops, st + vh) + this.overhang;
    lo = Math.max(0, lo); hi = Math.min(this.items.length, hi);
    if (total <= vh * 3) { lo = 0; hi = this.items.length; } // short list: render all
    const keep = new Set();
    for (let i = lo; i < hi; i++) {
      const item = this.items[i];
      keep.add(item.key);
      let el = this.rendered.get(item.key);
      if (!el || force) {
        el?.remove();
        el = this.renderItem(item);
        el.classList.add('vs-item');
        el.style.top = `${this.tops[i]}px`;
        el.style.height = `${item.h}px`;
        this.inner.append(el);
        this.rendered.set(item.key, el);
      } else {
        el.style.top = `${this.tops[i]}px`;
      }
    }
    for (const [key, el] of this.rendered) {
      if (!keep.has(key)) { el.remove(); this.rendered.delete(key); }
    }
  }
  destroy() {
    this.container.removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
    this.inner.remove();
  }
}
function binarySearch(tops, y) {
  let lo = 0, hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* ================================================================== *
 * Misc
 * ================================================================== */

/** Short confirmation-free beep via WebAudio (no assets needed). */
export function beep(freq = 880, duration = 0.12, { volume = 0.14 } = {}) {
  try {
    const ctx = beep.ctx || (beep.ctx = new AudioContext());
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch { /* audio unavailable */ }
}

/** Standard schedule quick-menu used by swipe-left and task menus. */
export function scheduleMenuItems(block, apply, { showUnschedule = true } = {}) {
  const today = U.todayStr();
  const mk = (label, date, start = null) => ({ label, icon: 'calendar', fn: () => apply({ date, start }) });
  return [
    mk('Today', today, null),
    mk('Tomorrow', U.addDays(today, 1), null),
    { label: 'This evening', icon: 'moon', fn: () => apply({ date: today, start: 18 * 60 }) },
    { label: 'Next week', icon: 'calendar', fn: () => apply({ date: U.addDays(today, 7), start: null }) },
    { label: 'Pick date & time…', icon: 'pencil', fn: () => apply('pick') },
    showUnschedule && { label: 'Clear date', icon: 'close', fn: () => apply(null), danger: true },
  ].filter(Boolean);
}
