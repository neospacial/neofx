// Phase 3 (plan §14): the GPU frame store (YUV 4:2:0 ring of TEXTURE_2D_ARRAY layers), the memory
// probe, the status bar. In Chromium, with the GPU worker and with the main-thread fallback.

import { createRequire } from 'node:module';
import { assert, hasFfmpeg, ffmpeg, run } from './lib/util.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { layerCount, frameBytes, defaultBudget, bufferText, workingSize, BUDGET_ANDROID, BUDGET_DESKTOP } from '../src/gpu/store.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

// Read the code of frame index - delay from the store (render, then read the canvas).
const readAt = (page, index, delay) => page.evaluate(async ([index, delay]) => {
  await window.neofx.gpu.call({ cmd: 'render', index, delay });
  const r = await window.__readPixels();
  let sum = 0;
  for (let i = 0; i < r.pixels.length; i += 4) sum += r.pixels[i];
  return { code: window.__decode(r), mean: sum / (r.pixels.length / 4) };
}, [index, delay]);

const waitIdle = (page) => page.waitForFunction(() => !window.neofx.player.busy && !window.neofx.player.pendingSeek && !window.neofx.player.playing, null, { timeout: 30000 });

async function storeChecks(query) {
  const f = makeFixtures(FIX_DIR, ['code.mp4']);
  const gt = groundTruth(f['code.mp4']);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, query);
  try {
    const mode = await page.evaluate(() => window.neofx.gpu.mode);
    assert(mode === (query ? 'main' : 'worker'), `GPU mode ${mode}`);
    await open(page, f['code.mp4']);
    // History: with depth 20, a seek to 50 puts 30..50 into the store.
    await page.evaluate(async () => {
      window.neofx.player.depth = 20;
      await window.neofx.player.seek(50);
    });
    for (let d = 0; d <= 20; d++) {
      const r = await readAt(page, 50, d);
      assert(r.code === gt.codes[50 - d], `${mode}: frame 50 delay ${d}: code ${r.code}, want ${gt.codes[50 - d]}`);
    }
    const gap = await readAt(page, 50, 25); // frame 25: never decoded
    assert(gap.mean < 1, `${mode}: a frame that is not in the store is black (mean ${gap.mean})`);
    const early = await readAt(page, 5, 10); // frame -5: before frame 0 (D8)
    assert(early.mean < 1, `${mode}: before frame 0 is black (mean ${early.mean})`);
    // Steps back inside the store need no decode (depth 10: 49..40 need 30..49).
    const back = await page.evaluate(async () => {
      const P = window.neofx.player;
      P.depth = 10;
      const jobs = P.stats.decodeJobs;
      const out = [];
      for (let i = 0; i < 10; i++) {
        await P.step(-1);
        out.push([P.current, await window.__read()]);
      }
      return { out, jobs: P.stats.decodeJobs - jobs };
    });
    assert(back.jobs === 0, `${mode}: ${back.jobs} decode jobs for steps inside the store`);
    for (const [t, c] of back.out) assert(c === gt.codes[t], `${mode}: step back to ${t}: code ${c}`);
    // A seek to a frame whose history is partly in the store decodes only the missing frames.
    const part = await page.evaluate(async () => {
      const P = window.neofx.player;
      P.depth = 20;
      let warm = 0;
      const consume = P.opts.consume;
      P.opts.consume = (i, f, show) => {
        if (!show) warm++;
        return consume(i, f, show);
      };
      await P.seek(55);
      P.opts.consume = consume;
      return warm;
    });
    assert(part === 4, `${mode}: seek 55 with 30..50 in the store: ${part} warm frames, want 4 (51..54)`);

    // The memory probe: the budget halves when the allocation fails (simulated twice).
    const bpf = frameBytes(320, 240);
    const probe = await page.evaluate(async (budget) => {
      const N = window.neofx;
      Object.assign(N.store, { budget, failAlloc: 2 });
      const r = await N.configureStore();
      N.store.failAlloc = 0;
      await N.player.seek(0);
      return { n: r.n, budget: r.budget, status: document.getElementById('status').textContent };
    }, 64 * bpf);
    assert(probe.n === 16 && probe.budget === 16 * bpf, `${mode}: after 2 failed allocations: ${probe.n} layers, budget ${probe.budget}`);
    assert(probe.status.startsWith('Buffer: 16 frames at 240p (≈ 2 MB)'), `${mode}: status "${probe.status}"`);

    // The ring: 16 layers. Play the full video with depth 15: at the end, the store holds 74..89.
    const ring = await page.evaluate(async () => {
      const P = window.neofx.player;
      P.depth = 15;
      P.play();
      await new Promise((res) => {
        const k = () => (P.playing ? setTimeout(k, 20) : res());
        k();
      });
      return { cur: P.current, dropped: P.stats.dropped };
    });
    assert(ring.cur === 89, `${mode}: play ended at ${ring.cur}`);
    for (let d = 0; d <= 15; d++) {
      const r = await readAt(page, 89, d);
      assert(r.code === gt.codes[89 - d], `${mode}: after play, delay ${d}: code ${r.code} (${ring.dropped} frames dropped from the preview)`);
    }
    const over = await readAt(page, 89, 16);
    assert(over.mean < 1, `${mode}: frame 73 was overwritten in the ring (mean ${over.mean})`);
    // Loop with In/Out: the history before In is decoded first (warm-up), then the range plays.
    const loop = await page.evaluate(async () => {
      const P = window.neofx.player;
      P.inPoint = 40;
      P.outPoint = 50;
      P.current = -1;
      P.play();
      await new Promise((res) => setTimeout(res, 300));
      P.pause();
      return P.log.slice();
    });
    assert(loop.length && loop[0] === 40, `${mode}: the loop starts at In: ${loop}`);
    await waitIdle(page);
    for (let d = 0; d <= 15; d++) {
      const cur = await page.evaluate(() => window.neofx.player.current);
      const r = await readAt(page, cur, d);
      assert(r.code === gt.codes[cur - d], `${mode}: In/Out play, frame ${cur} delay ${d}: code ${r.code}`);
    }
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

export const tests = [
  {
    name: 'store sizes: N = min(max layers, budget / 1.5 B per pixel, 1000); budgets; status text',
    fn() {
      assert(frameBytes(960, 540) === 960 * 540 * 1.5, 'frame bytes');
      assert(layerCount(BUDGET_DESKTOP, 2048, 1920, 1080) === Math.floor(BUDGET_DESKTOP / (1920 * 1080 * 1.5)), 'desktop 1080p');
      assert(layerCount(BUDGET_DESKTOP, 2048, 960, 540) === 1000 && layerCount(BUDGET_ANDROID, 2048, 960, 540) === 517, '540p');
      assert(layerCount(BUDGET_DESKTOP, 2048, 320, 240) === 1000, '1000 at most');
      assert(layerCount(BUDGET_DESKTOP, 256, 320, 240) === 256, 'MAX_ARRAY_TEXTURE_LAYERS');
      assert(layerCount(10, 2048, 1920, 1080) === 1, 'at least 1');
      assert(defaultBudget('Mozilla/5.0 (Linux; Android 14; Pixel 8)') === BUDGET_ANDROID && defaultBudget('Mozilla/5.0 (Windows NT 10.0)') === BUDGET_DESKTOP, 'budgets');
      assert(bufferText(240, 960, 540) === 'Buffer: 240 frames at 540p (≈ 178 MB)', bufferText(240, 960, 540));
      const a = workingSize(1920, 1080, 540), b = workingSize(320, 240, 540), c = workingSize(1080, 1920, 0), d = workingSize(1000, 563, 360);
      assert(a.width === 960 && a.height === 540 && b.width === 320 && c.height === 1920 && d.height % 2 === 0 && d.width % 2 === 0, 'working sizes');
    },
  },
  {
    name: 'frame store in the GPU worker: history by delay, not-in-store black, ring, memory probe, status',
    timeout: 180000,
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      await storeChecks('');
    },
  },
  {
    name: 'frame store on the main thread (fallback when there is no OffscreenCanvas WebGL2)',
    timeout: 180000,
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      await storeChecks('?gpu=main');
    },
  },
  {
    name: 'colour: the YUV store gives the colours of the source (flat areas of SMPTE bars, BT.709)',
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const file = ffmpeg('bars.mp4', ['-f', 'lavfi', '-i', 'smptehdbars=size=640x360:rate=30', '-frames:v', '3', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']);
      const ref = run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout;
      const { browser, page, errors } = await launch();
      try {
        await open(page, file);
        const r = await page.evaluate(() => window.__readPixels());
        const px = Object.values(r.pixels);
        assert(r.width === 640 && r.height === 360, `size ${r.width}x${r.height}`);
        let worst = 0;
        // The centres of the 7 top bars, and two points of the bottom row.
        const pts = [...Array.from({ length: 7 }, (_, i) => [Math.round(80 + (i * 480) / 7 + 34), 100]), [40, 330], [600, 330]];
        for (const [x, y] of pts) {
          const gy = r.height - 1 - y;
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px[(gy * r.width + x) * 4 + c] - ref[(y * 640 + x) * 3 + c]));
        }
        assert(worst <= 10, `colour error ${worst} (8-bit levels)`);
        assert(!errors.length, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
];
