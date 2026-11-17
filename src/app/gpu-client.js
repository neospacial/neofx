// The page side of the GPU engine: the GPU worker when the browser has OffscreenCanvas with WebGL2,
// else the engine on the main thread (plan §4 fallback). call(msg) -> Promise of the reply. The
// replies come in the order of the calls.

import { Engine } from '../gpu/engine.js';
import { makeWorker } from './player.js';

export class GpuClient {
  constructor(canvas, workerSrc, useWorker) {
    this.mode = useWorker ? 'worker' : 'main';
    this.lost = false;
    this.onLost = null; // the GPU context was lost (the browser reset the GPU, often: out of memory)
    this.next = 1;
    this.waiting = new Map();
    this.settingsBusy = 0; // the count of 'settings' messages at the worker
    this.settingsNext = null; // the newest settings that wait: { settings, promise, resolve, reject }
    if (useWorker) {
      this.wk = makeWorker(workerSrc);
      // The worker script failed: the calls that wait (also 'init') fail, not hang.
      this.wk.onerror = (e) => {
        const err = new Error(e.message || 'The GPU worker failed.');
        for (const w of this.waiting.values()) w.reject(err);
        this.waiting.clear();
      };
      this.wk.onmessage = (e) => {
        if (e.data.event === 'lost') return this.lostNow();
        const { id, reply, error } = e.data;
        const w = this.waiting.get(id);
        this.waiting.delete(id);
        if (!w) return;
        if (error) w.reject(new Error(error));
        else w.resolve(reply);
      };
      const off = canvas.transferControlToOffscreen();
      this.ready = this.call({ cmd: 'init', canvas: off }, [off]);
    } else {
      this.engine = new Engine(canvas);
      this.engine.onLost = () => this.lostNow();
      this.ready = Promise.resolve({ cmd: 'caps', ...this.engine.caps });
    }
  }

  // Stop this engine (a GPU restart makes a new one on a new canvas): the calls that wait fail, and
  // the context is given back (its memory) when it still lives.
  dispose() {
    this.disposed = true;
    if (this.wk) this.wk.terminate();
    for (const w of this.waiting.values()) w.reject(new Error('The GPU was restarted.'));
    this.waiting.clear();
    if (this.settingsNext) this.settingsNext.reject(new Error('The GPU was restarted.'));
    this.settingsNext = null;
    if (this.engine) {
      try {
        const ext = this.engine.gl.getExtension('WEBGL_lose_context');
        if (ext && !this.engine.gl.isContextLost()) ext.loseContext();
      } catch { /* lost */ }
    }
  }

  lostNow() {
    if (this.lost || this.disposed) return;
    this.lost = true;
    if (this.onLost) this.onLost();
  }

  // Send the effect settings. The engine renders the frame again for each 'settings' message, and
  // a slider drag gives many of them: while one is at the worker, only the newest one waits (the
  // ones between are dropped), so the preview does not fall behind the slider on a slow GPU. The
  // order with the other calls stays: a waiting one is sent before the next call. The promise
  // resolves when the engine has these settings (or newer ones).
  setSettings(settings) {
    if (this.engine || this.disposed || !this.settingsBusy) return this.sendSettings(settings);
    const n = this.settingsNext;
    if (n) {
      n.settings = settings;
      return n.promise;
    }
    const next = (this.settingsNext = { settings });
    next.promise = new Promise((resolve, reject) => Object.assign(next, { resolve, reject }));
    return next.promise;
  }

  sendSettings(settings) {
    this.settingsBusy++;
    const p = this.rawCall({ cmd: 'settings', settings });
    const done = () => {
      if (--this.settingsBusy === 0) this.flushSettings();
    };
    p.then(done, done);
    return p;
  }

  flushSettings() {
    const n = this.settingsNext;
    if (!n) return;
    this.settingsNext = null;
    this.sendSettings(n.settings).then(n.resolve, n.reject);
  }

  call(msg, transfer = []) {
    this.flushSettings(); // the order of the calls
    return this.rawCall(msg, transfer);
  }

  rawCall(msg, transfer = []) {
    if (this.disposed) {
      if (msg.frame) try { msg.frame.close(); } catch { /* closed */ }
      return Promise.reject(new Error('The GPU was restarted.'));
    }
    if (this.engine) {
      try {
        return Promise.resolve(this.engine.handle(msg));
      } catch (e) {
        if (msg.frame) try { msg.frame.close(); } catch { /* closed */ }
        return Promise.reject(e);
      }
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.wk.postMessage({ id, msg }, transfer);
    });
  }
}
