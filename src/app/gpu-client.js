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
    if (useWorker) {
      this.wk = makeWorker(workerSrc);
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

  call(msg, transfer = []) {
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
