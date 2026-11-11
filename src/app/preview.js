// The preview canvas (plan §12.1, §12.2, D19). The GPU engine draws into it (from the GPU worker
// through an OffscreenCanvas, or on the main thread). Here: its CSS size and place. Zoom: Fit (the
// default: as large as the area), 100 % (one working pixel = one CSS pixel), the mouse wheel (about
// the pointer), pan with the middle button or Space + drag, and two fingers (pinch and pan) on touch.
// One finger stays for the tools (line, brush, eyedropper).

export const WORKING_SIZES = [360, 540, 720, 1080, 0]; // short side; 0 = source

export class Preview {
  constructor(canvas, area) {
    this.canvas = canvas;
    this.area = area;
    this.w = 0;
    this.h = 0;
    this.zoom = null; // null = Fit; else the scale (CSS px for each working px)
    this.pan = [0, 0]; // the offset of the canvas centre from the area centre (CSS px)
    this.onChange = null;
    this.space = false;
    new ResizeObserver(() => this.fit()).observe(area);
    // Space held: drag to pan. spacePanned: a pan happened while Space was down (then Space does
    // not toggle playback when it comes up).
    this.spacePanned = false;
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' && !e.repeat && !e.target.closest('input, select, textarea')) {
        this.space = true;
        this.spacePanned = false;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.space = false;
    });
    area.addEventListener('wheel', (e) => {
      if (!this.w) return;
      e.preventDefault();
      this.zoomAt(this.scale() * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
    // Pan (middle button, or Space + left button) and pinch (two touch pointers).
    const touches = new Map();
    let pan = null, pinch = null;
    area.addEventListener('pointerdown', (e) => {
      if (!this.w) return;
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, [e.clientX, e.clientY]);
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: this.scale(), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], pan: this.pan.slice() };
          e.stopPropagation();
        }
        return;
      }
      if (e.button === 1 || (e.button === 0 && this.space)) {
        e.preventDefault();
        e.stopPropagation();
        area.setPointerCapture(e.pointerId);
        pan = { x: e.clientX, y: e.clientY, pan: this.pan.slice() };
      }
    }, true);
    area.addEventListener('pointermove', (e) => {
      if (pan) {
        this.setPan([pan.pan[0] + e.clientX - pan.x, pan.pan[1] + e.clientY - pan.y]);
        if (this.space) this.spacePanned = true;
        return;
      }
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, [e.clientX, e.clientY]);
        if (pinch && touches.size === 2) {
          const [a, b] = [...touches.values()];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          this.pan = [pinch.pan[0] + mid[0] - pinch.mid[0], pinch.pan[1] + mid[1] - pinch.mid[1]];
          this.zoomAt(pinch.s * (d / Math.max(1, pinch.d)), mid[0], mid[1], true);
          e.stopPropagation();
        }
      }
    }, true);
    const up = (e) => {
      pan = null;
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    };
    area.addEventListener('pointerup', up, true);
    area.addEventListener('pointercancel', up, true);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.fit();
  }

  fitScale() {
    const r = this.area.getBoundingClientRect();
    return Math.min(r.width / this.w, r.height / this.h);
  }

  scale() {
    return this.zoom ?? this.fitScale();
  }

  // 'fit' or a scale (1 = 100 %).
  setZoom(z) {
    this.zoom = z === 'fit' ? null : z;
    if (z === 'fit') this.pan = [0, 0];
    this.fit();
  }

  setPan(p) {
    this.pan = p;
    this.fit();
  }

  // Zoom to scale s; the picture point under (cx, cy) stays there.
  zoomAt(s, cx, cy, keepPan = false) {
    const fit = this.fitScale();
    s = Math.min(16, Math.max(fit * 0.25, s));
    const r = this.area.getBoundingClientRect();
    if (!keepPan) {
      const old = this.scale();
      const ox = cx - (r.left + r.width / 2 + this.pan[0]), oy = cy - (r.top + r.height / 2 + this.pan[1]);
      this.pan = [this.pan[0] + ox - (ox * s) / old, this.pan[1] + oy - (oy * s) / old];
    }
    this.zoom = Math.abs(s - fit) < 1e-3 ? null : s;
    this.fit();
  }

  fit() {
    if (!this.w) return;
    const r = this.area.getBoundingClientRect();
    const s = this.scale();
    if (!(s > 0)) return;
    const cw = this.w * s, ch = this.h * s;
    const st = this.canvas.style;
    st.position = 'absolute';
    st.width = `${Math.round(cw)}px`;
    st.height = `${Math.round(ch)}px`;
    st.left = `${Math.round((r.width - cw) / 2 + this.pan[0])}px`;
    st.top = `${Math.round((r.height - ch) / 2 + this.pan[1])}px`;
    if (this.onChange) this.onChange();
  }
}
