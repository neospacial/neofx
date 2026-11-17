// The analysis pass of Mode 2 (plan §8.3): when the line changes, decode the full video (a second
// decode worker, not in real time) and give each frame to the engine, which writes its row of the
// slit history. A new pass cancels the one that runs.

import { makeWorker } from './player.js';

export class Analysis {
  // opts: { onProgress(fraction | null), onRows() (some rows are new), onDone(key),
  //         onError(message) (optional: the pass stopped) }
  constructor(workerSrc, gpu, opts) {
    this.src = workerSrc;
    this.gpu = gpu;
    this.opts = opts;
    this.wk = null;
    this.key = ''; // the key of the pass that runs
    this.doneKey = ''; // the key of the last pass that ended
    this.progress = 0;
  }

  get running() {
    return !!this.wk;
  }

  stop() {
    if (this.wk) this.wk.terminate();
    this.wk = null;
    this.key = '';
    this.opts.onProgress(null);
  }

  // keys (optional): the clean sync samples of the file (the 'info' of the player's worker).
  start(file, count, key, keys) {
    this.stop();
    this.key = key;
    this.doneKey = '';
    this.progress = 0;
    const wk = (this.wk = makeWorker(this.src));
    let done = 0, last = 0;
    // The pass failed: stop it (only when it is still the pass that runs).
    const fail = (message) => {
      if (wk !== this.wk) return;
      this.stop();
      if (this.opts.onError) this.opts.onError(message);
    };
    wk.onerror = (e) => fail(e.message || 'Decode worker failed.');
    wk.onmessage = async (e) => {
      const m = e.data;
      if (wk !== this.wk) return m.frame && m.frame.close();
      if (m.cmd === 'info') wk.postMessage({ cmd: 'play', job: 1, from: 0, to: count - 1 });
      else if (m.cmd === 'frame') {
        try {
          await this.gpu.call({ cmd: 'slitFrame', index: m.index, frame: m.frame }, [m.frame]);
        } catch (err) {
          return fail(err.message);
        }
        if (wk !== this.wk) return;
        wk.postMessage({ cmd: 'ack' });
        done++;
        this.progress = done / count;
        this.opts.onProgress(this.progress);
        if (performance.now() - last > 150) {
          last = performance.now();
          this.opts.onRows();
        }
      } else if (m.cmd === 'done') {
        try {
          await this.gpu.call({ cmd: 'slitStatus' }); // the replies come in order: all rows are in
        } catch (err) {
          return fail(err.message);
        }
        if (wk !== this.wk) return;
        wk.terminate();
        this.wk = null;
        this.doneKey = key;
        this.key = '';
        this.opts.onProgress(null);
        this.opts.onRows();
        this.opts.onDone(key);
      } else if (m.cmd === 'error') fail(m.message);
    };
    wk.postMessage({ cmd: 'open', file, keys });
  }
}
