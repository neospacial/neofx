// Phase 7 (plan §14, §13.2): Mode 2, Slit Scan, line source.
// - Time On, rate 1: the column at distance k shows the source column of frame t − k. Rate 0.5:
//   t − 2k. Accelerate: matches A(s).
// - Time Off: each column of the effect side equals the source column of frame t.
// - A line at 37°: the result equals a model of the turned geometry (bilinear line samples).
// The fixture: frame f has the block code of f + 1; the pixel (x, y) of frame f is white when bit
// (floor(x/8) + 3 floor(y/8)) mod 16 of the code is 1. The line is at a block centre (x = 164).

import { createRequire } from 'node:module';
import { assert, hasFfmpeg } from './lib/util.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { distanceTable, ageAt, lineGeometry, rateAt } from '../src/modes/slit.js';
import { DEFAULTS, clone } from '../src/app/settings.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const W = 320, H = 240;
const LX = 164.5 / W, LY = 124.5 / H; // block centres: column 164, row 124

async function withMode2(fn, file = 'code.mp4') {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, [file]);
  const gt = groundTruth(f[file]);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
  try {
    await open(page, f[file]);
    await page.evaluate(() => window.neofx.change('mode', 'slitscan'));
    await waitAnalysis(page);
    await fn(page, gt.codes);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

const waitAnalysis = (page) => page.waitForFunction(() => {
  const N = window.neofx;
  return N.analysis.doneKey === N.slitKey() && !N.analysis.running;
}, null, { timeout: 60000 });

// Set slitscan settings, wait for the analysis pass, seek t, and read the result (luma, top row first).
async function view(page, values, t) {
  await page.evaluate((values) => {
    for (const [k, v] of Object.entries(values)) window.neofx.change(`slitscan.${k}`, v);
  }, values);
  await waitAnalysis(page);
  return page.evaluate(async (t) => {
    const N = window.neofx;
    await N.applySettings();
    await N.player.seek(t);
    await N.gpu.call({ cmd: 'render', index: t });
    const r = await N.gpu.call({ cmd: 'read' });
    const out = new Uint8Array(r.width * r.height);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) out[y * r.width + x] = r.pixels[((r.height - 1 - y) * r.width + x) * 4];
    return Array.from(out);
  }, t);
}

// The luma of frame k at pixel (x, y) from the frame code (0 or 255).
const lumaOf = (codes, k, x, y) => 255 * ((codes[k] >> ((Math.floor(x / 8) + 3 * Math.floor(y / 8)) % 16)) & 1);

// The expected value of the effect pixel at distance s (an integer here), for the source pixel (sx, sy)
// on the line. null: not on the effect side or beyond Max age (the original shows).
function expectAt(codes, sl, t, s, sx, sy) {
  if (!sl.time) return lumaOf(codes, t, sx, sy);
  const S = distanceTable(sl);
  const a = ageAt(S, s);
  if (!Number.isFinite(a)) return null;
  const src = t - a;
  if (src < -1e-3) return 0;
  if (sl.sampling === 'blend') {
    const k0 = Math.floor(Math.max(0, src)), f = Math.max(0, src) - k0;
    return (1 - f) * lumaOf(codes, k0, sx, sy) + (f > 0 ? f * lumaOf(codes, k0 + 1, sx, sy) : 0);
  }
  return lumaOf(codes, Math.floor(src + 0.5), sx, sy);
}

// Check every block centre of the picture: on the effect side the expected line pixel, else frame t.
// side(x, y) -> { s, sx, sy } or null (the other side).
function checkAll(name, got, codes, sl, t, side, tol = 40) {
  let bad = 0, first = null;
  for (let cy = 0; cy < 30; cy++) for (let cx = 0; cx < 40; cx++) {
    const x = cx * 8 + 4, y = cy * 8 + 4;
    const e = side(x, y);
    let want = e ? expectAt(codes, sl, t, e.s, e.sx, e.sy) : null;
    if (want === null) want = lumaOf(codes, t, x, y);
    if (Math.abs(got[y * W + x] - want) > tol) {
      bad++;
      if (!first) first = [x, y, got[y * W + x], Math.round(want), e && e.s];
    }
  }
  assert(bad === 0, `${name}: ${bad} block centres differ, first at (x, y, got, want, s) = ${first}`);
}

const right = (x, y) => (x >= 164 ? { s: x - 164, sx: 164, sy: y } : null);

export const tests = [
  {
    name: 'slit math (Node): S and A for each rate type; line geometry and directions',
    fn() {
      const base = { ...clone(DEFAULTS).slitscan, maxAge: 60, rate: 0.5, rateEnd: 4 };
      for (const rateType of ['constant', 'accelerate', 'decelerate', 'exponential', 'curve']) {
        const sl = { ...base, rateType };
        const S = distanceTable(sl);
        for (let a = 1; a <= 60; a++) assert(S[a] > S[a - 1], `${rateType}: S increases`);
        for (const a of [0, 0.5, 7.25, 30, 59.9]) assert(Math.abs(ageAt(S, (S[Math.floor(a)] * (1 - (a % 1))) + S[Math.min(60, Math.floor(a) + 1)] * (a % 1)) - a) < 1e-4, `${rateType}: A(S(${a}))`);
        assert(ageAt(S, S[60] + 0.01) === Infinity, `${rateType}: beyond Max age`);
      }
      assert(Math.abs(rateAt({ ...base, rateType: 'accelerate' }, 30) - (0.5 + 3.5 * 0.25)) < 1e-9, 'accelerate formula');
      assert(Math.abs(rateAt({ ...base, rateType: 'exponential' }, 60) - 4) < 1e-9, 'exponential at Max age');
      const S1 = distanceTable({ ...base, rate: 1, rateType: 'constant' });
      assert(ageAt(S1, 17) === 17 && ageAt(distanceTable({ ...base, rateType: 'constant' }), 17) === 34, 'rate 1 and 0.5');
      const g = (angle, flip = false) => lineGeometry({ x: 0.5, y: 0.5, angle, flip }, W, H).d.join();
      assert(g(90) === '1,0' && g(270) === '-1,0' && g(0) === '0,-1' && g(180) === '0,1' && g(90, true) === '-1,0', 'scan directions');
      const L = lineGeometry({ x: LX, y: 0.5, angle: 90 }, W, H);
      assert(L.L[0] === 164.5 && L.len >= 2 * Math.hypot(W, H), `geometry ${JSON.stringify(L)}`);
    },
  },
  {
    name: '§13.2 Mode 2 line, Time On: rate 1 -> frame t − k at distance k; rate 0.5 -> t − 2k; Accelerate -> A(s); black before frame 0',
    timeout: 240000,
    async fn() {
      await withMode2(async (page, codes) => {
        const sl0 = { ...clone(DEFAULTS).slitscan, x: LX, y: 0.5, angle: 90, maxAge: 90 };
        for (const [name, over, ts] of [
          ['rate 1', { rate: 1 }, [80, 30, 5]],
          ['rate 0.5', { rate: 0.5 }, [89, 40]],
          ['accelerate', { rateType: 'accelerate', rate: 0.5, rateEnd: 4, maxAge: 60 }, [85, 20]],
          ['exponential', { rateType: 'exponential', rate: 3, rateEnd: 0.25, maxAge: 80 }, [70]],
          ['max age 20', { rate: 1, maxAge: 20 }, [60]],
        ]) {
          const sl = { ...sl0, ...over };
          for (const t of ts) {
            const got = await view(page, sl, t);
            checkAll(`${name}, t ${t}`, got, codes, sl, t, right);
          }
        }
      });
    },
  },
  {
    name: '§13.2 Mode 2, Time Off: each column of the effect side equals the source column of frame t',
    timeout: 120000,
    async fn() {
      await withMode2(async (page, codes) => {
        const sl = { ...clone(DEFAULTS).slitscan, x: LX, y: 0.5, angle: 90, time: false };
        for (const t of [0, 33, 89]) checkAll(`time off, t ${t}`, await view(page, sl, t), codes, sl, t, right);
        // Slit width 3: the average of columns 163..165 (all in the same block: the same value).
        const w3 = { ...sl, width: 3 };
        checkAll('time off, slit width 3', await view(page, w3, 50), codes, w3, 50, right);
      });
    },
  },
  {
    name: 'Mode 2 directions (180°, 270°, 0°, flip) and Blend sampling (a mix of 2 rows)',
    timeout: 240000,
    async fn() {
      await withMode2(async (page, codes) => {
        const sl0 = { ...clone(DEFAULTS).slitscan, x: LX, y: LY, maxAge: 90, rate: 1 };
        const left = (x, y) => (x <= 164 ? { s: 164 - x, sx: 164, sy: y } : null);
        checkAll('270° (scan to the left)', await view(page, { ...sl0, angle: 270 }, 70), codes, { ...sl0 }, 70, left);
        checkAll('90° flipped (to the left)', await view(page, { ...sl0, angle: 90, flip: true }, 70), codes, { ...sl0 }, 70, left);
        const up = (x, y) => (y <= 124 ? { s: 124 - y, sx: x, sy: 124 } : null);
        const down = (x, y) => (y >= 124 ? { s: y - 124, sx: x, sy: 124 } : null);
        const fix = (f) => (x, y) => {
          const e = f(x, y);
          return e && { ...e, sy: e.sy ?? y };
        };
        checkAll('0° (horizontal line, scan up)', await view(page, { ...sl0, angle: 0, flip: false }, 60), codes, sl0, 60, fix(up));
        checkAll('180° (scan down)', await view(page, { ...sl0, angle: 180 }, 60), codes, sl0, 60, fix(down));
        const bl = { ...sl0, angle: 90, rate: 0.4, sampling: 'blend' };
        const r = (x, y) => (x >= 164 ? { s: x - 164, sx: 164, sy: y } : null);
        checkAll('blend sampling', await view(page, bl, 75), codes, bl, 75, r, 12);
      });
    },
  },
  {
    name: '§13.2 Mode 2, line at 37°: the result equals the turned-geometry model (bilinear line samples)',
    timeout: 240000,
    async fn() {
      await withMode2(async (page) => {
        const sl = { ...clone(DEFAULTS).slitscan, x: 0.45, y: 0.55, angle: 37, maxAge: 90, rate: 1.5 };
        const t = 70;
        const got = await view(page, sl, t);
        // The stored frames that the model needs: t − round(A(s)) for each s (and t).
        const S = distanceTable(sl);
        const need = new Set([t]);
        for (let s = 0; s <= S[S.length - 1] + 1; s += 0.25) {
          const a = ageAt(S, s);
          if (Number.isFinite(a) && t - a >= 0) need.add(Math.floor(t - a + 0.5));
        }
        const frames = await page.evaluate(async (list) => {
          const N = window.neofx;
          const out = {};
          for (const k of list) {
            await N.player.seek(k);
            await N.gpu.call({ cmd: 'render', index: k, delay: 0 });
            const r = await N.gpu.call({ cmd: 'read' });
            const o = new Uint8Array(320 * 240);
            for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) o[y * 320 + x] = r.pixels[((239 - y) * 320 + x) * 4];
            out[k] = Array.from(o);
          }
          await N.player.seek(70);
          return out;
        }, [...need]);
        const g = lineGeometry(sl, W, H);
        const bil = (f, x, y) => {
          // Texture sampling: texel centres at +0.5, clamp to edge.
          const tx = Math.min(W - 1, Math.max(0, x - 0.5)), ty = Math.min(H - 1, Math.max(0, y - 0.5));
          const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
          const p = (xx, yy) => f[Math.min(H - 1, yy) * W + Math.min(W - 1, xx)];
          return (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy;
        };
        const sample = (f, i) => bil(f, g.L[0] + (i - g.c) * g.e[0], g.L[1] + (i - g.c) * g.e[1]);
        let bad = 0, n = 0, worst = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const p = [x + 0.5 - g.L[0], y + 0.5 - g.L[1]];
          const s = p[0] * g.d[0] + p[1] * g.d[1];
          let want;
          if (s < -1e-3) want = frames[t][y * W + x];
          else {
            const a = ageAt(S, Math.max(0, s));
            if (!Number.isFinite(a)) want = frames[t][y * W + x];
            else if (t - a < -1e-3) want = 0;
            else {
              const f = frames[Math.floor(t - a + 0.5)];
              const col = p[0] * g.e[0] + p[1] * g.e[1] + g.c;
              const i0 = Math.floor(col), fr = col - i0;
              want = sample(f, i0) * (1 - fr) + sample(f, i0 + 1) * fr;
            }
          }
          const e = Math.abs(got[y * W + x] - want);
          n++;
          if (e > 6) bad++;
          worst = Math.max(worst, e);
        }
        // Pixels at the age steps (s on a rounding edge of the frame) may differ.
        assert(bad <= 0.01 * n, `37°: ${bad} of ${n} pixels differ by more than 6 (worst ${worst.toFixed(1)})`);
      });
    },
  },
  {
    name: 'analysis pass: a line change rebuilds the history from the store at once, then the pass fills all rows',
    timeout: 120000,
    async fn() {
      await withMode2(async (page) => {
        const r = await page.evaluate(async () => {
          const N = window.neofx;
          const full = await N.gpu.call({ cmd: 'slitStatus' });
          // Frames 0..9 in the store (the player decoded them): play 10 frames.
          for (let k = 1; k < 10; k++) await N.player.step(1);
          N.change('slitscan.angle', 60);
          await N.applySettings();
          const now = await N.gpu.call({ cmd: 'slitStatus' });
          const status = [];
          await new Promise((res) => {
            const k = () => {
              status.push(document.getElementById('status').textContent);
              if (N.analysis.doneKey === N.slitKey()) res();
              else setTimeout(k, 30);
            };
            k();
          });
          const end = await N.gpu.call({ cmd: 'slitStatus' });
          return { full, now, end, analysing: status.some((s) => s.startsWith('Analysis')), maxAge: N.settings.slitscan.maxAge };
        });
        assert(r.full.filled === 90 && r.full.rows === 90, `after the first pass: ${JSON.stringify(r.full)}`);
        assert(r.now.filled >= 10 && r.now.filled < 90, `just after the change: ${r.now.filled} rows (the frames in the store)`);
        assert(r.end.filled === 90 && r.analysing, `after the pass: ${r.end.filled} rows, status shown ${r.analysing}`);
        assert(r.maxAge === 90, `Max age is limited to the 90 rows: ${r.maxAge}`);
      });
    },
  },
  {
    name: 'line handles: drag the point, turn with Shift (15° steps), touch the arrow to flip; the inspector shows Mode 2',
    timeout: 120000,
    async fn() {
      await withMode2(async (page) => {
        const box = async (sel) => page.locator(sel).boundingBox();
        const c = await box('#handles .hPoint');
        const canvas = await box('#view');
        await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
        await page.mouse.down();
        await page.mouse.move(canvas.x + canvas.width * 0.25, canvas.y + canvas.height * 0.75, { steps: 5 });
        await page.mouse.up();
        let s = await page.evaluate(() => window.neofx.settings.slitscan);
        assert(Math.abs(s.x - 0.25) < 0.01 && Math.abs(s.y - 0.75) < 0.01, `moved to ${s.x}, ${s.y}`);
        const rh = await box('#handles .hRot');
        await page.keyboard.down('Shift');
        await page.mouse.move(rh.x + rh.width / 2, rh.y + rh.height / 2);
        await page.mouse.down();
        // To the upper right of the point: about −40° -> 315° with 15° steps.
        await page.mouse.move(canvas.x + canvas.width * 0.25 + 100, canvas.y + canvas.height * 0.75 - 84, { steps: 5 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        s = await page.evaluate(() => window.neofx.settings.slitscan);
        assert(s.angle % 15 === 0 && s.angle > 300 && s.angle < 330, `turned to ${s.angle}`);
        const before = s.flip;
        const ar = await box('#handles .hArrowHit');
        await page.mouse.click(ar.x + ar.width / 2, ar.y + ar.height / 2);
        s = await page.evaluate(() => window.neofx.settings.slitscan);
        assert(s.flip === !before, 'the arrow flips the direction');
        const keys = await page.evaluate(() => [...document.querySelectorAll('#inspector [data-key^="slitscan."]')].map((e) => e.dataset.key));
        for (const k of ['slitscan.x', 'slitscan.angle', 'slitscan.flip', 'slitscan.width', 'slitscan.time', 'slitscan.rateType', 'slitscan.maxAge', 'slitscan.sampling']) assert(keys.includes(k), `inspector: ${k}`);
        assert(!keys.includes('slitscan.rateEnd'), 'Constant: no Rate at Max age');
        // The age view (heat) on the effect side, the original on the other side.
        const heat = await page.evaluate(async () => {
          window.neofx.change('view', 'map');
          await window.neofx.applySettings();
          await window.neofx.player.seek(80); // at frame 0 all older pixels are not online (black)
          const r = await window.neofx.gpu.call({ cmd: 'read' });
          return r.pixels.some((v, i) => i % 4 === 0 && v > 100);
        });
        assert(heat, 'the age view shows the heat colours');
      });
    },
  },
];
