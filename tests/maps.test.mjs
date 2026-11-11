// Phase 5 (plan §14): the map library (§7.3), image and video maps (§7.4), adjustments (§7.5),
// animation (§7.6), map thumbnails. "All maps render. Fit modes are correct."
// The GPU maps are read from the Map view (8 bit) and compared with a JS reference.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { assert, hasFfmpeg, ffmpeg, OUT_DIR } from './lib/util.mjs';
import { grayPng } from './lib/png.mjs';
import { mapRef, customRef } from './lib/mapref.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { MAPS, defaultParams, videoMapFrame, isDynamic, paramArray } from '../src/maps/builtin.js';
import { monotoneCurve, curveTable, CURVE_PRESETS } from '../src/maps/curve.js';
import { DEFAULTS, clone } from '../src/app/settings.js';
import { videoMapSize } from '../src/maps/mapsource.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const W = 320, H = 240;

// Set settings (path -> value) and read the Map view at frame t: luma rows, top row first.
async function mapView(page, values, t = 40) {
  return page.evaluate(async ([values, t]) => {
    const N = window.neofx;
    for (const [k, v] of Object.entries(values)) N.change(k, v);
    await N.applySettings();
    if (N.player.current !== t) await N.player.seek(t);
    const r = await N.gpu.call({ cmd: 'read' });
    const out = new Uint8Array(r.width * r.height);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) out[y * r.width + x] = r.pixels[((r.height - 1 - y) * r.width + x) * 4];
    return Array.from(out);
  }, [values, t]);
}

// A fresh map settings object (with paths for change()).
function mapValues(map) {
  const out = {};
  const walk = (o, p) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${p}.${k}`);
      else out[`${p}.${k}`] = v;
    }
  };
  walk(map, 'map');
  return out;
}

// Compare a GPU map with the reference. Pixels where the reference is next to a jump (fract
// wrap, hard edge) may differ: at most `allow` of them.
function compare(name, got, ref, tol = 2.5, allow = 0.02) {
  let bad = 0, worst = 0, where = null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const want = ref(x, y) * 255;
    const e = Math.abs(got[y * W + x] - want);
    if (e > tol) {
      bad++;
      if (e > worst) {
        worst = e;
        where = [x, y, got[y * W + x], want.toFixed(1)];
      }
    }
  }
  assert(bad <= allow * W * H, `${name}: ${bad} pixels differ (${((100 * bad) / (W * H)).toFixed(2)} %), worst at ${where}`);
}

const stats = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return { mean: m / 255, std: Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) / 255 };
};

async function withApp(fn) {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, ['code.mp4']);
  const gt = groundTruth(f['code.mp4']);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
  try {
    await open(page, f['code.mp4']);
    await page.evaluate(() => window.neofx.change('view', 'map'));
    await fn(page, gt.codes);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

const base = () => clone(DEFAULTS.map);

export const tests = [
  {
    name: 'map specs, curves, video map frames (Node)',
    fn() {
      const P = defaultParams();
      assert(MAPS.length === 22 && Object.keys(P).length === 22, 'all §7.3 maps are listed');
      assert(P.linear.angle === 90 && paramArray('fbm', P.fbm).length === 4, 'defaults');
      for (const [k, pts] of Object.entries(CURVE_PRESETS)) {
        const t = curveTable(pts);
        assert(Math.abs(t[0] - pts[0][1]) < 1e-6 && Math.abs(t[255] - pts[pts.length - 1][1]) < 1e-6, `${k}: ends`);
        for (let i = 1; i < 256; i++) assert(t[i] >= t[i - 1] - 1e-6, `${k}: monotone at ${i}`);
        const f = monotoneCurve(pts);
        for (const [x, y] of pts) assert(Math.abs(f(x) - y) < 1e-9, `${k}: through its points`);
      }
      const seq = (end, speed = 1, off = 0) => Array.from({ length: 12 }, (_, t) => videoMapFrame(t, 4, speed, off, end)).join('');
      assert(seq('loop') === '012301230123' && seq('hold') === '012333333333' && seq('pingpong') === '012321012321', 'end behaviors');
      assert(seq('loop', 0.5, 1) === '122330011223' && seq('loop', -1) === '032103210321', 'speed and offset');
      const m = base();
      assert(!isDynamic(m), 'linear is static');
      m.anim.rotSpeed = 1;
      assert(isDynamic(m), 'an animated map is dynamic');
      const s = videoMapSize(1920, 1080, 600, 540, 2048);
      assert(s.height === 540 && s.count === Math.floor((256 * 1048576) / (960 * 540)), `video map size ${JSON.stringify(s)}`);
    },
  },
  {
    name: 'all maps render: the geometric maps equal the reference; noise maps are deterministic and change with the seed',
    timeout: 240000,
    async fn() {
      await withApp(async (page) => {
        const geometric = ['linear', 'mirrored', 'radial', 'angular', 'spiral', 'box', 'corners', 'stripes', 'sine', 'rings', 'checker', 'bayer'];
        // Each map with its defaults, and with other params.
        const variants = {
          linear: [{ angle: 37, x: 0.3, y: 0.6, width: 0.5 }],
          mirrored: [{ angle: 0, width: 0.4 }],
          radial: [{ x: 0.2, y: 0.7, radius: 0.4, aspect: 2 }],
          angular: [{ start: 45, turns: 3 }],
          spiral: [{ arms: 3, tightness: 7 }],
          box: [{ roundness: 0.5, size: 0.3 }, { roundness: 1 }, { roundness: 0.25, x: 0.7 }],
          corners: [{ tl: 1, tr: 0, bl: 0.2, br: 0.9 }],
          stripes: [{ count: 5, angle: 30, softness: 0.3, duty: 0.3 }],
          sine: [{ fx: 2, fy: 3, angle: 20, phase: 0.25 }],
          rings: [{ count: 4, softness: 1 }],
          checker: [{ cells: 5, softness: 0.5 }],
          bayer: [{ matrix: 3, base: 0.3 }, { matrix: 1, base: 0.8 }],
        };
        for (const id of geometric) {
          for (const p of [{}, ...(variants[id] || [])]) {
            const m = base();
            m.type = id;
            Object.assign(m.params[id], p);
            const got = await mapView(page, mapValues(m));
            compare(`${id} ${JSON.stringify(p)}`, got, (x, y) => mapRef(m, 40, x, y, W, H));
          }
        }
        for (const id of ['fbm', 'ridged', 'worley', 'voronoi', 'blocks', 'rows']) {
          const m = base();
          m.type = id;
          const a = await mapView(page, mapValues(m));
          const again = await mapView(page, { 'map.params.linear.angle': 91 }); // a change of other settings: same map
          assert(a.every((v, i) => v === again[i]), `${id}: deterministic`);
          const s = stats(a);
          assert(s.mean > 0.15 && s.mean < 0.85 && s.std > 0.05, `${id}: mean ${s.mean.toFixed(2)}, std ${s.std.toFixed(3)}`);
          const b = await mapView(page, { [`map.params.${id}.seed`]: 77 });
          const diff = a.reduce((x, v, i) => x + Math.abs(v - b[i]), 0) / a.length / 255;
          assert(diff > 0.05, `${id}: the seed changes the map (${diff.toFixed(3)})`);
        }
        // Blocks and rows: constant inside each block / row.
        const blocks = await mapView(page, { 'map.type': 'blocks', 'map.params.blocks.bw': 40, 'map.params.blocks.bh': 30 });
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert(blocks[y * W + x] === blocks[Math.floor(y / 30) * 30 * W + Math.floor(x / 40) * 40], `blocks: pixel ${x},${y}`);
        const cols = await mapView(page, { 'map.type': 'rows', 'map.params.rows.size': 20, 'map.params.rows.direction': 1 });
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert(cols[y * W + x] === cols[Math.floor(x / 20) * 20], `columns: pixel ${x},${y}`);
      });
    },
  },
  {
    name: 'frame maps: Video luminance is the luma of frame t; Motion is the change from frame t − 1',
    timeout: 120000,
    async fn() {
      await withApp(async (page, codes) => {
        const bit = (t, cx, cy) => (codes[t] >> ((cx + 3 * cy) % 16)) & 1;
        const self = await mapView(page, { 'map.type': 'self' }, 50);
        for (let cy = 0; cy < 30; cy++) for (let cx = 0; cx < 40; cx++) {
          const v = self[(cy * 8 + 4) * W + cx * 8 + 4];
          assert(Math.abs(v - 255 * bit(50, cx, cy)) < 12, `self: block ${cx},${cy} = ${v}`);
        }
        const mo = await mapView(page, { 'map.type': 'motion', 'map.params.motion.frames': 1, 'map.params.motion.gain': 1 }, 61);
        for (let cy = 0; cy < 30; cy++) for (let cx = 0; cx < 40; cx++) {
          const v = mo[(cy * 8 + 4) * W + cx * 8 + 4];
          const want = bit(61, cx, cy) !== bit(60, cx, cy) ? 255 : 0;
          assert(Math.abs(v - want) < 16, `motion: block ${cx},${cy} = ${v}, want ${want}`);
        }
        // The effect uses the map: Time Map with the self map (blend off). Black pixels of frame t
        // have delay 0 (they show frame t: black); white pixels show frame t − 30.
        const fx = await page.evaluate(async () => {
          const N = window.neofx;
          N.change('map.type', 'self');
          N.change('timemap.blend', false);
          N.change('view', 'result');
          await N.applySettings();
          await N.player.seek(70);
          const r = await N.gpu.call({ cmd: 'read' });
          return Array.from(r.pixels.filter((_, i) => i % 4 === 0));
        });
        for (let cy = 0; cy < 30; cy++) for (let cx = 0; cx < 40; cx++) {
          const v = fx[(H - 1 - (cy * 8 + 4)) * W + cx * 8 + 4];
          const want = bit(70, cx, cy) ? 255 * bit(40, cx, cy) : 0;
          assert(Math.abs(v - want) < 16, `time map with the self map: block ${cx},${cy} = ${v}, want ${want}`);
        }
      });
    },
  },
  {
    name: 'adjustments (§7.5): levels, gamma, contrast, curve, posterize, invert, tile, mirror tile, offset; blur',
    timeout: 180000,
    async fn() {
      await withApp(async (page) => {
        const cases = [
          { invert: true }, { black: 0.2, white: 0.7 }, { gamma: 2.2 }, { gamma: 0.5 }, { contrast: 0.5 }, { contrast: -0.6 },
          { curve: 'sCurve' }, { curve: 'easeIn' }, { posterize: 5 }, { tileX: 3, tileY: 2 }, { tileX: 3, mirrorTile: true }, { offsetX: 0.25, offsetY: -0.1 },
          { black: 0.1, gamma: 1.5, contrast: 0.3, curve: 'easeOut', posterize: 8, invert: true }, // the order of all
        ];
        for (const c of cases) {
          const m = base();
          m.params.linear.angle = 20;
          Object.assign(m.adjust, c);
          const got = await mapView(page, mapValues(m));
          compare(`adjust ${JSON.stringify(c)}`, got, (x, y) => mapRef(m, 40, x, y, W, H), 2.5, c.posterize || c.tileX ? 0.03 : 0.002);
        }
        // Blur: a hard checker gets soft edges, the cell centres keep their values.
        const m = base();
        m.type = 'checker';
        const hard = await mapView(page, mapValues(m));
        const soft = await mapView(page, { 'map.adjust.blur': 6 });
        const mid = (a) => a.filter((v) => v > 20 && v < 235).length;
        assert(mid(hard) < 0.01 * W * H && mid(soft) > 0.2 * W * H, `blur: ${mid(hard)} -> ${mid(soft)} grey pixels`);
        const c = 15 * W + 15; // the centre of the first cell (30 px cells)
        assert(Math.abs(soft[c] - hard[c]) < 6, `blur keeps the cell centre: ${hard[c]} -> ${soft[c]}`);
      });
    },
  },
  {
    name: 'animation (§7.6): phase speed, rotation speed, pulse, seed change every k frames',
    timeout: 180000,
    async fn() {
      await withApp(async (page) => {
        const anims = [
          ['linear', { phaseSpeed: 0.013 }], ['stripes', { phaseSpeed: -0.05 }], ['linear', { rotSpeed: 2.5 }],
          ['radial', { pulseAmount: 0.4, pulsePeriod: 30 }], ['spiral', { rotSpeed: -1, phaseSpeed: 0.02 }],
        ];
        for (const [id, an] of anims) {
          const m = base();
          m.type = id;
          Object.assign(m.anim, an);
          for (const t of [10, 37, 64]) {
            const got = await mapView(page, mapValues(m), t);
            compare(`${id} ${JSON.stringify(an)} t ${t}`, got, (x, y) => mapRef(m, t, x, y, W, H));
          }
        }
        // Seed every 5 frames: frames 10..14 have one map, frame 15 a new one.
        const m = base();
        m.type = 'blocks';
        m.anim.seedEvery = 5;
        const a = await mapView(page, mapValues(m), 10);
        const b = await mapView(page, {}, 14);
        const c = await mapView(page, {}, 15);
        assert(a.every((v, i) => v === b[i]) && !a.every((v, i) => v === c[i]), 'seed every 5 frames');
      });
    },
  },
  {
    name: 'image map: Fill, Fit, Stretch, and the transform (position, scale, rotation, flip) are correct',
    timeout: 180000,
    async fn() {
      await withApp(async (page) => {
        const iw = 64, ih = 128;
        const imgs = {
          hramp: (x) => Math.round((255 * x) / (iw - 1)),
          vramp: (x, y) => Math.round((255 * y) / (ih - 1)),
          quad: (x, y) => (x < iw / 2 ? 40 : 200) + (y < ih / 2 ? 0 : 50),
        };
        for (const [name, gray] of Object.entries(imgs)) {
          const file = path.join(OUT_DIR, `map_${name}.png`);
          fs.writeFileSync(file, grayPng(iw, ih, gray));
          await page.evaluate(() => {
            document.getElementById('mapFileInput').dataset.kind = 'image';
          });
          await page.setInputFiles('#mapFileInput', file);
          await page.waitForFunction((n) => window.neofx.settings.map.source === 'image' && window.neofx.settings.map.image.name === n, `map_${name}.png`);
          const img = { w: iw, h: ih, get: (x, y) => gray(x, y) / 255 };
          const transforms = [
            {}, { x: 0.2, y: -0.1 }, { scale: 0.5 }, { scale: 2.5 }, { rotation: 30 }, { rotation: -90 }, { flipX: true }, { flipY: true },
            { rotation: 15, scale: 0.7, flipX: true, x: -0.15 },
          ];
          for (const fit of ['fill', 'fit', 'stretch']) {
            for (const tr of name === 'quad' ? transforms : [{}]) {
              const im = { ...base().image, fit, outside: 0.25, ...tr };
              const values = Object.fromEntries(Object.entries(im).filter(([k]) => k !== 'name').map(([k, v]) => [`map.image.${k}`, v]));
              const got = await mapView(page, values);
              compare(`image ${name} ${fit} ${JSON.stringify(tr)}`, got, (x, y) => customRef(img, im, x, y, W, H), 3, 0.01);
            }
          }
        }
        // The UI: Source Image shows the file name and the fit control.
        const ui = await page.evaluate(() => ({ name: document.querySelector('.fileName').textContent, fit: !!document.querySelector('[data-key="map.image.fit"]') }));
        assert(ui.name === 'map_quad.png' && ui.fit, `UI ${JSON.stringify(ui)}`);
      });
    },
  },
  {
    name: 'video map: frame-locked with speed, offset, and Loop / Hold last / Ping-pong',
    timeout: 180000,
    async fn() {
      await withApp(async (page) => {
        // 10 frames, each one flat grey: 5 + 25 × n.
        const file = ffmpeg('map_video.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=64x48:r=30', '-vf', "geq=lum='5+25*N':cb=128:cr=128", '-frames:v', '10', '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p']);
        await page.evaluate(() => {
          document.getElementById('mapFileInput').dataset.kind = 'video';
        });
        await page.setInputFiles('#mapFileInput', file);
        await page.waitForFunction(() => window.neofx.settings.map.source === 'video', null, { timeout: 30000 });
        // The flat grey of the map video (limited range in the file) -> the map frame number.
        const frameOf = (v) => {
          // Full range grey of frame n: (5 + 25 n - 16) / 219 × 255.
          let best = 0, err = 1e9;
          for (let n = 0; n < 10; n++) {
            const e = Math.abs(v - ((5 + 25 * n - 16) * 255) / 219);
            if (e < err) [best, err] = [n, e];
          }
          return best;
        };
        for (const [end, speed, offset] of [['loop', 1, 0], ['hold', 1, 0], ['pingpong', 1, 0], ['loop', 0.5, 3], ['pingpong', 2, -4]]) {
          const got = [];
          for (const t of [1, 4, 9, 10, 13, 18, 23, 40]) {
            const px = await mapView(page, { 'map.video.end': end, 'map.video.speed': speed, 'map.video.offset': offset, 'map.image.fit': 'stretch' }, t);
            got.push(frameOf(px[120 * W + 160]));
          }
          const want = [1, 4, 9, 10, 13, 18, 23, 40].map((t) => videoMapFrame(t, 10, speed, offset, end));
          assert(got.join() === want.join(), `${end} ×${speed} +${offset}: map frames ${got}, want ${want}`);
        }
        const name = await page.textContent('.fileName');
        assert(name === 'map_video.mp4 · 10 frames', `file name ${name}`);
      });
    },
  },
  {
    name: 'map thumbnails: a grid of all maps (subject maps disabled), drawn from the GPU; a click selects the map',
    timeout: 120000,
    async fn() {
      await withApp(async (page) => {
        // At frame 40 (Motion needs frame 39).
        await page.evaluate(async () => {
          window.neofx.change('map.source', 'builtin');
          await window.neofx.player.seek(40);
          window.neofx.updateThumbs();
        });
        await page.waitForTimeout(600);
        const r = await page.evaluate(() => {
          const tiles = [...document.querySelectorAll('.mapTile')];
          const lin = document.querySelector('.mapTile[data-map="linear"] canvas').getContext('2d').getImageData(0, 0, 72, 40).data;
          return { n: tiles.length, disabled: tiles.filter((t) => t.disabled).map((t) => t.dataset.map), drawn: tiles.filter((t) => !t.disabled && t.querySelector('canvas').getContext('2d').getImageData(0, 0, 72, 40).data.some((v, i) => i % 4 === 0 && v > 0)).length, lin: [lin[0], lin[(39 * 72) * 4]] };
        });
        assert(r.n === 22 && r.disabled.join() === 'subject,subjectdist', `tiles ${r.n}, disabled ${r.disabled}`);
        assert(r.drawn === 20, `${r.drawn} thumbnails drawn`);
        assert(r.lin[0] < 10 && r.lin[1] > 245, `linear thumbnail: top ${r.lin[0]}, bottom ${r.lin[1]}`);
        await page.click('.mapTile[data-map="spiral"]');
        await page.waitForFunction(() => window.neofx.settings.map.type === 'spiral' && document.querySelector('.mapTile.on').dataset.map === 'spiral');
        const params = await page.evaluate(() => [...document.querySelectorAll('#inspector [data-key^="map.params."]')].map((e) => e.dataset.key));
        assert(params.join() === 'map.params.spiral.x,map.params.spiral.y,map.params.spiral.arms,map.params.spiral.tightness', `spiral params ${params}`);
      });
    },
  },
];
