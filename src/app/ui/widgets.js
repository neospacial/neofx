// Setting widgets (plan §12.1): a label, a slider, a number field, and a reset (double-click or
// double-tap on the label). The default value is marked on the track.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// opts: { label, min, max, step, value, def, unit, onChange(v), key }
export function slider(opts) {
  const row = el('div', 'setting slider');
  row.dataset.key = opts.key || '';
  const label = el('label', null, opts.label);
  label.title = 'Double-click to reset';
  const range = el('input');
  range.type = 'range';
  const num = el('input');
  num.type = 'number';
  for (const i of [range, num]) {
    i.min = opts.min;
    i.max = opts.max;
    i.step = opts.step ?? 1;
    i.value = opts.value;
  }
  num.setAttribute('aria-label', opts.label);
  range.setAttribute('aria-label', opts.label);
  const unit = el('span', 'unit', opts.unit || '');
  const set = (v, fire) => {
    v = Math.max(Number(opts.min), Math.min(Number(opts.max), Number(v)));
    if (!Number.isFinite(v)) return;
    range.value = v;
    num.value = v;
    row.classList.toggle('default', v === opts.def);
    if (fire) opts.onChange(v);
  };
  range.addEventListener('input', () => set(range.value, true));
  num.addEventListener('change', () => set(num.value, true));
  label.addEventListener('dblclick', () => set(opts.def, true));
  // Mark the default on the track.
  if (opts.def !== undefined && opts.max > opts.min) row.style.setProperty('--def', `${((opts.def - opts.min) / (opts.max - opts.min)) * 100}%`);
  row.append(label, range, num, unit);
  set(opts.value, false);
  row.setValue = (v) => set(v, false);
  return row;
}

// opts: { label, options: [[value, text, disabled?]], value, onChange(v), key }
export function segmented(opts) {
  const row = el('div', 'setting seg');
  row.dataset.key = opts.key || '';
  if (opts.label) row.append(el('label', null, opts.label));
  const box = el('div', 'segs');
  box.setAttribute('role', 'radiogroup');
  const buttons = opts.options.map(([v, text, disabled]) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.value = v;
    b.disabled = !!disabled;
    if (disabled) b.title = 'Coming in a later version';
    b.addEventListener('click', () => {
      row.setValue(v);
      opts.onChange(v);
    });
    box.append(b);
    return b;
  });
  row.setValue = (v) => buttons.forEach((b) => b.classList.toggle('on', b.dataset.value === String(v)));
  row.setValue(opts.value);
  row.append(box);
  return row;
}

// opts: { label, value, onChange(v), key }
export function toggle(opts) {
  return segmented({ ...opts, options: [['true', 'On'], ['false', 'Off']], value: String(opts.value), onChange: (v) => opts.onChange(v === 'true') });
}

// A collapsible section.
export function section(title, open = true) {
  const d = el('details', 'section');
  d.open = open;
  d.append(el('summary', null, title));
  return d;
}
