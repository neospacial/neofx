// The player (plan §6.2, §12.8): one decode worker for the preview, one for the timeline thumbnails.
// It shows frame-exact pictures for seeks, and plays at the file's own frame times (VFR included).
// When the preview cannot hold the speed, it drops frames (in playback only).

export function makeWorker(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const wk = new Worker(url);
  URL.revokeObjectURL(url);
  return wk;
}

// opts: { present(index, frame) (draw it; the player closes it after), onState(player), onThumb(i, index, bitmap) }.
export class Player {
  constructor(workerSrc, opts) {
    this.src = workerSrc;
    this.opts = opts;
    this.wk = null;
    this.thumbWk = null;
    this.info = null;
    this.job = 0;
    this.current = -1; // the frame index on the preview
    this.playing = false;
    this.loop = false;
    this.inPoint = null;
    this.outPoint = null;
    this.busy = false; // a seek runs
    this.pendingSeek = null;
    this.queue = []; // playback: decoded frames, in display order
    this.raf = 0;
    this.clock = null; // { wall, us }
    this.stats = { shown: 0, dropped: 0, t0: 0, fps: 0 };
    this.log = []; // the presented frame indices of the last playback (for tests)
  }

  get frameCount() {
    return this.info ? this.info.times.length : 0;
  }

  // Open a file. Resolves with the info, or rejects with the message for the user.
  open(file) {
    this.close();
    this.wk = makeWorker(this.src);
    return new Promise((resolve, reject) => {
      this.wk.onmessage = (e) => {
        const m = e.data;
        if (m.cmd === 'info') {
          this.info = m;
          this.wk.onmessage = (ev) => this.onMessage(ev.data);
          this.startThumbs(file);
          resolve(m);
        } else if (m.cmd === 'error') {
          this.close();
          reject(new Error(m.message));
        }
      };
      this.wk.onerror = (e) => reject(new Error(e.message || 'Decode worker failed.'));
      this.wk.postMessage({ cmd: 'open', file });
    });
  }

  close() {
    this.pause();
    for (const w of [this.wk, this.thumbWk]) if (w) w.terminate();
    this.wk = this.thumbWk = null;
    this.info = null;
    this.current = -1;
    this.busy = false;
    this.pendingSeek = null;
  }

  startThumbs(file) {
    this.thumbWk = makeWorker(this.src);
    this.thumbWk.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'info') this.thumbWk.postMessage({ cmd: 'thumbs', job: 1, count: 50, width: 160 });
      else if (m.cmd === 'thumb' && this.opts.onThumb) this.opts.onThumb(m.i, m.index, m.bitmap);
      else if (m.cmd === 'done' || m.cmd === 'error') {
        this.thumbWk.terminate();
        this.thumbWk = null;
      }
    };
    this.thumbWk.postMessage({ cmd: 'open', file });
  }

  range() {
    const n = this.frameCount;
    const a = this.inPoint ?? 0, b = this.outPoint ?? n - 1;
    return [Math.min(a, b), Math.max(a, b)];
  }

  state() {
    if (this.opts.onState) this.opts.onState(this);
  }

  // Show frame t (frame-exact). Seeks that come while one runs are joined: only the last one runs.
  seek(t) {
    if (!this.info) return Promise.resolve();
    t = Math.max(0, Math.min(this.frameCount - 1, Math.round(t)));
    if (this.playing) this.pause();
    return new Promise((resolve) => {
      if (this.pendingSeek) this.pendingSeek.resolve();
      this.pendingSeek = { t, resolve };
      if (!this.busy) this.nextSeek();
    });
  }

  nextSeek() {
    const p = this.pendingSeek;
    if (!p) return;
    this.pendingSeek = null;
    this.busy = true;
    this.seekDone = p.resolve;
    this.target = p.t;
    this.wk.postMessage({ cmd: 'seek', job: ++this.job, t: p.t, depth: 0 });
  }

  step(n) {
    const base = this.pendingSeek ? this.pendingSeek.t : this.busy ? this.target : this.current;
    return this.seek(Math.max(0, base) + n);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.info || this.playing) return;
    const [a, b] = this.range();
    let from = this.current + 1;
    if (from > b || from < a) from = a;
    this.playing = true;
    this.pendingSeek = null;
    this.busy = false;
    this.queue = [];
    this.clock = null;
    this.log = [];
    this.stats = { shown: 0, dropped: 0, t0: performance.now(), fps: 0 };
    this.playTo = b;
    this.wk.postMessage({ cmd: 'play', job: ++this.job, from, to: b });
    this.raf = requestAnimationFrame((now) => this.tick(now));
    this.state();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.wk) this.wk.postMessage({ cmd: 'stop' });
    this.job++;
    for (const q of this.queue) this.release(q.frame);
    this.queue = [];
    this.state();
  }

  release(frame) {
    frame.close();
    if (this.wk) this.wk.postMessage({ cmd: 'ack' });
  }

  show(index, frame) {
    this.opts.present(index, frame);
    this.release(frame);
    this.current = index;
  }

  onMessage(m) {
    if (m.cmd === 'frame') {
      if (m.job !== this.job) return this.release(m.frame);
      if (this.playing) {
        this.queue.push({ index: m.index, frame: m.frame });
        return;
      }
      if (m.warm) return this.release(m.frame); // the frame store uses these (phase 3)
      this.show(m.index, m.frame);
      this.state();
    } else if (m.cmd === 'done') {
      if (m.job !== this.job) return;
      if (this.playing) return;
      this.busy = false;
      if (this.seekDone) this.seekDone();
      this.seekDone = null;
      this.nextSeek();
      this.state();
    } else if (m.cmd === 'error') {
      if (m.job !== undefined && m.job !== this.job) return;
      if (this.opts.onError) this.opts.onError(m.message);
      if (this.playing) return this.pause();
      this.busy = false;
      if (this.seekDone) this.seekDone();
      this.seekDone = null;
      this.nextSeek();
      this.state();
    }
  }

  // Playback clock: the file time moves with the wall clock from the first shown frame. The newest
  // frame that is due is shown; older due frames are dropped. The worker keeps at most 4 frames here.
  tick(now) {
    if (!this.playing) return;
    const T = this.info.times;
    if (this.queue.length) {
      const head = this.queue[0];
      if (!this.clock) this.clock = { wall: now, us: T[head.index] };
      const fileUs = this.clock.us + (now - this.clock.wall) * 1000;
      let k = -1;
      for (let i = 0; i < this.queue.length && T[this.queue[i].index] <= fileUs + 4000; i++) k = i;
      if (k >= 0) {
        for (let i = 0; i < k; i++) {
          this.stats.dropped++;
          this.release(this.queue[i].frame);
        }
        const q = this.queue[k];
        this.queue.splice(0, k + 1);
        this.show(q.index, q.frame);
        this.log.push(q.index);
        this.stats.shown++;
        const sec = (now - this.stats.t0) / 1000;
        if (sec > 0.5) this.stats.fps = this.stats.shown / sec;
        this.state();
      }
    }
    if (this.current >= this.playTo && !this.queue.length) {
      if (this.loop) {
        this.playing = false;
        this.current = -1;
        this.play();
        return;
      }
      this.pause();
      return;
    }
    this.raf = requestAnimationFrame((n) => this.tick(n));
  }
}
