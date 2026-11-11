// Layout (plan §12.2, §12.3): the inspector width on desktop (280–520 px, drag the bar), the
// bottom sheet height on a phone (drag the handle up), the ⋯ menu, and the Split view divider.

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch { /* no storage */ }
  },
};

function dragger(el, onMove, onEnd) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    const move = (ev) => onMove(ev);
    const up = () => {
      el.classList.remove('drag');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (onEnd) onEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 520;

// app: { menu: { presets(), undo(), redo() }, split(pos), onResize() }
export function initLayout(app) {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  // Inspector width (desktop).
  const w0 = Number(store.get('neofx.inspectorWidth'));
  if (w0 >= INSPECTOR_MIN && w0 <= INSPECTOR_MAX) root.style.setProperty('--inspector-w', `${w0}px`);
  dragger($('sizer'), (e) => {
    const w = Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, window.innerWidth - e.clientX - 2)));
    root.style.setProperty('--inspector-w', `${w}px`);
    store.set('neofx.inspectorWidth', String(w));
    app.onResize();
  });
  // Sheet height (phone): drag the handle; between 20 % and 85 % of the screen.
  dragger($('sheetHandle'), (e) => {
    const h = Math.min(0.85, Math.max(0.2, (window.innerHeight - e.clientY) / window.innerHeight));
    root.style.setProperty('--sheet-h', `${Math.round(h * 100)}vh`);
    app.onResize();
  });
  // The ⋯ menu.
  const menu = $('menu'), btn = $('menuBtn');
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    close();
    if (act) app.menu[act]();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) close();
  });
  // The Split view divider: drag it over the picture.
  const line = $('splitLine');
  dragger(line, (e) => {
    const b = $('view').getBoundingClientRect();
    app.split(Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)));
  }, () => app.split(null));
  return {
    // Put the divider at pos (0..1 of the picture), or hide it.
    placeSplit(pos) {
      line.hidden = pos === null;
      if (pos === null) return;
      const b = $('view').getBoundingClientRect(), a = $('preview').getBoundingClientRect();
      line.style.left = `${b.left - a.left + pos * b.width}px`;
      line.style.top = `${Math.max(0, b.top - a.top)}px`;
      line.style.height = `${Math.min(a.height, b.height)}px`;
      line.style.bottom = 'auto';
    },
  };
}
