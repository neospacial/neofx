// Direct control on the preview (plan §8.1, §12.1): the Mode 2 source line. Drag the centre point to
// move the line, drag the round handle to turn it (Shift or the Snap button: steps of 15°), touch the
// arrow to flip the scan direction.

// SVG elements, made by the HTML parser (it gives them the SVG namespace).
const mk = (tag, attrs) => {
  const box = document.createElement('div');
  box.innerHTML = tag === 'svg' ? '<svg></svg>' : `<svg><${tag}/></svg>`;
  const e = tag === 'svg' ? box.firstChild : box.firstChild.firstChild;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export class LineHandles {
  // app: { change(path, value), settings }
  constructor(area, canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.snap = false;
    const svg = (this.svg = mk('svg', { id: 'handles', class: 'handles' }));
    this.line = mk('line', { class: 'hLine' });
    this.arrow = mk('path', { class: 'hArrow' });
    this.arrowHit = mk('path', { class: 'hArrowHit', 'data-handle': 'flip' }); // a wider target
    this.center = mk('circle', { class: 'hPoint', r: 9, 'data-handle': 'move' });
    this.rot = mk('circle', { class: 'hRot', r: 8, 'data-handle': 'rotate' });
    svg.append(this.line, this.arrow, this.arrowHit, this.center, this.rot);
    this.snapBtn = document.createElement('button');
    this.snapBtn.type = 'button';
    this.snapBtn.className = 'snapBtn';
    this.snapBtn.textContent = 'Snap 15°';
    this.snapBtn.addEventListener('click', () => {
      this.snap = !this.snap;
      this.snapBtn.classList.toggle('on', this.snap);
    });
    area.append(svg, this.snapBtn);
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      const h = e.target.dataset && e.target.dataset.handle;
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      if (h === 'flip') {
        this.app.change('slitscan.flip', !this.app.settings.slitscan.flip);
        return;
      }
      drag = h;
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { x, y, r } = this.toFrame(e.clientX, e.clientY);
      const S = this.app.settings.slitscan;
      if (drag === 'move') {
        this.app.change('slitscan.x', Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000);
        this.app.change('slitscan.y', Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000);
      } else {
        // The angle of the line through the point, to the pointer (in pixels of the picture).
        let a = (Math.atan2((y - S.y) * r.h, (x - S.x) * r.w) * 180) / Math.PI;
        a = ((a % 360) + 360) % 360;
        if (e.shiftKey || this.snap) a = (Math.round(a / 15) * 15) % 360;
        this.app.change('slitscan.angle', Math.round(a * 10) / 10);
      }
    });
    const end = () => (drag = null);
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.update()).observe(area);
  }

  toFrame(cx, cy) {
    const b = this.canvas.getBoundingClientRect();
    return { x: (cx - b.left) / b.width, y: (cy - b.top) / b.height, r: { w: b.width, h: b.height } };
  }

  update() {
    const S = this.app.settings;
    const show = S.mode === 'slitscan' && S.view !== 'original' && !this.canvas.hidden;
    this.svg.style.display = show ? '' : 'none';
    this.snapBtn.style.display = show ? '' : 'none';
    if (!show) return;
    // The overlay covers the canvas only (the line is clipped to the picture).
    const b = this.canvas.getBoundingClientRect();
    const a = this.svg.parentElement.getBoundingClientRect();
    this.svg.style.left = `${b.left - a.left}px`;
    this.svg.style.top = `${b.top - a.top}px`;
    const ox = 0, oy = 0;
    const sl = S.slitscan;
    const px = ox + sl.x * b.width, py = oy + sl.y * b.height;
    const t = (sl.angle * Math.PI) / 180;
    const e = [Math.cos(t), Math.sin(t)];
    let d = [Math.sin(t), -Math.cos(t)];
    if (sl.flip) d = [-d[0], -d[1]];
    const L = Math.hypot(b.width, b.height);
    this.svg.setAttribute('width', b.width);
    this.svg.setAttribute('height', b.height);
    this.line.setAttribute('x1', px - e[0] * L);
    this.line.setAttribute('y1', py - e[1] * L);
    this.line.setAttribute('x2', px + e[0] * L);
    this.line.setAttribute('y2', py + e[1] * L);
    this.center.setAttribute('cx', px);
    this.center.setAttribute('cy', py);
    const rd = Math.min(70, 0.3 * Math.min(b.width, b.height));
    this.rot.setAttribute('cx', px + e[0] * rd);
    this.rot.setAttribute('cy', py + e[1] * rd);
    // The arrow: from the point, in the scan direction.
    const ax = px + d[0] * 34, ay = py + d[1] * 34, bx = px + d[0] * 14, by = py + d[1] * 14;
    const n = [-d[1] * 7, d[0] * 7];
    const path = `M${bx},${by} L${ax},${ay} M${ax - d[0] * 10 + n[0]},${ay - d[1] * 10 + n[1]} L${ax},${ay} L${ax - d[0] * 10 - n[0]},${ay - d[1] * 10 - n[1]}`;
    this.arrow.setAttribute('d', path);
    this.arrowHit.setAttribute('d', path);
  }
}
