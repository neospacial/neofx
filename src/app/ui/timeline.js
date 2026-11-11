// Transport and timeline (plan §12.2, §12.3, §12.7): buttons, time, frame number, Loop, the
// thumbnail strip with the playhead and the In / Out markers. Drag on the strip to scrub.

// The play / pause icons (SVG: the media symbols are emoji on iOS).
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15L19.5 12z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>';

export function formatTime(us) {
  const cs = Math.max(0, Math.floor(us / 10000));
  const m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export class Timeline {
  constructor(root, player) {
    this.root = root;
    this.player = player;
    this.thumbs = [];
    this.$ = (sel) => root.querySelector(sel);
    this.strip = this.$('.strip');
    this.ctx = this.strip.getContext('2d');
    const P = player;
    const on = (sel, fn) => this.$(sel).addEventListener('click', fn);
    on('[data-act=first]', () => P.seek(P.range()[0] === P.current ? 0 : P.range()[0]));
    on('[data-act=prev]', () => P.step(-1));
    on('[data-act=play]', () => P.toggle());
    on('[data-act=next]', () => P.step(1));
    on('[data-act=last]', () => P.seek(P.range()[1] === P.current ? P.frameCount - 1 : P.range()[1]));
    on('[data-act=loop]', () => {
      P.loop = !P.loop;
      this.update();
    });
    on('[data-act=in]', () => this.setIn());
    on('[data-act=out]', () => this.setOut());
    // Scrub: pointer down and move on the strip.
    let drag = false;
    const scrub = (e) => {
      const r = this.strip.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      P.seek(Math.round(x * (P.frameCount - 1)));
    };
    this.strip.addEventListener('pointerdown', (e) => {
      if (!P.info) return;
      drag = true;
      this.strip.setPointerCapture(e.pointerId);
      scrub(e);
    });
    this.strip.addEventListener('pointermove', (e) => drag && scrub(e));
    const end = () => (drag = false);
    this.strip.addEventListener('pointerup', end);
    this.strip.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.draw()).observe(this.strip);
  }

  setIn() {
    const P = this.player;
    P.inPoint = P.inPoint === P.current ? null : P.current;
    this.update();
  }

  setOut() {
    const P = this.player;
    P.outPoint = P.outPoint === P.current ? null : P.current;
    this.update();
  }

  reset() {
    this.thumbs = [];
    this.update();
  }

  addThumb(i, index, bitmap) {
    this.thumbs[i] = { index, bitmap };
    this.draw();
  }

  update() {
    const P = this.player;
    const info = P.info;
    const t = Math.max(0, P.current);
    const play = this.$('[data-act=play]');
    if (play.dataset.icon !== String(P.playing)) {
      play.dataset.icon = String(P.playing);
      play.innerHTML = P.playing ? ICON_PAUSE : ICON_PLAY;
    }
    play.setAttribute('aria-label', P.playing ? 'Pause' : 'Play');
    this.$('[data-act=loop]').classList.toggle('on', P.loop);
    this.$('[data-act=in]').classList.toggle('on', P.inPoint !== null);
    this.$('[data-act=out]').classList.toggle('on', P.outPoint !== null);
    this.$('.time').textContent = info ? `${formatTime(info.times[t])} / ${formatTime(info.durationUs)}` : '00:00.00 / 00:00.00';
    this.$('.frame').textContent = info ? `f ${t}` : 'f –';
    this.draw();
  }

  draw() {
    const c = this.strip;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const P = this.player;
    const n = P.frameCount;
    if (!n) return;
    const count = this.thumbs.length ? Math.max(this.thumbs.length, 50) : 50;
    const tw = w / count;
    for (let i = 0; i < this.thumbs.length; i++) {
      const th = this.thumbs[i];
      if (!th) continue;
      const b = th.bitmap;
      // Cover the cell, centered.
      const s = Math.max(tw / b.width, h / b.height);
      const sw = tw / s, sh = h / s;
      ctx.drawImage(b, (b.width - sw) / 2, (b.height - sh) / 2, sw, sh, i * tw, 0, Math.ceil(tw), h);
    }
    const x = (t) => (n > 1 ? (t / (n - 1)) * (w - 2 * dpr) + dpr : w / 2);
    const [a, b] = P.range();
    if (P.inPoint !== null || P.outPoint !== null) {
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(0, 0, x(a), h);
      ctx.fillRect(x(b), 0, w - x(b), h);
      ctx.fillStyle = '#f5a524';
      ctx.fillRect(x(a) - dpr, 0, 2 * dpr, h);
      ctx.fillRect(x(b) - dpr, 0, 2 * dpr, h);
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#eee100';
    ctx.fillRect(x(Math.max(0, P.current)) - dpr, 0, 2 * dpr, h);
  }
}
