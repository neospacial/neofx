// Custom maps (plan §7.4): an image file (PNG / JPEG / WebP) or a video file (MP4 / MOV). The GPU
// engine keeps them as luma (BT.709) in an R8 texture array. A video map is decoded fully once, at
// load (with progress), so that each frame of the source has its map frame at once.

import { makeWorker } from '../app/player.js';

const VIDEO_MAP_BUDGET = 256 * 1048576;

export async function loadImageMap(file, gpu) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image file cannot be read (PNG, JPEG, or WebP).');
  }
  return gpu.call({ cmd: 'mapImage', bitmap }, [bitmap]);
}

// The size and frame count for a video map of w x h with n frames: the short side at most `short`,
// all frames in the budget and in the texture layer limit.
export function videoMapSize(w, h, n, short, maxLayers, budget = VIDEO_MAP_BUDGET) {
  const s = Math.min(1, short / Math.min(w, h));
  let width = Math.max(2, Math.round(w * s)), height = Math.max(2, Math.round(h * s));
  const count = Math.max(1, Math.min(n, maxLayers, Math.floor(budget / (width * height)) || 1));
  return { width, height, count };
}

// opts: { workerSrc, short, maxLayers, onProgress(fraction) }. Resolves with { count, width, height, frames }.
export function loadVideoMap(file, gpu, opts) {
  const wk = makeWorker(opts.workerSrc);
  return new Promise((resolve, reject) => {
    let size = null;
    let done = 0;
    const fail = (msg) => {
      wk.terminate();
      reject(new Error(msg));
    };
    wk.onerror = (e) => fail(e.message || 'Decode worker failed.');
    wk.onmessage = async (e) => {
      const m = e.data;
      if (m.cmd === 'error') return fail(m.message);
      if (m.cmd === 'info') {
        size = videoMapSize(m.width, m.height, m.times.length, opts.short, opts.maxLayers);
        size.frames = m.times.length;
        size.rotation = m.rotation;
        await gpu.call({ cmd: 'mapVideoBegin', width: size.width, height: size.height, count: size.count });
        wk.postMessage({ cmd: 'play', job: 1, from: 0, to: size.count - 1 });
      } else if (m.cmd === 'frame') {
        try {
          await gpu.call({ cmd: 'mapVideoFrame', i: m.index, frame: m.frame, rotation: size.rotation }, [m.frame]);
        } catch (err) {
          return fail(err.message);
        }
        wk.postMessage({ cmd: 'ack' });
        done++;
        if (opts.onProgress) opts.onProgress(done / size.count);
      } else if (m.cmd === 'done') {
        wk.terminate();
        await gpu.call({ cmd: 'caps' }); // the replies come in order: all frames are in
        resolve(size);
      }
    };
    wk.postMessage({ cmd: 'open', file });
  });
}
