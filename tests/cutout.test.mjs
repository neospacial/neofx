// Phase 8 (plan §14, §13.2): the cutout. "Mask: IoU with the ground truth > 0.9 for the fixture."
// The fixture: a disc that moves on a still noise background (a dark hole in the disc, a still bright
// square at the top right); the ground truth is the disc (inSubject). Also: the keys, the clean-up,
// the garbage matte, the mask import, the subject layer (Overlay in Mode 1 and Mode 2), the subject
// maps, and the Mask view.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { assert, hasFfmpeg, OUT_DIR } from './lib/util.mjs';
import { grayPng } from './lib/png.mjs';
import { makeFixtures, inSubject, subjectAt } from '../tools/make-fixtures.mjs';
import { FIX_DIR } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { medianBytes, plateIndices } from '../src/analysis/cleanplate.js';
import { cleanRegions } from '../src/analysis/regions.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const W = 320, H = 240;

// IoU of a mask (bytes, > 127 = subject) and the ground truth of frame t.
function iou(mask, t, gt = (x, y) => inSubject(t, x, y)) {
  let i = 0, u = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = mask[y * W + x] > 127, b = gt(x, y);
    if (a && b) i++;
    if (a || b) u++;
  }
  return u ? i / u : 1;
}

async function withApp(file, fn) {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, [file, 'subjectmask.mp4']);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
  try {
    await open(page, f[file]);
    await page.evaluate(() => {
      window.__mask = async (t) => {
        const N = window.neofx;
        await N.player.seek(t);
        const r = await N.gpu.call({ cmd: 'readMask', index: t });
        return Array.from(r.pixels);
      };
      window.__set = async (values) => {
        for (const [k, v] of Object.entries(values)) window.neofx.change(k, v);
        await window.neofx.applySettings();
      };
    });
    await fn(page, f);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

const set = (page, values) => page.evaluate((v) => window.__set(v), values);
const maskAt = (page, t) => page.evaluate((t) => window.__mask(t), t);
const waitPlate = (page) => page.waitForFunction(() => window.neofx.toolState.plateOk, null, { timeout: 60000 });

export const tests = [
  {
    name: 'clean plate median and region clean-up (Node)',
    fn() {
      // 5 frames of 4 bytes: a bright object moves over a grey background; the median is the background.
      const frames = [0, 1, 2, 3, 0].map((pos) => {
        const f = new Uint8Array(4).fill(100);
        f[pos] = 250;
        return f;
      });
      const m = medianBytes(frames);
      assert(m.every((v) => v === 100), `median ${m}`);
      assert(medianBytes([Uint8Array.of(1), Uint8Array.of(9), Uint8Array.of(4), Uint8Array.of(6)])[0] === 5, 'an even count: the mean of the two middle values');
      const idx = plateIndices(600);
      assert(idx.length === 31 && idx[0] >= 0 && idx[30] <= 599 && idx.every((t, i) => !i || t > idx[i - 1]), 'plate indices');
      assert(plateIndices(10).length === 10, 'short video: each frame once');
      // A ring (subject) with a hole, a small spot, a background region at the border.
      const w = 12, h = 9, b = new Uint8Array(w * h);
      for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) b[y * w + x] = 1;
      b[4 * w + 4] = 0; // a hole
      b[1 * w + 10] = 1; // a spot
      const r = cleanRegions(b, w, h, 5, true);
      assert(r.fill[4 * w + 4] === 1 && r.fill.reduce((a, v) => a + v, 0) === 1, 'fill the hole only');
      assert(r.remove[1 * w + 10] === 1 && r.remove.reduce((a, v) => a + v, 0) === 1, 'remove the spot only');
      assert(cleanRegions(b, w, h, 0.5, false).fill[4 * w + 4] === 0, 'a hole larger than the limit stays');
    },
  },
  {
    name: '§13.2 mask: background difference with the Auto clean plate (median of 31 frames): IoU > 0.9',
    timeout: 180000,
    async fn() {
      await withApp('subject.mp4', async (page) => {
        await set(page, { 'cutout.mode': 'overlay' });
        await waitPlate(page);
        const text = await page.evaluate(() => window.neofx.toolState.plateText);
        assert(/Median of 31 frames/.test(text), `plate: ${text}`);
        for (const t of [3, 20, 37, 55]) {
          const v = iou(await maskAt(page, t), t);
          assert(v > 0.9, `frame ${t}: IoU ${v.toFixed(3)}`);
        }
      });
    },
  },
  {
    name: 'luma key + clean-up: Fill holes and Keep largest region give IoU > 0.9 (the raw key has the hole and the square)',
    timeout: 180000,
    async fn() {
      await withApp('subject.mp4', async (page) => {
        await set(page, { 'cutout.mode': 'overlay', 'cutout.bgdiff.on': false, 'cutout.luma.on': true, 'cutout.luma.low': 0.75, 'cutout.luma.softness': 0.02 });
        const raw = await maskAt(page, 30);
        const sq = raw[17 * W + 287] > 127, hole = raw[Math.round(subjectAt(30).cy) * W + Math.round(subjectAt(30).cx + 10)] > 127;
        assert(sq && !hole, `raw luma key: square ${sq}, hole ${hole}`);
        const before = iou(raw, 30);
        await set(page, { 'cutout.fillHoles': 2, 'cutout.keepLargest': true });
        const fixed = await maskAt(page, 30);
        const after = iou(fixed, 30);
        assert(after > 0.9 && after > before, `IoU ${before.toFixed(3)} -> ${after.toFixed(3)}`);
        // Grow / shrink: the area changes by about the perimeter × px.
        const area = (m) => m.filter((v) => v > 127).length;
        const a0 = area(fixed);
        await set(page, { 'cutout.grow': 4 });
        const a1 = area(await maskAt(page, 30));
        await set(page, { 'cutout.grow': -4 });
        const a2 = area(await maskAt(page, 30));
        // About the perimeter × 4 px; the square kernel (separable min / max) changes the diagonals more.
        const per = 2 * Math.PI * 32 * 4;
        assert(a1 - a0 > 0.7 * per && a1 - a0 < 1.8 * per && a0 - a2 > 0.6 * per && a0 - a2 < 1.8 * per, `grow ${a0} -> ${a1}, shrink -> ${a2}`);
        // Feather: soft edge values.
        await set(page, { 'cutout.grow': 0, 'cutout.feather': 4 });
        const soft = (await maskAt(page, 30)).filter((v) => v > 20 && v < 235).length;
        assert(soft > 500, `feather: ${soft} soft pixels`);
        // Open removes small spots: a low key has noise spots in the background.
        await set(page, { 'cutout.feather': 0, 'cutout.fillHoles': 0, 'cutout.keepLargest': false, 'cutout.luma.low': 0.42 });
        const spotty = (await maskAt(page, 30)).filter((v, i) => v > 127 && !inSubject(30, i % W, Math.floor(i / W))).length;
        await set(page, { 'cutout.open': 2 });
        const opened = (await maskAt(page, 30)).filter((v, i) => v > 127 && !inSubject(30, i % W, Math.floor(i / W))).length;
        assert(spotty > 50 && opened < spotty / 4, `open: background pixels ${spotty} -> ${opened}`);
      });
    },
  },
  {
    name: 'chroma key with the eyedropper (green screen): IoU > 0.9',
    timeout: 120000,
    async fn() {
      await withApp('greenscreen.mp4', async (page) => {
        await set(page, { 'cutout.mode': 'overlay', 'cutout.bgdiff.on': false });
        // The Pick tool, then a touch on the background (top left).
        await page.evaluate(() => window.neofx.tools.setTool('pick'));
        const box = await page.locator('#view').boundingBox();
        await page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.1);
        await page.waitForFunction(() => window.neofx.settings.cutout.chroma.on && window.neofx.settings.cutout.chroma.key !== '#00ff00');
        const key = await page.evaluate(() => window.neofx.settings.cutout.chroma.key);
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(key.slice(i, i + 2), 16));
        assert(g > r + 60 && g > b + 60, `picked key ${key}`);
        for (const t of [10, 45]) {
          const v = iou(await maskAt(page, t), t);
          assert(v > 0.9, `chroma key, frame ${t}: IoU ${v.toFixed(3)}`);
        }
      });
    },
  },
  {
    name: 'mask import, garbage matte brush (always / never / erase / clear), temporal smooth and hysteresis',
    timeout: 180000,
    async fn() {
      await withApp('subject.mp4', async (page, f) => {
        await set(page, { 'cutout.mode': 'overlay', 'cutout.bgdiff.on': false });
        await page.setInputFiles('#maskFileInput', f['subjectmask.mp4']);
        await page.waitForFunction(() => window.neofx.settings.cutout.import.on, null, { timeout: 30000 });
        for (const t of [0, 25, 59]) {
          const v = iou(await maskAt(page, t), t);
          assert(v > 0.95, `import, frame ${t}: IoU ${v.toFixed(3)}`);
        }
        // The brush: Never over the disc of frame 25, Always in the bottom left corner.
        const d = subjectAt(25);
        const box = await page.locator('#view').boundingBox();
        const at = (x, y) => [box.x + (x / W) * box.width, box.y + (y / H) * box.height];
        await page.evaluate(() => {
          window.neofx.toolState.brush.size = 30;
          window.neofx.toolState.brush.hardness = 1;
          window.neofx.tools.setTool('never');
        });
        await page.mouse.move(...at(d.cx - 10, d.cy));
        await page.mouse.down();
        await page.mouse.move(...at(d.cx + 10, d.cy), { steps: 4 });
        await page.mouse.up();
        await page.evaluate(() => window.neofx.tools.setTool('always'));
        await page.mouse.click(...at(30, 210));
        await page.waitForTimeout(100);
        let m = await maskAt(page, 25);
        const v = (x, y) => m[Math.round(y) * W + Math.round(x)];
        assert(v(d.cx, d.cy) === 0 && v(d.cx - 10, d.cy) === 0 && v(d.cx, d.cy - 25) > 200, `never: centre ${v(d.cx, d.cy)}, edge ${v(d.cx, d.cy - 25)}`);
        assert(v(30, 210) > 200 && v(60, 210) === 0, `always: ${v(30, 210)}, outside ${v(60, 210)}`);
        await page.evaluate(() => window.neofx.tools.setTool('erase'));
        await page.mouse.click(...at(30, 210));
        await page.waitForTimeout(100);
        m = await maskAt(page, 25);
        assert(v(30, 210) === 0 && v(d.cx, d.cy) === 0, 'erase: only the brushed place');
        await page.evaluate(() => document.querySelector('#inspector button[data-act="clearMatte"]').click()); // in a closed section
        await page.waitForTimeout(100);
        m = await maskAt(page, 25);
        assert(v(d.cx, d.cy) > 200, 'clear: the matte is gone');
        // Temporal smooth: the mask of t + 1 after t mixes the two; a seek (no t − 1) does not.
        await page.evaluate(() => window.neofx.tools.setTool(null));
        await set(page, { 'cutout.smooth': 0.5 });
        const seq = await page.evaluate(async () => {
          await window.__mask(30);
          return window.__mask(31);
        });
        await maskAt(page, 10);
        const fresh = await maskAt(page, 31);
        const mid = seq.filter((x) => x > 100 && x < 155).length;
        assert(mid > 50 && fresh.filter((x) => x > 100 && x < 155).length < 10, `smooth: ${mid} half values after frame 30`);
        await set(page, { 'cutout.hysteresis': true });
        const h = await page.evaluate(async () => {
          await window.__mask(40);
          return window.__mask(41);
        });
        assert(h.every((x) => x === 0 || x === 255), 'hysteresis: a binary mask');
      });
    },
  },
  {
    name: 'Overlay: the subject (frame t) on top of the effect, in Mode 1 and Mode 2; outline; Mask view',
    timeout: 180000,
    async fn() {
      await withApp('subject.mp4', async (page) => {
        await set(page, { 'cutout.mode': 'overlay', 'timemap.maxDelay': 20, 'timemap.blend': false });
        await waitPlate(page);
        const grab = (index, delay) => page.evaluate(async ([index, delay]) => {
          const N = window.neofx;
          await N.gpu.call(delay < 0 ? { cmd: 'render', index } : { cmd: 'render', index, delay }); // −1: the effect
          const r = await N.gpu.call({ cmd: 'read' });
          const o = [];
          for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) o.push(r.pixels[((239 - y) * 320 + x) * 4 + 1]);
          return o;
        }, [index, delay]);
        const check = async (name, t, outside) => {
          await page.evaluate((t) => window.neofx.player.seek(t), t);
          const res = await grab(t, -1);
          const orig = await grab(t, 0);
          const d = subjectAt(t);
          let bad = 0, n = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const r = Math.hypot(x - d.cx, y - d.cy);
            if (r < d.r - 4) {
              n++;
              if (Math.abs(res[y * W + x] - orig[y * W + x]) > 6) bad++;
            }
          }
          assert(n > 1000 && bad < 0.01 * n, `${name}: the subject is frame t (${bad} of ${n} differ)`);
          if (outside) await outside(res, d);
        };
        // Mode 1: outside the subject, the effect: the pixel of frame t − round(d), d = 20 (y + 0.5) / 240.
        await check('Mode 1', 40, async (res) => {
          const frames = [];
          for (let k = 0; k <= 20; k++) frames.push(await grab(40, k));
          const d = subjectAt(40);
          let bad = 0, n = 0, moved = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (Math.hypot(x - d.cx, y - d.cy) < d.r + 4) continue;
            const k = Math.floor((20 * (y + 0.5)) / H + 0.5);
            n++;
            if (Math.abs(res[y * W + x] - frames[k][y * W + x]) > 6) bad++;
            if (Math.abs(frames[k][y * W + x] - frames[0][y * W + x]) > 40) moved++;
          }
          assert(bad < 0.01 * n && moved > 500, `Mode 1 effect outside the subject: ${bad} of ${n} differ; ${moved} pixels show the past disc`);
        });
        // Outline (red, 3 px): a ring outside the subject.
        await set(page, { 'subject.outline': 3, 'subject.outlineColor': '#ff0000' });
        await page.evaluate(() => window.neofx.player.seek(40));
        const rd = await page.evaluate(async () => {
          const r = await window.neofx.gpu.call({ cmd: 'read' });
          return Array.from(r.pixels);
        });
        const d = subjectAt(40);
        const px = (x, y) => rd.slice(((239 - y) * 320 + x) * 4, ((239 - y) * 320 + x) * 4 + 3);
        const ring = px(Math.round(d.cx), Math.round(d.cy - d.r - 2)); // 2 px out, in the 3 px ring
        assert(ring[0] > 200 && ring[1] < 60, `outline colour ${ring}`);
        await set(page, { 'subject.outline': 0, mode: 'slitscan' });
        await page.waitForFunction(() => window.neofx.analysis.doneKey === window.neofx.slitKey(), null, { timeout: 60000 });
        await check('Mode 2', 45);
        // The Mask view: the mask in white.
        await set(page, { view: 'mask' });
        const mv = await grab(45, -1);
        const v = iou(mv.map((x) => x), 45);
        assert(v > 0.9, `Mask view IoU ${v.toFixed(3)}`);
      });
    },
  },
  {
    name: 'subject maps (Mode 1): Subject mask = the mask; Subject distance = the distance to the subject / falloff',
    timeout: 180000,
    async fn() {
      await withApp('subject.mp4', async (page) => {
        await set(page, { 'map.type': 'subject', view: 'map' });
        await waitPlate(page);
        const read = () => page.evaluate(async () => {
          await window.neofx.player.seek(30);
          await window.neofx.gpu.call({ cmd: 'render', index: 30 });
          const r = await window.neofx.gpu.call({ cmd: 'read' });
          const o = [];
          for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) o.push(r.pixels[((239 - y) * 320 + x) * 4]);
          return o;
        });
        const sm = await read();
        assert(iou(sm, 30) > 0.9, `subject map IoU ${iou(sm, 30).toFixed(3)}`);
        await set(page, { 'map.type': 'subjectdist', 'map.params.subjectdist.falloff': 100 });
        const dm = await read();
        const d = subjectAt(30);
        let worst = 0;
        for (const [x, y] of [[5, 5], [300, 200], [d.cx + 60, d.cy], [d.cx, d.cy + 50], [d.cx - 45, d.cy]]) {
          if (y < 0 || y >= H) continue;
          const want = Math.min(1, Math.max(0, Math.hypot(x - d.cx, y - d.cy) - d.r) / 100) * 255;
          worst = Math.max(worst, Math.abs(dm[Math.round(y) * W + Math.round(x)] - want));
        }
        assert(worst < 12, `subject distance error ${worst.toFixed(1)} (of 255)`);
        assert(dm[Math.round(d.cy) * W + Math.round(d.cx)] < 5, 'inside the subject: 0');
      });
    },
  },
  {
    name: 'clean plate from this frame and from an image file',
    timeout: 120000,
    async fn() {
      await withApp('subject.mp4', async (page) => {
        await set(page, { view: 'mask' });
        await waitPlate(page);
        await page.evaluate(async () => {
          await window.neofx.player.seek(12);
          await window.neofx.makePlate('frame');
        });
        const t = await page.evaluate(() => window.neofx.toolState.plateText);
        assert(t === 'Frame 12', `plate text ${t}`);
        // With frame 12 as the plate, the disc of frame 12 is not a subject at frame 12.
        const m12 = await maskAt(page, 12);
        assert(iou(m12, 12) < 0.2, 'the plate has the disc of frame 12');
        const png = path.join(OUT_DIR, 'plate_grey.png');
        fs.writeFileSync(png, grayPng(64, 48, () => 90));
        await page.setInputFiles('#plateFileInput', png);
        await page.waitForFunction(() => window.neofx.toolState.plateText === 'plate_grey.png');
      });
    },
  },
];
