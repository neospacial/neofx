// The performance test (plan §13.4, phase 12): on the open video, the preview fps at 540p for each
// mode, the export fps at 1080p, and the frame buffer limit. The result is text to copy into the
// README (device results table). Nothing leaves the device.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Play from frame 0 for `seconds` (or to the end). Returns { fps, shown, dropped }.
async function measurePlay(player, seconds) {
  await player.seek(0);
  player.play();
  const t0 = performance.now();
  while (player.playing && performance.now() - t0 < seconds * 1000) await wait(50);
  const s = player.stats;
  const out = { fps: s.fps, shown: s.shown, dropped: s.dropped };
  player.pause();
  return out;
}

// app: { player, info(), store, settings(), look(patch) -> Promise (no undo step), restore(saved),
//        setShort(short) -> Promise, exportVideo(opts, onProgress), bufferAt(w, h) -> n, version, gpuMode,
//        onStep(text) }
export async function runBench(app, opts = {}) {
  const P = app.player;
  const info = app.info();
  if (!info) throw new Error('Open a video first.');
  const seconds = opts.seconds ?? 4;
  const saved = app.settings();
  const short0 = app.store.short;
  const lines = [];
  const res = { preview: {}, export: null, buffer: {} };
  try {
    await app.setShort(540);
    res.buffer[540] = { n: app.store.n, width: app.store.width, height: app.store.height };
    const modes = [
      ['Time Map (Linear, Max delay 30)', { mode: 'timemap', timemap: { maxDelay: 30, blend: true, steps: 0 } }],
      ['Slit Scan (line, Time On)', { mode: 'slitscan', slitscan: { source: 'line', time: true } }],
    ];
    for (const [name, patch] of modes) {
      app.onStep(`Preview at 540p: ${name}…`);
      await app.look(patch);
      res.preview[name] = await measurePlay(P, seconds);
    }
    // Export at 1080p (the short side; or the source size when it is smaller), without audio.
    await app.restore(saved);
    const k = Math.min(1, 1080 / Math.min(info.width, info.height));
    const w = Math.round((info.width * k) / 2) * 2, h = Math.round((info.height * k) / 2) * 2;
    res.buffer[1080] = { n: app.bufferAt(w, h), width: w, height: h };
    const frames = Math.min(info.times.length, opts.exportFrames ?? 150);
    app.onStep(`Export at ${Math.min(w, h)}p (${frames} frames)…`);
    const t0 = performance.now();
    let first = 0;
    const r = await app.exportVideo({ width: w, height: h, quality: 'high', keyint: 2, range: [0, frames - 1], audio: false, hardware: 'hardware', name: 'bench.mp4' }, (p) => {
      if (p.phase === 'encode' && p.done === 1) first = performance.now();
    });
    const sec = (performance.now() - (first || t0)) / 1000;
    res.export = { width: r.width, height: r.height, frames: r.frames, fps: (r.frames - 1) / Math.max(sec, 1e-3), codec: r.config.codec, hardware: r.config.hardwareAcceleration };
  } finally {
    await app.restore(saved);
    if (app.store.short !== short0) await app.setShort(short0);
  }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  lines.push(`neofx ${app.version} performance test`);
  lines.push(`Browser: ${nav.userAgent || '?'}`);
  lines.push(`GPU: ${app.gpuName || '?'} (engine: ${app.gpuMode})`);
  if (nav.hardwareConcurrency) lines.push(`CPU threads: ${nav.hardwareConcurrency}${nav.deviceMemory ? `, memory: ${nav.deviceMemory} GB` : ''}`);
  lines.push(`Video: ${info.width}×${info.height}, ${info.fps.toFixed(2)} fps, ${info.times.length} frames (${info.codec})`);
  for (const [name, p] of Object.entries(res.preview)) lines.push(`Preview 540p, ${name}: ${p.fps.toFixed(1)} fps (${p.dropped} of ${p.shown + p.dropped} frames dropped)`);
  if (res.export) lines.push(`Export ${res.export.width}×${res.export.height}: ${res.export.fps.toFixed(1)} fps (${res.export.frames} frames, ${res.export.codec}, ${res.export.hardware})`);
  for (const [s, b] of Object.entries(res.buffer)) lines.push(`Buffer at ${s}p (${b.width}×${b.height}): ${b.n} frames`);
  return { ...res, text: lines.join('\n') };
}
