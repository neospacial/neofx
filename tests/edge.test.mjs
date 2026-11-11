// Phase 9 (plan §14, §13.2): Mode 2 with the Subject edge source, and Scan object.
// "Edge source: the trail of the disc starts at the disc edge and goes in the set direction."
// "Preview GPU time is measured and the Max age limit works."
// The mask is the imported ground-truth mask video (exact), so the model of the trail is exact up to
// the anti-aliased mask edge (a margin of 1.5 px).

import { createRequire } from 'node:module';
import { assert, hasFfmpeg } from './lib/util.mjs';
import { makeFixtures, subjectAt } from '../tools/make-fixtures.mjs';
import { FIX_DIR } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const W = 320, H = 240, M = 30;

// The scan direction d and the row direction e of an edge angle (axis-aligned here).
const dirs = (deg) => {
  const a = (deg * Math.PI) / 180;
  const r = (v) => Math.round(v);
  const d = [r(Math.cos(a)), r(Math.sin(a))];
  return { d, e: [-d[1], d[0]] };
};

// The leading edge (x') of the disc of frame f in the row y' (or null): the exit point along +x'.
function leading(f, yp, deg) {
  const { d, e } = dirs(deg);
  const s = subjectAt(f);
  const cx = (s.cx + 0.5 - W / 2) * d[0] + (s.cy + 0.5 - H / 2) * d[1];
  const cy = (s.cx + 0.5 - W / 2) * e[0] + (s.cy + 0.5 - H / 2) * e[1];
  const h = s.r * s.r - (yp - cy) ** 2;
  return h > 0 ? cx + Math.sqrt(h) : null;
}

// The trail model at pixel (x, y), frame t (rate 1, Max age m): 'in' (surely trail), 'out' (surely not),
// or null (near a border). A join of two frames happens when their edges are nearer than the join
// limit (8 px); the edge positions of the GPU come from the mask (sub-pixel), so a join near the limit
// is not sure: 'in' counts only joins under 6.5 px, 'out' counts the joins up to 9.5 px.
function model(x, y, t, deg, m = M) {
  const { d, e } = dirs(deg);
  const xp = (x + 0.5 - W / 2) * d[0] + (y + 0.5 - H / 2) * d[1];
  const yp = (x + 0.5 - W / 2) * e[0] + (y + 0.5 - H / 2) * e[1];
  let dIn = Infinity, dOut = Infinity; // the distance of x' to the trail intervals of the row (negative inside)
  for (let a = 0; a < m; a++) {
    const f = t - a;
    if (f < 0) break;
    const x0 = leading(f, yp, deg);
    if (x0 === null) continue;
    const x1 = f >= 1 ? leading(f - 1, yp, deg) : null;
    const X0 = x0 + a;
    const span = (join) => {
      const X1 = x1 !== null && Math.abs(x1 - x0) < join ? x1 + a + 1 : X0;
      return Math.max(Math.min(X0, X1) - 0.5 - xp, xp - Math.max(X0, X1) - 0.5);
    };
    dIn = Math.min(dIn, span(6.5));
    dOut = Math.min(dOut, span(9.5));
  }
  if (dIn < -1.5) return 'in';
  if (dOut > 1.5) return 'out';
  return null;
}

async function withEdge(fn) {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, ['subject.mp4', 'subjectmask.mp4']);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
  try {
    await open(page, f['subject.mp4']);
    await page.evaluate(() => window.neofx.change('cutout.bgdiff.on', false));
    await page.setInputFiles('#maskFileInput', f['subjectmask.mp4']);
    await page.waitForFunction(() => window.neofx.settings.cutout.import.on, null, { timeout: 30000 });
    await page.evaluate((M) => {
      const N = window.neofx;
      N.change('mode', 'slitscan');
      N.change('cutout.mode', 'scan');
      N.change('slitscan.maxAgeEdge', M);
      window.__grab = async (t) => {
        await N.applySettings();
        await N.player.seek(t);
        await N.gpu.call({ cmd: 'render', index: t });
        const res = (await N.gpu.call({ cmd: 'read' })).pixels;
        await N.gpu.call({ cmd: 'render', index: t, delay: 0 });
        const orig = (await N.gpu.call({ cmd: 'read' })).pixels;
        await N.gpu.call({ cmd: 'render', index: t });
        const flip = (p) => {
          const o = [];
          for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
            const i = ((239 - y) * 320 + x) * 4;
            o.push(p[i], p[i + 1], p[i + 2]);
          }
          return o;
        };
        return { res: flip(res), orig: flip(orig) };
      };
    }, M);
    await waitAnalysis(page);
    await fn(page);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

const waitAnalysis = (page) => page.waitForFunction(() => {
  const N = window.neofx;
  return N.analysis.doneKey === N.slitKey() && !N.analysis.running;
}, null, { timeout: 90000 });

const setEdge = async (page, values) => {
  await page.evaluate((v) => {
    for (const [k, x] of Object.entries(v)) window.neofx.change(k, x);
  }, values);
  await waitAnalysis(page);
};

const px = (a, x, y) => a.slice((y * W + x) * 3, (y * W + x) * 3 + 3);
const near = (p, q, tol) => p.every((v, i) => Math.abs(v - q[i]) <= tol);

// Check the trail at frame t against the model: trail pixels are bright (the emitter colour is the
// last subject pixel at the edge: the bright disc, mixed with the background by the 4:2:0 chroma of
// the video, so not one exact colour); the background is grey noise (luma about 90). Other pixels
// (outside the subject) are the original.
const luma = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
function checkTrail(name, r, t, deg, m = M) {
  const s = subjectAt(t);
  let nIn = 0, badIn = 0, nOut = 0, badOut = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.hypot(x - s.cx, y - s.cy) < s.r + 2) continue; // the subject is on top
    const k = model(x, y, t, deg, m);
    if (k === 'in') {
      nIn++;
      if (luma(px(r.res, x, y)) < 170) badIn++;
    } else if (k === 'out') {
      nOut++;
      if (!near(px(r.res, x, y), px(r.orig, x, y), 6)) badOut++;
    }
  }
  assert(nIn > 200, `${name}: the model has ${nIn} trail pixels`);
  assert(badIn < 0.03 * nIn && badOut < 0.005 * nOut, `${name}: trail ${badIn} of ${nIn} wrong, background ${badOut} of ${nOut} wrong`);
  return nIn;
}

export const tests = [
  {
    name: '§13.2 edge source: the trail of the disc starts at the disc edge and goes in the set direction (180°, 90°, 270°, flip)',
    timeout: 300000,
    async fn() {
      await withEdge(async (page) => {
        await setEdge(page, { 'slitscan.edgeAngle': 180 });
        for (const t of [20, 45]) checkTrail(`180° t ${t}`, await page.evaluate((t) => window.__grab(t), t), t, 180);
        // Left of the disc there is a trail, right of it nothing (the direction).
        const r = await page.evaluate(() => window.__grab(45));
        const s = subjectAt(45);
        const y = Math.round(s.cy);
        assert(luma(px(r.res, Math.round(s.cx - s.r - 4), y)) > 170, 'a trail starts at the left edge');
        assert(near(px(r.res, Math.round(s.cx + s.r + 6), y), px(r.orig, Math.round(s.cx + s.r + 6), y), 6), 'nothing at the right edge');
        await setEdge(page, { 'slitscan.edgeAngle': 90 });
        checkTrail('90° (down) t 40', await page.evaluate(() => window.__grab(40)), 40, 90);
        await setEdge(page, { 'slitscan.edgeAngle': 270 });
        checkTrail('270° (up) t 33', await page.evaluate(() => window.__grab(33)), 33, 270);
        await setEdge(page, { 'slitscan.edgeAngle': 0, 'slitscan.flip': true });
        checkTrail('0° flipped (= 180°) t 30', await page.evaluate(() => window.__grab(30)), 30, 180);
      });
    },
  },
  {
    name: 'edge source, Time Off: the edge colour repeats from the edge to the end of the row; Overlay (Replace) and Scan object (Blend)',
    timeout: 240000,
    async fn() {
      await withEdge(async (page) => {
        await setEdge(page, { 'slitscan.edgeAngle': 180, 'slitscan.time': false });
        let r = await page.evaluate(() => window.__grab(30));
        let s = subjectAt(30);
        let bad = 0, n = 0;
        for (let y = Math.ceil(s.cy - s.r + 3); y < s.cy + s.r - 3; y++) {
          const xl = s.cx - Math.sqrt(s.r * s.r - (y + 0.5 - s.cy) ** 2);
          for (let x = 0; x < xl - 2; x++) {
            n++;
            if (luma(px(r.res, x, y)) < 170) bad++;
          }
        }
        assert(n > 1000 && bad < 0.02 * n, `time off: ${bad} of ${n} pixels are not the (bright) edge colour`);
        // Overlay with the edge source: Replace, the trail as it is.
        await setEdge(page, { 'slitscan.time': true, 'cutout.mode': 'overlay', 'slitscan.source': 'edge', 'composite.opacity': 0.5 });
        r = await page.evaluate(() => window.__grab(45));
        s = subjectAt(45);
        const x = Math.round(s.cx - s.r - 4), y = Math.round(s.cy);
        const trail = luma(px(r.res, x, y)), orig = luma(px(r.orig, x, y));
        assert(trail > 170, `overlay: the trail replaces (${trail.toFixed(0)})`);
        // Scan object always blends: with opacity 0.5 the trail pixel is half the original.
        await setEdge(page, { 'cutout.mode': 'scan' });
        r = await page.evaluate(() => window.__grab(45));
        const half = luma(px(r.res, x, y));
        assert(Math.abs(half - (trail + orig) / 2) < 15, `scan object, opacity 0.5: ${half.toFixed(0)}, want about ${((trail + orig) / 2).toFixed(0)}`);
        const ui = await page.evaluate(() => ({
          line: document.querySelector('[data-key="slitscan.source"] button[data-value="line"]').disabled,
          dir: !!document.querySelector('[data-key="slitscan.edgeAngle"]'),
          join: !!document.querySelector('[data-key="slitscan.joinLimit"]'),
        }));
        assert(ui.line && ui.dir && ui.join, `Scan object: Line is off, the edge settings show: ${JSON.stringify(ui)}`);
      });
    },
  },
  {
    name: 'the trail GPU time is measured, and the Max age limit (20 ms target) works; the analysis pass fills the emitter history',
    timeout: 240000,
    async fn() {
      await withEdge(async (page) => {
        await setEdge(page, { 'slitscan.edgeAngle': 180 });
        const st = await page.evaluate(async () => {
          await window.__grab(45);
          return window.neofx.gpu.call({ cmd: 'slitStatus' });
        });
        assert(st.edge.filled === 60 && st.edge.rows === 60, `emitter history: ${JSON.stringify(st.edge)}`);
        assert(st.edge.ms >= 0 && st.edge.limit >= 8 && st.edge.maxAge === M, `measured: ${JSON.stringify(st.edge)}`);
        console.log(`      (trail draw: ${st.edge.ms.toFixed(2)} ms for ${st.edge.maxAge} frames of age)`);
        // A slow GPU (2 ms for each frame of age): the limit is 20 / 2 = 10 frames.
        await page.evaluate(() => window.neofx.gpu.call({ cmd: 'edgeTest', msPerAge: 2 }));
        const slow = await page.evaluate(async () => {
          await window.__grab(45); // the first render measures
          const r = await window.__grab(45); // the second one uses the limit
          const s = await window.neofx.gpu.call({ cmd: 'slitStatus' });
          window.neofx.refreshEdgeStats();
          await new Promise((res) => setTimeout(res, 400));
          return { r, s, note: document.querySelector('#inspector .edgeLimit').textContent };
        });
        assert(slow.s.edge.limit === 10 && slow.s.edge.maxAge === 10, `limit ${JSON.stringify(slow.s.edge)}`);
        assert(/^Limit: 10 frames/.test(slow.note), `the inspector shows "${slow.note}"`);
        checkTrail('limited to 10 frames', slow.r, 45, 180, 10);
        await page.evaluate(() => window.neofx.gpu.call({ cmd: 'edgeTest', msPerAge: 0 }));
      });
    },
  },
  {
    name: 'edge direction handle: drag it to turn the direction (the line handles are hidden)',
    timeout: 120000,
    async fn() {
      await withEdge(async (page) => {
        const vis = await page.evaluate(() => [getComputedStyle(document.querySelector('#handles .hLine')).display, getComputedStyle(document.querySelector('#handles .hPoint')).display]);
        assert(vis.join() === 'none,none', `line handles ${vis}`);
        const h = await page.locator('#handles .hRot').boundingBox();
        const c = await page.locator('#view').boundingBox();
        await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
        await page.mouse.down();
        await page.mouse.move(c.x + c.width / 2, c.y + c.height * 0.9, { steps: 5 }); // below the centre: 90°
        await page.mouse.up();
        const a = await page.evaluate(() => window.neofx.settings.slitscan.edgeAngle);
        assert(Math.abs(a - 90) < 2, `edge direction ${a}`);
      });
    },
  },
];
