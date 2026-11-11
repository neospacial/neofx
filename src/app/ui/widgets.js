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
  // Long press, then drag: fine steps (×0.1) (plan §12.3). The value follows the pointer from the
  // place of the long press, at a tenth of the normal speed.
  let fine = null, press = 0;
  range.addEventListener('pointerdown', (e) => {
    clearTimeout(press);
    const x0 = e.clientX;
    press = setTimeout(() => {
      fine = { x: x0, v: Number(range.value), w: range.getBoundingClientRect().width || 1 };
      row.classList.add('fine');
    }, 450);
    const move = (ev) => {
      if (!fine && Math.abs(ev.clientX - x0) > 6) clearTimeout(press);
      if (fine) fine.px = ev.clientX;
    };
    const up = () => {
      clearTimeout(press);
      fine = null;
      row.classList.remove('fine');
      range.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    range.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  range.addEventListener('input', () => {
    if (fine && fine.px !== undefined) {
      const st = Number(opts.step ?? 1);
      let v = fine.v + ((fine.px - fine.x) / fine.w) * (opts.max - opts.min) * 0.1;
      v = Math.round(v / st) * st;
      set(Number(v.toFixed(6)), true);
      return;
    }
    set(range.value, true);
  });
  row.fineAt = (v0, dx) => {
    // tests: the value of a fine drag of dx px from v0
    const st = Number(opts.step ?? 1);
    const w = range.getBoundingClientRect().width || 1;
    return Math.round((v0 + (dx / w) * (opts.max - opts.min) * 0.1) / st) * st;
  };
  num.addEventListener('change', () => set(num.value, true));
  label.addEventListener('dblclick', () => set(opts.def, true));
  // Mark the default on the track.
  if (opts.def !== undefined && opts.max > opts.min) row.style.setProperty('--def', `${((opts.def - opts.min) / (opts.max - opts.min)) * 100}%`);
  row.append(label, range, num, unit);
  set(opts.value, false);
  row.setValue = (v) => set(v, false);
  return row;
}

// opts: { label, options: [[value, text, disabled?, why?]], value, onChange(v), key }
export function segmented(opts) {
  const row = el('div', 'setting seg');
  row.dataset.key = opts.key || '';
  if (opts.label) row.append(el('label', null, opts.label));
  const box = el('div', 'segs');
  box.setAttribute('role', 'radiogroup');
  const buttons = opts.options.map(([v, text, disabled, why]) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.value = v;
    b.disabled = !!disabled;
    if (disabled) b.title = why || 'Not available here';
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

// opts: { label, options: [[value, text]], value, onChange(v), key }
export function select(opts) {
  const row = el('div', 'setting select');
  row.dataset.key = opts.key || '';
  const label = el('label', null, opts.label);
  const s = el('select');
  s.setAttribute('aria-label', opts.label);
  for (const [v, text] of opts.options) {
    const o = el('option', null, text);
    o.value = v;
    s.append(o);
  }
  s.value = opts.value;
  s.addEventListener('change', () => opts.onChange(s.value));
  row.setValue = (v) => (s.value = v);
  row.append(label, s);
  return row;
}

// A ramp of 2 to 4 colours. opts: { label, value: ['#rrggbb', ...], onChange(list), key }
export function colors(opts) {
  const row = el('div', 'setting colors');
  row.dataset.key = opts.key || '';
  const label = el('label', null, opts.label);
  const box = el('div', 'colorList');
  let list = opts.value.slice();
  const draw = () => {
    box.textContent = '';
    list.forEach((c, i) => {
      const inp = el('input');
      inp.type = 'color';
      inp.value = c;
      inp.setAttribute('aria-label', `${opts.label} ${i + 1}`);
      inp.addEventListener('input', () => {
        list[i] = inp.value;
        opts.onChange(list.slice());
      });
      box.append(inp);
    });
    const more = el('button', null, '+');
    more.type = 'button';
    more.disabled = list.length >= 4;
    more.setAttribute('aria-label', 'Add a colour');
    more.addEventListener('click', () => {
      list.push(list[list.length - 1]);
      draw();
      opts.onChange(list.slice());
    });
    const less = el('button', null, '−');
    less.type = 'button';
    less.disabled = list.length <= 2;
    less.setAttribute('aria-label', 'Remove a colour');
    less.addEventListener('click', () => {
      list.pop();
      draw();
      opts.onChange(list.slice());
    });
    box.append(less, more);
  };
  row.setValue = (v) => {
    list = v.slice();
    draw();
  };
  draw();
  row.append(label, box);
  return row;
}
