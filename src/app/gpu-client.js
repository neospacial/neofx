// The page side of the GPU engine: the GPU worker when the browser has OffscreenCanvas with WebGL2,
// else the engine on the main thread (plan §4 fallback). call(msg) -> Promise of the reply. The
// replies come in the order of the calls.

import { Engine } from '../gpu/engine.js';
import { makeWorker } from './player.js';

export class GpuClient {
  constructor(canvas, workerSrc, useWorker) {
    this.mode = useWorker ? 'worker' : 'main';
    this.next = 1;
    this.waiting = new Map();
    if (useWorker) {
      this.wk = makeWorker(workerSrc);
      this.wk.onmessage = (e) => {
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
      this.ready = Promise.resolve({ cmd: 'caps', ...this.engine.caps });
    }
  }

  call(msg, transfer = []) {
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
