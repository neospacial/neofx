// The preview canvas (plan §12.1, D19). The GPU engine draws into it (from the GPU worker through an
// OffscreenCanvas, or on the main thread). Here: only its CSS size, as large as the area, with the
// aspect of the working size.

export const WORKING_SIZES = [360, 540, 720, 1080, 0]; // short side; 0 = source

export class Preview {
  constructor(canvas, area) {
    this.canvas = canvas;
    this.area = area;
    this.w = 0;
    this.h = 0;
    new ResizeObserver(() => this.fit()).observe(area);
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.fit();
  }

  fit() {
    if (!this.w) return;
    const r = this.area.getBoundingClientRect();
    const s = Math.min(r.width / this.w, r.height / this.h);
    if (!(s > 0)) return;
    this.canvas.style.width = `${Math.floor(this.w * s)}px`;
    this.canvas.style.height = `${Math.floor(this.h * s)}px`;
  }
}
