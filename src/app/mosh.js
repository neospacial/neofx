// Mode 3, Datamosh (from neomosh, file source only): the page side. The codec runs in the mosh
// worker (src/mosh/mosh-worker.js), which also keeps the session. Here: the session state for the UI,
// the mosh picture on a canvas over the preview, the record / bloom controls, and the export dialog.
//
// A session is a list of clips. Each clip is recorded from the open video, from the playhead. The
// first frame of a new clip is a hidden I-frame (a cut): it is not shown, so the P-frames of the new
// clip move the last picture of the clip before. Open another video at a pause point to mosh into it.

import { makeWorker } from './player.js';

export const MOSH_SIZES = [360, 480, 720, 1080];
export const MOSH_RATES = [15, 24, 30];
export const MOSH_LOOK = { qp: 30, searchRange: 32, precision: 'quarter', skipBias: 50, heal: 'low', denoise: 'low' }; // neomosh DEFAULT_SETTINGS
export const MOSH_DEFAULTS = { size: 480, fps: 30, ...MOSH_LOOK, guide: 0.5, preview: true };

// The picture size of a session: the shape of the source, `short` px on the short side (never above
// the source), even numbers, at most 1920 px on the long side.
export function moshSize(w, h, short) {
  const s = Math.min(1, short / Math.min(w, h), 1920 / Math.max(w, h));
  const even = (v) => Math.max(16, Math.round((v * s) / 2) * 2);
  return { w: even(w), h: even(h) };
}

const lookOf = (m) => ({ qp: Math.round(m.qp), searchRange: Number(m.searchRange), precision: m.precision, skipBias: Math.round(m.skipBias), heal: m.heal, denoise: m.denoise });

const clock = (us) => {
  const ds = Math.floor(Math.max(0, us) / 100000);
  return `${Math.floor(ds / 600)}:${String(Math.floor(ds / 10) % 60).padStart(2, '0')}.${ds % 10}`;
};

const el = (tag, attrs = {}, text) => {
  const e = Object.assign(document.createElement(tag), attrs);
  if (text !== undefined) e.textContent = text;
  return e;
};

export class Mosh {
  // app: { workerSrc, canvas, bar, dialog, settings (the live settings object), player, file(), info(),
  //        message(text), changed() (the session changed: build the inspector again), playhead(us)
  //        (the file time while recording), seekSource(us, ended) (after a clip) }
  constructor(app) {
    this.app = app;
    this.wk = null;
    this.state = 'idle'; // 'idle' | 'recording' | 'blooming' | 'playing'
    this.session = null; // { w, h, fps, frames, durationUs, bytes, cuts, points, canBloom }
    this.thumbs = []; // an ImageBitmap for each pause point
    this.lookUs = null; // the session time on the view (History), or null: the last picture
    this.waiters = {};
    this.ctx = app.canvas.getContext('2d');
    this.hasPicture = false;
    this.exporting = false;
    const b = app.bar;
    this.recBtn = b.querySelector('[data-act="rec"]');
    this.bloomBtn = b.querySelector('[data-act="bloom"]');
    this.infoEl = b.querySelector('.moshInfo');
    this.recBtn.addEventListener('click', () => this.toggle());
    // Bloom: while the button is held.
    const down = (e) => {
      e.preventDefault();
      this.bloom(true);
    };
    const up = () => this.bloom(false);
    this.bloomBtn.addEventListener('pointerdown', down);
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) this.bloomBtn.addEventListener(ev, up);
    this.update();
  }

  get on() {
    return this.app.settings.mode === 'datamosh';
  }

  get busy() {
    return this.state !== 'idle';
  }

  get frames() {
    return this.session ? this.session.frames : 0;
  }

  once(cmd) {
    return new Promise((resolve) => (this.waiters[cmd] = this.waiters[cmd] || []).push(resolve));
  }

  // The worker and an empty session for the settings and the open video. With frames in the session,
  // its size and frame rate stay.
  async ensure() {
    const info = this.app.info();
    if (!info) return false;
    const M = this.app.settings.mosh;
    const size = moshSize(info.width, info.height, Number(M.size));
    const fps = Number(M.fps);
    const s = this.session;
    if (this.wk && s && (s.frames > 0 || (s.w === size.w && s.h === size.h && s.fps === fps))) return true;
    if (!this.wk) {
      this.wk = makeWorker(this.app.workerSrc);
      this.wk.onmessage = (e) => this.onMessage(e.data);
      this.wk.onerror = (e) => {
        this.app.message(e.message || 'The datamosh worker failed.');
        this.close();
      };
    }
    const ready = this.once('ready');
    this.wk.postMessage({ cmd: 'init', w: size.w, h: size.h, fps, settings: lookOf(M) });
    await ready;
    return true;
  }

  close() {
    if (this.wk) this.wk.terminate();
    this.wk = null;
    this.session = null;
    for (const t of this.thumbs) if (t && t.close) t.close();
    this.thumbs = [];
    this.state = 'idle';
    this.hasPicture = false;
    for (const list of Object.values(this.waiters)) for (const r of list) r(null);
    this.waiters = {};
    this.update();
    this.app.changed();
  }

  setSession(m) {
    this.session = { w: m.w, h: m.h, fps: m.fps, frames: m.frames, durationUs: m.durationUs, bytes: m.bytes, cuts: m.cuts, points: m.points, canBloom: m.canBloom };
    for (const t of this.thumbs.splice(m.points.length)) if (t && t.close) t.close();
  }

  onMessage(m) {
    if (m.cmd === 'ready' || m.cmd === 'state' || m.cmd === 'paused') {
      this.setSession(m);
      if (m.thumb) this.thumbs[m.points.length - 1] = m.thumb;
      if (m.picture) this.draw(m.picture);
      else if (!m.frames) this.hasPicture = false;
      if (m.cmd === 'paused') {
        const was = this.state;
        this.state = 'idle';
        this.lookUs = null;
        if (was === 'recording' && m.lastUs !== undefined) this.app.seekSource(m.lastUs, m.ended);
      }
      this.update();
      this.app.changed();
    } else if (m.cmd === 'frame') {
      const s = this.session;
      if (s) Object.assign(s, { frames: m.frames, bytes: m.bytes });
      this.clipUs = m.tsUs;
      if (m.picture) this.draw(m.picture);
      if (m.fileUs !== undefined) this.app.playhead(m.fileUs);
      this.info();
    } else if (m.cmd === 'picture') {
      this.lookUs = m.tsUs;
      this.draw(m.picture);
      this.lookSlider();
    } else if (m.cmd === 'playEnd') {
      if (this.state === 'playing') this.state = 'idle';
      if (!m.stopped) this.lookUs = null;
      this.update();
      this.app.changed();
    } else if (m.cmd === 'error') this.app.message(m.message);
    const list = this.waiters[m.cmd];
    if (list) {
      delete this.waiters[m.cmd];
      for (const r of list) r(m);
    }
    if (m.cmd === 'exportProgress' && this.onExport) this.onExport(m);
  }

  // A picture from the worker (a VideoFrame or an ImageBitmap) on the canvas.
  draw(picture) {
    const c = this.app.canvas, s = this.session;
    if (s && (c.width !== s.w || c.height !== s.h)) {
      c.width = s.w;
      c.height = s.h;
    }
    try {
      this.ctx.drawImage(picture, 0, 0, c.width, c.height);
      this.hasPicture = true;
    } catch { /* a closed picture */ }
    picture.close();
    if (this.wk) this.wk.postMessage({ cmd: 'shown' });
    this.show();
  }

  // The canvas: the mosh picture while a clip or the playback runs; while paused, the last picture
  // over the source at the Guide opacity (to align the next shot); in the other modes, hidden.
  show() {
    const c = this.app.canvas;
    const visible = this.on && this.hasPicture && !!this.app.info();
    c.hidden = !visible;
    if (!visible) return;
    const live = this.busy || this.lookUs !== null;
    c.style.opacity = live ? '1' : String(this.app.settings.mosh.guide);
  }

  // The same place as the preview canvas (the picture keeps its shape inside that box).
  place(view) {
    const c = this.app.canvas;
    for (const k of ['left', 'top', 'width', 'height']) c.style[k] = view.style[k];
  }

  info() {
    const s = this.session;
    const us = this.busy && this.state !== 'playing' && this.clipUs !== undefined ? this.clipUs : s ? s.durationUs : 0;
    const text = s && s.frames ? `${clock(us)} · ${s.points.length + (this.state === 'recording' || this.state === 'blooming' ? 1 : 0)} clip${s.points.length === 1 && !this.busy ? '' : 's'} · ${s.w}×${s.h} · ${(s.bytes / 1048576).toFixed(1)} MB` : 'Move the playhead to the start of the shot, then record.';
    if (this.infoEl.textContent !== text) this.infoEl.textContent = text;
  }

  update() {
    const rec = this.state === 'recording';
    document.body.dataset.mosh = this.state;
    this.recBtn.classList.toggle('on', rec);
    this.recBtn.setAttribute('aria-label', rec ? 'Pause the recording' : 'Record');
    this.recBtn.title = rec ? 'Pause (R)' : 'Record from the playhead (R)';
    this.recBtn.disabled = this.state === 'blooming' || this.exporting;
    this.bloomBtn.disabled = rec || this.state === 'playing' || this.exporting || !(this.session && this.session.canBloom);
    this.bloomBtn.classList.toggle('on', this.state === 'blooming');
    this.info();
    this.show();
  }

  settingsChanged() {
    if (this.wk && this.session) this.wk.postMessage({ cmd: 'settings', settings: lookOf(this.app.settings.mosh) });
    this.show();
  }

  toggle() {
    return this.state === 'recording' ? this.pause() : this.record();
  }

  // Record a clip from the playhead of the open video. opts.fast (tests): no real-time clock.
  async record(opts = {}) {
    if (this.busy || this.exporting || this.starting) return false;
    const info = this.app.info(), P = this.app.player;
    if (!info) return false;
    this.starting = true;
    try {
      P.pause();
      if (!(await this.ensure())) return false;
      let t = Math.max(0, P.current);
      if (t >= info.times.length - 1) t = 0; // at the end: from the start
      this.state = 'recording';
      this.lookUs = null;
      this.clipUs = this.session.durationUs;
      this.update();
      this.wk.postMessage({ cmd: 'record', file: this.app.file(), startUs: info.times[t], keys: info.cleanKeys, preview: this.app.settings.mosh.preview !== false, fast: !!opts.fast });
      return true;
    } finally {
      this.starting = false;
    }
  }

  // End the clip (a pause point). Resolves when the worker has made it.
  async pause() {
    if (this.state !== 'recording' && this.state !== 'blooming') return;
    const p = this.once('paused');
    this.wk.postMessage({ cmd: 'stop' });
    await p;
  }

  async bloom(on) {
    if (on) {
      if (this.state !== 'idle' || this.exporting || !this.session || !this.session.canBloom) return;
      this.state = 'blooming';
      this.lookUs = null;
      this.clipUs = this.session.durationUs;
      this.update();
      this.wk.postMessage({ cmd: 'bloomStart' });
    } else if (this.state === 'blooming') await this.pause();
  }

  // Delete all clips after pause point i (−1: the full video).
  async revert(i) {
    if (!this.wk || this.busy || this.exporting) return;
    const p = this.once('state');
    this.lookUs = null;
    this.wk.postMessage({ cmd: 'revert', point: i });
    await p;
  }

  // History: the picture at a session time; play from there.
  seek(us) {
    if (!this.wk || this.busy || !this.frames) return;
    this.lookUs = us;
    if (this.seeking) {
      this.seekNext = us; // only the newest one
      return;
    }
    this.seeking = true;
    const p = this.once('picture');
    this.wk.postMessage({ cmd: 'seek', tsUs: us });
    p.then(() => {
      this.seeking = false;
      if (this.seekNext !== undefined) {
        const n = this.seekNext;
        this.seekNext = undefined;
        this.seek(n);
      }
    });
  }

  play() {
    if (!this.wk || this.busy || !this.frames) return;
    this.state = 'playing';
    this.update();
    this.wk.postMessage({ cmd: 'play', tsUs: this.lookUs ?? 0 });
    this.app.changed();
  }

  stopPlay() {
    if (this.state === 'playing') this.wk.postMessage({ cmd: 'playStop' });
  }

  // The last picture again (leave the History look).
  live() {
    if (this.busy || !this.wk) return;
    this.lookUs = null;
    if (this.frames) this.seek(this.session.durationUs);
    this.lookUs = null;
    this.show();
  }

  lookSlider() {
    const r = document.querySelector('#inspector .moshScrub');
    if (r && this.lookUs !== null && document.activeElement !== r) r.value = String(this.lookUs / 1e6);
  }

  async canUpscale() {
    if (!this.wk || !this.frames) return null;
    const p = this.once('canUpscale');
    this.wk.postMessage({ cmd: 'canUpscale' });
    return p;
  }

  // opts: { mode: 'original' | 'upscale', cuts: ['mosh' | 'clean', ...] | 'mosh' | 'clean', smooth }.
  // Returns { blob, size, frames, width, height, mode }.
  async export(opts, onProgress) {
    if (!this.wk || !this.frames) throw new Error('Record a clip first.');
    if (this.busy) throw new Error('Pause the recording first.');
    if (this.exporting) throw new Error('An export runs.');
    this.exporting = true;
    this.update();
    this.onExport = onProgress || null;
    try {
      const done = this.once('exported'), failed = this.once('exportFailed');
      this.wk.postMessage({ cmd: 'export', mode: opts.mode || 'original', cuts: opts.cuts ?? 'mosh', smooth: !!opts.smooth });
      const r = await Promise.race([done, failed]);
      delete this.waiters.exported;
      delete this.waiters.exportFailed;
      if (!r) throw new Error('The datamosh worker stopped.');
      if (r.cmd === 'exportFailed') throw new Error(r.message);
      return r;
    } finally {
      this.exporting = false;
      this.onExport = null;
      this.update();
    }
  }

  cancelExport() {
    if (this.wk && this.exporting) this.wk.postMessage({ cmd: 'exportCancel' });
  }

  // R: record / pause. B (held): bloom. Returns true when the key was used.
  key(e, down) {
    if (!this.on || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      if (down && !e.repeat) this.toggle();
      return true;
    }
    if (k === 'b') {
      if (down && !e.repeat) this.bloom(true);
      else if (!down) this.bloom(false);
      return true;
    }
    return false;
  }

  // The export dialog (neomosh plan §9): Original (the recorded frames, copied) or Upscale; for each
  // cut, Mosh (the hidden I-frame is not in the file) or Clean (it shows: a normal cut).
  async openExport() {
    const d = this.app.dialog;
    if (!this.frames || this.busy) {
      this.app.message(this.busy ? 'Pause the recording first.' : 'Datamosh: record a clip first (the red button), then export.');
      return;
    }
    const s = this.session;
    const up = await this.canUpscale();
    d.textContent = '';
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    const form = el('form', { method: 'dialog', className: 'exportForm' });
    form.append(el('h2', {}, 'Export (Datamosh)'));
    const row = (label, input) => {
      const r = el('label', { className: 'exportRow' });
      r.append(el('span', {}, label), input);
      form.append(r);
      return input;
    };
    const sel = (options, value) => {
      const x = el('select');
      for (const [v, t] of options) x.append(el('option', { value: v }, t));
      x.value = value;
      return x;
    };
    const modes = [['original', `Original (${s.w}×${s.h}, the recorded frames)`]];
    if (up && up.ok) modes.push(['sharp', `Upscale ${up.width}×${up.height}, Sharp (the blocks stay)`], ['smooth', `Upscale ${up.width}×${up.height}, Smooth`]);
    const mode = row('Mode', sel(modes, 'original'));
    mode.id = 'moshMode';
    // The cuts: a pause point with frames after it.
    const cutSel = [];
    const cutTimes = s.points.slice(0, s.cuts).map((p) => p.tsUs);
    if (s.cuts > 1) {
      const all = row('All cuts', sel([['', '—'], ['mosh', 'Mosh'], ['clean', 'Clean']], ''));
      all.addEventListener('change', () => {
        if (all.value) for (const c of cutSel) c.value = all.value;
      });
    }
    const box = el('div', { className: 'moshCuts' });
    for (let i = 0; i < s.cuts; i++) {
      const r = el('label', { className: 'exportRow' });
      const c = sel([['mosh', 'Mosh'], ['clean', 'Clean']], 'mosh');
      c.dataset.cut = String(i);
      cutSel.push(c);
      r.append(el('span', {}, `Cut ${i + 1} (${clock(cutTimes[i] ?? 0)})`), c);
      box.append(r);
    }
    form.append(box);
    if (!s.cuts) form.append(el('p', { className: 'note' }, 'One clip: no cut. Record again from another place (or another video) for a mosh.'));
    const base = this.app.file() ? this.app.file().name.replace(/\.[^.]+$/, '') : 'neofx';
    const name = row('File name', el('input', { type: 'text', value: `${base}-mosh.mp4` }));
    const prog = el('div', { className: 'exportProgress', hidden: true });
    const bar = el('div', { className: 'bar' });
    const text = el('p', { className: 'exportText' });
    prog.append(el('div', { className: 'track' }), text);
    prog.firstChild.append(bar);
    form.append(prog);
    form.append(el('p', { className: 'note' }, 'No audio (the clips come from different places). Original is a true datamosh stream: each player shows the same pictures.'));
    const buttons = el('div', { className: 'exportButtons' });
    const cancel = el('button', { type: 'button', id: 'moshCancel' }, 'Cancel');
    const go = el('button', { type: 'button', className: 'primary', id: 'moshGo' }, 'Export');
    buttons.append(cancel, go);
    form.append(buttons);
    d.append(form);
    cancel.addEventListener('click', () => {
      if (this.exporting) this.cancelExport();
      else d.close();
    });
    d.oncancel = (e) => {
      if (!this.exporting) return;
      e.preventDefault();
      this.cancelExport();
    };
    d.onclose = () => {
      if (this.exporting) this.cancelExport();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
    };
    go.addEventListener('click', async () => {
      if (this.exporting) return;
      go.disabled = true;
      for (const i of form.querySelectorAll('select, input')) i.disabled = true;
      prog.hidden = false;
      text.textContent = 'Preparing…';
      try {
        const r = await this.export({ mode: mode.value === 'original' ? 'original' : 'upscale', smooth: mode.value === 'smooth', cuts: cutSel.map((c) => c.value) }, (p) => {
          bar.style.width = `${Math.round((100 * p.done) / p.total)}%`;
          text.textContent = `${p.done} / ${p.total} frames`;
        });
        if (!d.open || !form.isConnected) return;
        bar.style.width = '100%';
        text.textContent = `Done: ${r.width}×${r.height}, ${r.frames} frames, ${(r.size / 1048576).toFixed(1)} MB.`;
        const file = new File([r.blob], name.value || `${base}-mosh.mp4`, { type: 'video/mp4' });
        this.url = URL.createObjectURL(file);
        buttons.textContent = '';
        const close = el('button', { type: 'button' }, 'Close');
        close.addEventListener('click', () => d.close());
        buttons.append(close);
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          const sh = el('button', { type: 'button', id: 'moshShare' }, 'Share');
          sh.addEventListener('click', () => navigator.share({ files: [file], title: file.name }).catch(() => {}));
          buttons.append(sh);
        }
        buttons.append(el('a', { href: this.url, download: file.name, className: 'button primary', id: 'moshDownload' }, 'Download'));
      } catch (e) {
        text.textContent = e.message;
        cancel.textContent = 'Close';
      }
    });
    d.showModal();
  }
}
