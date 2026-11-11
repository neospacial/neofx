// Phase 4 (plan §14, §13.2): Mode 1, Time Map, with the Linear map. Frame blend, delay steps, and
// the black start (D8). The fixture has 30 block rows of 8 px; each block row is read at its centre
// pixel row y, where the vertical gradient (angle 90°, width 1) has v = (y + 0.5) / 240.

import { createRequire } from 'node:module';
import { assert, hasFfmpeg } from './lib/util.mjs';
import { makeFixtures, readCodeRow } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { frameBytes } from '../src/gpu/store.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const H = 240, ROWS = 30;
const centre = (cy) => cy * 8 + 4;

// The expected code of each block row at frame t (blend off). codes[k] = code of frame k.
// wrapL (perfect loop of frames 0 .. wrapL − 1): before frame 0, the frames of the end.
export function expectRows(codes, t, max, steps = 0, wrapL = 0) {
  const out = [];
  for (let cy = 0; cy < ROWS; cy++) {
    let v = (centre(cy) + 0.5) / H;
    if (steps > 1) v = Math.min(Math.floor(v * steps), steps - 1) / (steps - 1);
    const d = v * max;
    const k = t - Math.floor(d + 0.5);
    if (wrapL) out.push(codes[k < 0 ? k + wrapL : k]);
    else out.push(t - d < 0 ? 0 : codes[k]);
  }
  return out;
}

// In the page: the code of each block row of the last render (and the pixels).
async function installRows(page) {
  await page.evaluate((src) => {
    const readCodeRow = (0, eval)(`(${src})`);
    window.__rowsOf = (r) => {
      const { width: w, height: h, pixels: d } = r;
      const get = (x, y) => d[((h - 1 - y) * w + x) * 4];
      return Array.from({ length: Math.floor(h / 8) }, (_, cy) => readCodeRow(get, w, cy));
    };
    window.__rows = async () => window.__rowsOf(await window.neofx.gpu.call({ cmd: 'read' }));
  }, readCodeRow.toString());
}

const setAll = (page, values) => page.evaluate(async (values) => {
  for (const [k, v] of Object.entries(values)) window.neofx.change(k, v);
  await window.neofx.applySettings();
  await new Promise((r) => setTimeout(r, 0));
}, values);

const seekRows = (page, t) => page.evaluate(async (t) => {
  await window.neofx.player.seek(t);
  return window.__rows();
}, t);

async function withApp(fn, query = '') {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, ['code.mp4']);
  const gt = groundTruth(f['code.mp4']);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, query, false);
  try {
    await installRows(page);
    await open(page, f['code.mp4']);
    await fn(page, gt.codes);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Note: the Max delay values of these tests put no block row centre on a rounding tie (d = x.5),
// where the float32 GPU and the float64 test can round differently.

export const tests = [
  {
    name: '§13.2 Mode 1: vertical gradient, Max delay 30, blend off: row v shows frame t − round(30 v); black before it (D8)',
    timeout: 180000,
    async fn() {
      await withApp(async (page, codes) => {
        await setAll(page, { 'timemap.maxDelay': 30, 'timemap.blend': false, 'timemap.steps': 0 });
        for (const t of [0, 1, 7, 15, 29, 30, 31, 45, 60, 89, 3, 50]) {
          const rows = await seekRows(page, t);
          const want = expectRows(codes, t, 30);
          assert(same(rows, want), `t ${t}:\n        got  ${rows}\n        want ${want}`);
        }
        // Each frame that playback shows (the store gets the dropped frames too).
        const r = await page.evaluate(async () => {
          const P = window.neofx.player;
          await P.seek(0);
          const seen = [];
          const consume = P.opts.consume;
          P.opts.consume = (i, f, show) => {
            const p = consume(i, f, show);
            if (show) seen.push(window.neofx.gpu.call({ cmd: 'read' }).then((px) => [i, window.__rowsOf(px)]));
            return p;
          };
          P.play();
          await new Promise((res) => {
            const k = () => (P.playing ? setTimeout(k, 20) : res());
            k();
          });
          P.opts.consume = consume;
          return Promise.all(seen);
        });
        assert(r.length > 40, `${r.length} frames shown`);
        for (const [t, rows] of r) assert(same(rows, expectRows(codes, t, 30)), `play, frame ${t}: ${rows}`);
      });
    },
  },
  {
    name: 'Mode 1, perfect loop: before frame 0 the rows show the end of the video (seek, and a looped playback across the wrap); off: black again',
    timeout: 240000,
    async fn() {
      await withApp(async (page, codes) => {
        const L = codes.length;
        await setAll(page, { 'timemap.maxDelay': 30, 'timemap.blend': false, 'timemap.steps': 0, 'timemap.perfectLoop': true });
        for (const t of [0, 1, 7, 15, 29, 30, 45, L - 1, 3, 60, 0]) {
          const rows = await seekRows(page, t);
          const want = expectRows(codes, t, 30, 0, L);
          assert(same(rows, want), `t ${t}:\n        got  ${rows}\n        want ${want}`);
        }
        // Play from near the end with Loop on: each shown frame, also after the wrap (the history of
        // the first frames is the end of the pass before: no decode of it again).
        const r = await page.evaluate(async (L) => {
          const P = window.neofx.player;
          await P.seek(L - 15);
          document.querySelector('[data-act=loop]').click();
          const seen = [];
          const consume = P.opts.consume;
          P.opts.consume = (i, f, show) => {
            const p = consume(i, f, show);
            if (show) seen.push(window.neofx.gpu.call({ cmd: 'read' }).then((px) => [i, window.__rowsOf(px)]));
            return p;
          };
          const jobs = P.stats.decodeJobs;
          P.play();
          const t0 = performance.now();
          await new Promise((res) => {
            const k = () => (P.vcur >= 2 * L + 35 || performance.now() - t0 > 120000 ? res() : setTimeout(k, 20));
            k();
          });
          P.pause();
          document.querySelector('[data-act=loop]').click();
          P.opts.consume = consume;
          return { shown: await Promise.all(seen), jobs: P.stats.decodeJobs - jobs, vcur: P.vcur };
        }, L);
        assert(r.vcur >= 2 * L + 35, `the playback came past the wrap: ${r.vcur}`);
        const wrapped = r.shown.filter(([i]) => i % L < 30);
        assert(wrapped.length > 10, `${wrapped.length} frames after the wrap`);
        for (const [i, rows] of r.shown) assert(same(rows, expectRows(codes, i % L, 30, 0, L)), `play, frame ${i % L} (store ${i}): ${rows}`);
        assert(r.jobs <= 3, `decode jobs ${r.jobs}`);
        // Off: black before frame 0 again.
        await setAll(page, { 'timemap.perfectLoop': false });
        for (const t of [5, 40]) {
          const rows = await seekRows(page, t);
          assert(same(rows, expectRows(codes, t, 30)), `off, t ${t}: ${rows}`);
        }
      });
    },
  },
  {
    name: 'Mode 1: delay steps (4 and 2), Max delay change (more history is decoded), Max delay 0',
    timeout: 180000,
    async fn() {
      await withApp(async (page, codes) => {
        await setAll(page, { 'timemap.blend': false });
        for (const [steps, max, t] of [[4, 30, 60], [2, 30, 40], [4, 30, 25], [0, 60, 80], [0, 0, 33], [3, 46, 89]]) {
          await setAll(page, { 'timemap.steps': steps, 'timemap.maxDelay': max });
          const rows = await seekRows(page, t);
          const want = expectRows(codes, t, max, steps);
          assert(same(rows, want), `steps ${steps}, max ${max}, t ${t}:\n        got  ${rows}\n        want ${want}`);
        }
        // A larger Max delay on a paused frame: the missing history is decoded, the result is right.
        await setAll(page, { 'timemap.steps': 0, 'timemap.maxDelay': 10 });
        await seekRows(page, 85);
        await setAll(page, { 'timemap.maxDelay': 72 });
        const rows = await page.evaluate(() => window.__rows());
        assert(same(rows, expectRows(codes, 85, 72)), `max 10 -> 72 at frame 85: ${rows}`);
      });
    },
  },
  {
    name: 'Mode 1: frame blend mixes the two frames around t − d (pixel values)',
    timeout: 180000,
    async fn() {
      await withApp(async (page, codes) => {
        await setAll(page, { 'timemap.blend': true, 'timemap.steps': 0, 'timemap.maxDelay': 30 });
        const bit = (k, cx, cy) => (k < 0 ? 0 : (codes[k] >> ((cx + 3 * cy) % 16)) & 1);
        for (const t of [12, 40, 77]) {
          const px = await page.evaluate(async (t) => {
            await window.neofx.player.seek(t);
            const r = await window.neofx.gpu.call({ cmd: 'read' });
            return Array.from(r.pixels.filter((_, i) => i % 4 === 0));
          }, t);
          let worst = 0;
          for (let cy = 0; cy < ROWS; cy++) {
            const y = centre(cy);
            const d = (30 * (y + 0.5)) / H;
            const src = t - d;
            for (let cx = 0; cx < 40; cx++) {
              let want = 0;
              if (src >= 0) {
                const k0 = Math.floor(src), f = src - k0;
                want = 255 * ((1 - f) * bit(k0, cx, cy) + f * bit(k0 + 1, cx, cy));
              }
              const got = px[(H - 1 - y) * 320 + cx * 8 + 4];
              worst = Math.max(worst, Math.abs(got - want));
            }
          }
          assert(worst <= 16, `t ${t}: blend error ${worst.toFixed(1)}`);
        }
      });
    },
  },
  {
    name: 'Mode 1: Map view shows the gradient; Original view shows frame t; angle 0 gives a horizontal ramp',
    timeout: 120000,
    async fn() {
      await withApp(async (page, codes) => {
        await setAll(page, { view: 'map' });
        const px = await page.evaluate(async () => {
          await window.neofx.player.seek(20);
          const r = await window.neofx.gpu.call({ cmd: 'read' });
          return Array.from(r.pixels.filter((_, i) => i % 4 === 0));
        });
        for (const y of [0, 60, 119, 200, 239]) {
          const want = (255 * (y + 0.5)) / H;
          assert(Math.abs(px[(H - 1 - y) * 320 + 100] - want) <= 1.5, `map row ${y}: ${px[(H - 1 - y) * 320 + 100]}, want ${want.toFixed(1)}`);
        }
        await setAll(page, { 'map.params.linear.angle': 0 });
        const h = await page.evaluate(async () => Array.from((await window.neofx.gpu.call({ cmd: 'read' })).pixels.filter((_, i) => i % 4 === 0)));
        for (const x of [0, 160, 319]) assert(Math.abs(h[100 * 320 + x] - (255 * (x + 0.5)) / 320) <= 1.5, `angle 0, column ${x}: ${h[100 * 320 + x]}`);
        await setAll(page, { view: 'original', 'map.params.linear.angle': 90 });
        const rows = await page.evaluate(() => window.__rows());
        assert(rows.every((c) => c === codes[20]), `original view: ${rows}`);
      });
    },
  },
  {
    name: 'Mode 1 UI: the inspector sets Max delay; its limit is N − 1 of the store',
    timeout: 120000,
    async fn() {
      await withApp(async (page, codes) => {
        await page.evaluate(() => window.neofx.change('timemap.blend', false));
        // Type 12 in the number field of Max delay.
        const field = page.locator('[data-key="timemap.maxDelay"] input[type=number]');
        await field.fill('12');
        await field.press('Enter');
        await page.waitForFunction(() => window.neofx.settings.timemap.maxDelay === 12);
        const rows = await page.evaluate(async () => {
          await window.neofx.applySettings();
          await window.neofx.player.seek(50);
          return window.__rows();
        });
        assert(same(rows, expectRows(codes, 50, 12)), `UI max 12 at 50: ${rows}`);
        // Double-click on the label: back to the default (30).
        await page.locator('[data-key="timemap.maxDelay"] label').dblclick();
        await page.waitForFunction(() => window.neofx.settings.timemap.maxDelay === 30);
        // A store of 16 layers: the Max delay goes down to 15, the slider stops at 15.
        const r = await page.evaluate(async (budget) => {
          const N = window.neofx;
          N.store.budget = budget;
          await N.configureStore();
          await N.player.seek(60);
          return { max: N.settings.timemap.maxDelay, sliderMax: document.querySelector('[data-key="timemap.maxDelay"] input[type=range]').max, rows: await window.__rows() };
        }, 16 * frameBytes(320, 240));
        assert(r.max === 15 && r.sliderMax === '15', `limit: ${r.max}, slider ${r.sliderMax}`);
        assert(same(r.rows, expectRows(codes, 60, 15)), `max 15 at 60: ${r.rows}`);
      });
    },
  },
  {
    name: 'Mode 1 with the main-thread GPU fallback (§13.2 test again)',
    timeout: 120000,
    async fn() {
      await withApp(async (page, codes) => {
        await setAll(page, { 'timemap.maxDelay': 30, 'timemap.blend': false });
        for (const t of [10, 30, 70]) {
          const rows = await seekRows(page, t);
          assert(same(rows, expectRows(codes, t, 30)), `main thread, t ${t}: ${rows}`);
        }
      }, '?gpu=main');
    },
  },
];
