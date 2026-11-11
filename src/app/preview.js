// The preview canvas (plan §12.1, D19), Original view. The picture is turned as the file says (tkhd
// rotation), at the working resolution (short side), never above the source size. The GPU worker
// takes this over in phase 3.

import { turnedCrop } from '../io/demux.js';

export const WORKING_SIZES = [360, 540, 720, 1080, 0]; // short side; 0 = source

// The working size for a display size and a short side (0 = source). Even numbers.
export function workingSize(w, h, short) {
  const s = short ? Math.min(1, short / Math.min(w, h)) : 1;
  return { width: Math.max(2, Math.round((w * s) / 2) * 2), height: Math.max(2, Math.round((h * s) / 2) * 2) };
}

export class Preview {
  constructor(canvas, area) {
    this.canvas = canvas;
    this.area = area;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.info = null;
    this.short = 540;
    new ResizeObserver(() => this.fit()).observe(area);
  }

  setSource(info) {
    this.info = info;
    this.resize();
  }

  setShortSide(short) {
    this.short = short;
    this.resize();
  }

  resize() {
    if (!this.info) return;
    const { width, height } = workingSize(this.info.width, this.info.height, this.short);
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    this.fit();
  }

  // The CSS size: as large as the area, with the aspect of the video.
  fit() {
    if (!this.info) return;
    const r = this.area.getBoundingClientRect();
    const s = Math.min(r.width / this.canvas.width, r.height / this.canvas.height);
    if (!(s > 0)) return;
    this.canvas.style.width = `${Math.floor(this.canvas.width * s)}px`;
    this.canvas.style.height = `${Math.floor(this.canvas.height * s)}px`;
  }

  draw(frame) {
    const { width: w, height: h } = this.canvas;
    const rot = this.info.rotation;
    const fw = frame.displayWidth, fh = frame.displayHeight;
    const c = { sx: 0, sy: 0, sw: rot % 180 ? fh : fw, sh: rot % 180 ? fw : fh };
    const t = turnedCrop(rot, fw, fh, c, w, h);
    this.ctx.setTransform(...t.m);
    this.ctx.drawImage(frame, t.sx, t.sy, t.sw, t.sh, 0, 0, t.dw, t.dh);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
