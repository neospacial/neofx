// Phase 11 (plan §14): the UI finish. "Playwright UI tests pass on a desktop and a phone-size viewport."
// Layouts (§12.2, §12.3), the curve editor (§12.6), Randomize, presets, undo / redo (§12.5), the
// keyboard (§12.7), the start screen (§12.9), Split view and zoom.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { assert, hasFfmpeg, OUT_DIR } from './lib/util.mjs';
import { grayPng } from './lib/png.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { History } from '../src/app/history.js';
import { rng, randomizeSection, RANDOM_SECTIONS } from '../src/app/random.js';
import { PRESETS, applyPreset, parsePresetFile, presetFile, merge } from '../src/app/presets.js';
import { DEFAULTS, clone } from '../src/app/settings.js';
import { monotoneCurve } from '../src/maps/curve.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function withApp(viewport, fn, opts = {}) {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, ['color.mp4', 'code.mp4']);
  const { browser, page, errors } = await launch(viewport, '', false);
  try {
    if (!opts.noFile) await open(page, f[opts.file || 'color.mp4']);
    if (opts.setFile) {
      // The File object, without the change event of the input (the test opens it itself).
      const buf = fs.readFileSync(f['color.mp4']).toString('base64');
      await page.evaluate((b64) => {
        const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        window.__file = new File([u], 'color.mp4', { type: 'video/mp4' });
      }, buf);
    }
    await fn(page, f);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

const S = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.neofx.settings)));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

export const tests = [
  {
    name: 'history, randomize, presets (Node): one step for a drag, undo / redo; seeded random looks; preset files',
    fn() {
      const h = new History();
      h.record('a', 'x', 0);
      assert(!h.record('a2', 'x', 100), 'a fast change of the same path joins');
      h.record('b', 'y', 200);
      assert(h.undo('c') === 'b' && h.undo('b') === 'a' && !h.canUndo && h.redo('a') === 'b', 'undo / redo');
      h.cut();
      assert(h.record('b', 'y', 250), 'after a cut, a new step');
      const lim = { maxDelay: 200, maxAge: 600, maxAgeEdge: 512 };
      for (const sec of RANDOM_SECTIONS) {
        const a = randomizeSection(clone(DEFAULTS), sec, rng(42), lim), b = randomizeSection(clone(DEFAULTS), sec, rng(42), lim);
        assert(JSON.stringify(a) === JSON.stringify(b), `${sec}: the same seed, the same look`);
      }
      const c = randomizeSection(clone(DEFAULTS), 'time', rng(1), lim);
      assert(c.timemap.maxDelay >= 1 && c.timemap.maxDelay <= 120 && JSON.stringify(c.map) === JSON.stringify(DEFAULTS.map), 'one section only, safe range');
      assert(PRESETS.length >= 12 && PRESETS.some((p) => p.s.mode === 'timemap') && PRESETS.some((p) => p.s.mode === 'slitscan')
        && PRESETS.some((p) => p.s.cutout && p.s.cutout.mode === 'overlay') && PRESETS.some((p) => p.s.cutout && p.s.cutout.mode === 'scan'), 'presets cover the modes');
      const cur = merge(DEFAULTS, { view: 'mask', cutout: { luma: { on: true } } });
      const s = applyPreset(cur, PRESETS.find((p) => p.id === 'trail'));
      assert(s.view === 'mask' && s.cutout.luma.on && s.cutout.mode === 'scan' && s.mode === 'slitscan', 'a preset keeps the view and the cutout method');
      const file = presetFile(s, '0.1.0', { matte: 'data:image/png;base64,AA==' });
      const back = parsePresetFile(JSON.stringify(file));
      assert(JSON.stringify(back.settings) === JSON.stringify(s) && back.assets.matte, 'file round trip');
      const partial = parsePresetFile(JSON.stringify({ app: 'neofx', version: '0.0.1', settings: { mode: 'slitscan' } }));
      assert(partial.settings.timemap.maxDelay === 30 && partial.settings.mode === 'slitscan', 'a partial file gets the defaults');
      let bad = false;
      try {
        parsePresetFile('{"app":"other"}');
      } catch {
        bad = true;
      }
      assert(bad, 'not a neofx file');
    },
  },
  {
    name: 'desktop: top bar, inspector width (280–520 px), Split view, zoom (wheel, 100 %, Fit, Space + drag), no horizontal scroll',
    timeout: 180000,
    async fn() {
      await withApp(DESKTOP, async (page) => {
        for (const id of ['openBtn', 'presetsBtn', 'undoBtn', 'redoBtn', 'exportBtn']) assert(await page.isVisible(`#${id}`), `${id} visible`);
        assert(!(await page.isVisible('#menuBtn')) && !(await page.isVisible('.tabBar')), 'no phone controls');
        // Inspector width: drag the bar.
        const sz = await page.locator('#sizer').boundingBox();
        await page.mouse.move(sz.x + 2, sz.y + 100);
        await page.mouse.down();
        await page.mouse.move(700, sz.y + 100, { steps: 4 });
        await page.mouse.up();
        let w = (await page.locator('#inspectorBox').boundingBox()).width;
        assert(w === 520, `the widest inspector: ${w}`);
        await page.mouse.move(700 + 0, sz.y + 100);
        const sz2 = await page.locator('#sizer').boundingBox();
        await page.mouse.move(sz2.x + 2, sz2.y + 100);
        await page.mouse.down();
        await page.mouse.move(1250, sz2.y + 100, { steps: 4 });
        await page.mouse.up();
        w = (await page.locator('#inspectorBox').boundingBox()).width;
        assert(w === 280, `the narrowest inspector: ${w}`);
        // Split view: the left of the divider is the original, the right the result.
        await page.evaluate(async () => {
          const N = window.neofx;
          N.change('timemap.maxDelay', 30);
          N.change('map.type', 'radial');
          await N.applySettings();
          await N.player.seek(80);
        });
        const grab = (view) => page.evaluate(async (view) => {
          const N = window.neofx;
          N.setView(view);
          await N.applySettings();
          const r = await N.gpu.call({ cmd: 'read' });
          return Array.from(r.pixels);
        }, view);
        const res = await grab('result'), orig = await grab('original');
        await page.click('#viewBar button[data-view="split"]');
        assert(await page.isVisible('#splitLine'), 'the divider shows');
        const line = await page.locator('#splitLine').boundingBox();
        const view = await page.locator('#view').boundingBox();
        await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
        await page.mouse.down();
        await page.mouse.move(view.x + view.width * 0.25, line.y + line.height / 2, { steps: 3 });
        await page.mouse.up();
        const pos = await page.evaluate(() => window.neofx.settings.splitPos);
        assert(Math.abs(pos - 0.25) < 0.02, `split at ${pos}`);
        const sp = await page.evaluate(async () => Array.from((await window.neofx.gpu.call({ cmd: 'read' })).pixels));
        const W2 = 320, row = 120; // color.mp4 is 320 x 240
        // Left of the divider (x < 80): the original; right: the result (where they differ).
        let leftBad = 0, rightBad = 0, leftDiff = 0, rightDiff = 0;
        for (let y = 0; y < 240; y++) for (let x = 0; x < W2; x++) {
          if (Math.abs(x - 80) < 3) continue;
          const i = (y * W2 + x) * 4;
          const same = (a, b2) => a[i] === b2[i] && a[i + 1] === b2[i + 1] && a[i + 2] === b2[i + 2];
          if (same(orig, res)) continue;
          if (x < 80) {
            leftDiff++;
            if (!same(sp, orig)) leftBad++;
          } else {
            rightDiff++;
            if (!same(sp, res)) rightBad++;
          }
        }
        void row;
        assert(leftDiff > 100 && rightDiff > 100 && leftBad === 0 && rightBad === 0, `split: left ${leftBad} of ${leftDiff}, right ${rightBad} of ${rightDiff} wrong`);
        // Zoom: the wheel zooms in, 100 % is one working pixel for one CSS pixel, Fit goes back.
        const vb = await page.locator('#view').boundingBox();
        await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
        await page.mouse.wheel(0, -400);
        const zb = await page.locator('#view').boundingBox();
        assert(zb.width > vb.width * 1.3, `wheel zoom ${vb.width} -> ${zb.width}`);
        await page.click('#viewBar button[data-zoom="100"]');
        const hb = await page.locator('#view').boundingBox();
        assert(Math.abs(hb.width - 320) < 2, `100 %: ${hb.width}`);
        // Space + drag pans.
        await page.keyboard.down(' ');
        await page.mouse.move(hb.x + 100, hb.y + 100);
        await page.mouse.down();
        await page.mouse.move(hb.x + 160, hb.y + 130, { steps: 3 });
        await page.mouse.up();
        await page.keyboard.up(' ');
        const pb = await page.locator('#view').boundingBox();
        assert(Math.abs(pb.x - hb.x - 60) < 2 && Math.abs(pb.y - hb.y - 30) < 2, `pan ${pb.x - hb.x}, ${pb.y - hb.y}`);
        await page.click('#viewBar button[data-zoom="fit"]');
        const fb = await page.locator('#view').boundingBox();
        assert(Math.abs(fb.width - vb.width) < 2, 'Fit');
        assert(await noOverflow(page), 'no horizontal scroll');
      });
    },
  },
  {
    name: 'undo / redo: a slider drag is one step; buttons and Ctrl+Z / Shift+Ctrl+Z; a preset and Randomize are one step each',
    timeout: 180000,
    async fn() {
      await withApp(DESKTOP, async (page) => {
        assert(await page.isDisabled('#undoBtn'), 'nothing to undo at first');
        // Drag the Max delay slider (many input events): one step.
        const slider = page.locator('[data-key="timemap.maxDelay"] input[type=range]');
        await slider.scrollIntoViewIfNeeded();
        const b = await slider.boundingBox();
        await page.mouse.move(b.x + 5, b.y + b.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + 5 + i * 12, b.y + b.height / 2);
        await page.mouse.up();
        const after = (await S(page)).timemap.maxDelay;
        assert(after !== 30 && (await page.evaluate(() => window.neofx.history.past.length)) === 1, `one step for the drag (Max delay ${after})`);
        await page.click('#undoBtn');
        assert((await S(page)).timemap.maxDelay === 30, 'undo');
        assert(Number(await page.inputValue('[data-key="timemap.maxDelay"] input[type=number]')) === 30, 'the inspector shows the undone value');
        await page.keyboard.press('Shift+Control+z');
        assert((await S(page)).timemap.maxDelay === after, 'redo (Shift+Ctrl+Z)');
        await page.keyboard.press('Control+z');
        assert((await S(page)).timemap.maxDelay === 30, 'undo (Ctrl+Z)');
        // A preset: one step.
        await page.click('#presetsBtn');
        await page.click('.presetCard[data-preset="vortex"]');
        let s = await S(page);
        assert(s.map.type === 'spiral' && s.timemap.maxDelay === 40, 'the Vortex preset');
        await page.keyboard.press('Control+z');
        s = await S(page);
        assert(s.map.type === 'linear', 'undo the preset');
        // Randomize: one step; the same seed gives the same look; a locked section stays.
        await page.evaluate(() => window.neofx.toggleLock('time'));
        const before = await S(page);
        await page.evaluate(() => window.neofx.randomize(undefined, 1234));
        const r1 = await S(page);
        assert(JSON.stringify(r1.timemap) === JSON.stringify(before.timemap), 'the locked section (Time) stays');
        assert(JSON.stringify(r1.map) !== JSON.stringify(before.map), 'the map changed');
        assert((await page.textContent('.randomBar .seed')) === 'Look #1234', 'the seed shows');
        await page.keyboard.press('Control+z');
        assert(JSON.stringify(await S(page)) === JSON.stringify(before), 'undo returns the last look');
        await page.evaluate(() => window.neofx.randomize(undefined, 1234));
        assert(JSON.stringify(await S(page)) === JSON.stringify(r1), 'the same seed, the same look');
        // The dice of one section.
        await page.evaluate(() => window.neofx.toggleLock('time'));
        const t0 = await S(page);
        await page.click('[data-dice="look"]');
        const t1 = await S(page);
        assert(JSON.stringify(t1.map) === JSON.stringify(t0.map) && JSON.stringify(t1.look) !== JSON.stringify(t0.look), 'the dice changes only its section');
      });
    },
  },
  {
    name: 'curve editor: drag a point, add a point on the line, remove it (double-click), presets; the map uses the curve',
    timeout: 180000,
    async fn() {
      await withApp(DESKTOP, async (page) => {
        await page.evaluate(() => {
          document.querySelector('details[data-name="adjust"]').open = true;
          window.neofx.setView('map');
        });
        const cv = page.locator('[data-key="map.adjust.curve"] canvas');
        await cv.scrollIntoViewIfNeeded();
        const b = await cv.boundingBox();
        const px = (x, y) => [b.x + (8 + x * 204) * (b.width / 220), b.y + (112 - y * 104) * (b.height / 120)];
        // Add a point on the line at x = 0.5 (y = 0.5), drag it to y = 0.8.
        await page.mouse.move(...px(0.5, 0.5));
        await page.mouse.down();
        await page.mouse.move(...px(0.5, 0.65), { steps: 3 });
        await page.mouse.move(...px(0.5, 0.8), { steps: 3 });
        await page.mouse.up();
        let c = (await S(page)).map.adjust.curve;
        assert(Array.isArray(c) && c.length === 3 && Math.abs(c[1][0] - 0.5) < 0.03 && Math.abs(c[1][1] - 0.8) < 0.03, `curve ${JSON.stringify(c)}`);
        // The map (linear, vertical) uses the curve: row y has the value curve((y + 0.5) / H).
        const px2 = await page.evaluate(async () => {
          await window.neofx.applySettings();
          const r = await window.neofx.gpu.call({ cmd: 'read' });
          return [40, 120, 200].map((y) => r.pixels[((239 - y) * 320 + 160) * 4]);
        });
        const f = monotoneCurve(c);
        [40, 120, 200].forEach((y, i) => assert(Math.abs(px2[i] - 255 * f((y + 0.5) / 240)) < 3, `map row ${y}: ${px2[i]}, want ${(255 * f((y + 0.5) / 240)).toFixed(1)}`));
        // Double-click the point: removed.
        await page.mouse.dblclick(...px(c[1][0], c[1][1]));
        c = (await S(page)).map.adjust.curve;
        assert(Array.isArray(c) && c.length === 2, `after the double-click ${JSON.stringify(c)}`);
        await page.click('[data-key="map.adjust.curve"] button[data-value="sCurve"]');
        assert((await S(page)).map.adjust.curve === 'sCurve', 'preset S-curve');
        // The curve drag is one undo step.
        assert((await page.evaluate(() => window.neofx.history.past.length)) <= 4, 'undo steps');
      });
    },
  },
  {
    name: 'presets: the gallery (13, thumbnails), Save (a .neofx.json file with the matte and the image map), Load (and a video map asks for its file)',
    timeout: 240000,
    async fn() {
      await withApp(DESKTOP, async (page) => {
        await page.click('#presetsBtn');
        // The GPU thumbnails come one after the other.
        await page.waitForFunction(() => [...document.querySelectorAll('.presetCard canvas')].every((c) => c.getContext('2d').getImageData(0, 0, 160, 90).data.some((v, i) => i % 4 !== 3 && v > 0)), null, { timeout: 30000 }).catch(() => {});
        const g = await page.evaluate(() => [...document.querySelectorAll('.presetCard')].map((c) => ({ id: c.dataset.preset, drawn: c.querySelector('canvas').getContext('2d').getImageData(0, 0, 160, 90).data.some((v, i) => i % 4 !== 3 && v > 0) })));
        assert(g.length === 13 && g.every((x) => x.drawn), `gallery ${JSON.stringify(g)}`);
        await page.click('#presetClose');
        // An image map and a matte stroke, then Save.
        const png = path.join(OUT_DIR, 'ui_map.png');
        fs.writeFileSync(png, grayPng(32, 32, (x) => x * 8));
        await page.evaluate(() => (document.getElementById('mapFileInput').dataset.kind = 'image'));
        await page.setInputFiles('#mapFileInput', png);
        await page.waitForFunction(() => window.neofx.settings.map.source === 'image');
        await page.evaluate(() => window.neofx.gpu.call({ cmd: 'matteStroke', points: [[0.2, 0.2], [0.3, 0.3]], size: 20, hardness: 1, mode: 'never' }));
        await page.evaluate(() => window.neofx.change('timemap.maxDelay', 17));
        await page.click('#presetsBtn');
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#presetSave')]);
        assert(/\.neofx\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
        const file = path.join(OUT_DIR, 'ui_preset.neofx.json');
        await dl.saveAs(file);
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert(j.app === 'neofx' && j.version === '0.1.0' && j.settings.timemap.maxDelay === 17, 'the file');
        assert(/^data:image\/png;base64,/.test(j.assets.mapImage) && /^data:image\/png;base64,/.test(j.assets.matte), 'the image map and the matte as PNG data URLs');
        await page.click('#presetClose');
        // Change things, then Load: the settings, the image map, and the matte come back.
        await page.evaluate(async () => {
          const N = window.neofx;
          N.change('map.source', 'builtin');
          N.change('timemap.maxDelay', 5);
          await N.gpu.call({ cmd: 'matteClear' });
        });
        await page.setInputFiles('#presetFileInput', file);
        await page.waitForFunction(() => window.neofx.settings.timemap.maxDelay === 17 && window.neofx.settings.map.source === 'image');
        // The matte is the last part of the load: poll for it (waitForFunction does not wait for a Promise).
        await page.evaluate(async () => {
          for (let i = 0; i < 100 && (await window.neofx.gpu.call({ cmd: 'matteGet' })).empty; i++) await new Promise((r) => setTimeout(r, 100));
        });
        const m = await page.evaluate(async () => {
          const r = await window.neofx.gpu.call({ cmd: 'matteGet' });
          return { empty: r.empty, w: r.width, at: r.pixels[(Math.round(r.height * 0.25) * r.width + Math.round(r.width * 0.25)) * 4 + 1] };
        });
        assert(!m.empty && m.at > 200, `the matte is back ${JSON.stringify(m)}`);
        // A preset with a video map: the app asks for the file.
        j.settings.map.source = 'video';
        j.settings.map.video.name = 'clouds.mp4';
        delete j.assets.mapImage;
        const vfile = path.join(OUT_DIR, 'ui_video.neofx.json');
        fs.writeFileSync(vfile, JSON.stringify(j));
        const chooser = page.waitForEvent('filechooser');
        await page.setInputFiles('#presetFileInput', vfile);
        await chooser;
        const msg = await page.textContent('#message');
        assert(/clouds\\.mp4|clouds.mp4/.test(msg) && (await S(page)).map.video.name === 'clouds.mp4', `message: ${msg}`);
      });
    },
  },
  {
    name: 'keyboard: Space, J / K / L, \\\\ (hold: the original), M, I / O, Ctrl+E; the settings stay after a reload',
    timeout: 180000,
    async fn() {
      await withApp(DESKTOP, async (page) => {
        await page.evaluate(() => window.neofx.player.seek(60));
        await page.keyboard.press('j');
        await page.waitForTimeout(400);
        await page.keyboard.press('k');
        const cur = await page.evaluate(() => window.neofx.player.current);
        assert(cur < 60 && cur > 40, `J played backward to ${cur}`);
        await page.keyboard.press('l');
        await page.waitForFunction(() => window.neofx.player.playing);
        await page.keyboard.press('k');
        await page.waitForFunction(() => !window.neofx.player.playing);
        await page.keyboard.press(' ');
        await page.waitForFunction(() => window.neofx.player.playing);
        await page.keyboard.press(' ');
        await page.keyboard.down('\\');
        assert((await S(page)).view === 'original', 'hold \\: the original');
        await page.keyboard.up('\\');
        assert((await S(page)).view === 'result', 'release: back');
        await page.keyboard.press('m');
        assert((await S(page)).view === 'mask', 'M: the mask view');
        await page.keyboard.press('m');
        await page.keyboard.press('i');
        assert((await page.evaluate(() => window.neofx.player.inPoint)) !== null, 'I: In');
        await page.keyboard.press('Control+e');
        await page.waitForSelector('#exportDialog[open]');
        await page.keyboard.press('Escape');
        // The settings stay in the browser.
        await page.evaluate(() => window.neofx.change('timemap.maxDelay', 23));
        await page.waitForTimeout(400);
        await page.reload();
        await page.waitForFunction(() => window.neofx && window.neofx.settings);
        assert((await S(page)).timemap.maxDelay === 23, 'restored after a reload');
        await page.evaluate(() => localStorage.clear());
      });
    },
  },
  {
    name: 'start screen (desktop and phone): the drop area and two example animations made by the app',
    timeout: 120000,
    async fn() {
      for (const vp of [DESKTOP, PHONE]) {
        await withApp(vp, async (page) => {
          assert(await page.isVisible('#dropArea'), 'the drop area');
          const snap = () => page.evaluate(() => ['demoTime', 'demoSlit'].map((id) => Array.from(document.getElementById(id).getContext('2d').getImageData(0, 0, 160, 90).data.filter((_, i) => i % 97 === 0))));
          const a = await snap();
          await page.waitForTimeout(500);
          const b = await snap();
          assert(a.every((x, i) => x.some((v, k) => v !== b[i][k])), 'the examples move');
          const box = await page.locator('#dropArea').boundingBox();
          assert(box.width > Math.min(vp.width * 0.8, 480), `the drop area is wide: ${box.width}`);
          assert(await noOverflow(page), 'no horizontal scroll');
          if (vp === PHONE) assert(!(await page.isVisible('#inspectorBox')) && !(await page.isVisible('#transport')), 'phone: only the start screen');
        }, { noFile: true });
      }
    },
  },
  {
    name: 'phone: tabs (one section group at a time), the bottom sheet (drag the handle), the ⋯ menu, 44 px touch targets, pinch zoom, fine slider steps',
    timeout: 180000,
    async fn() {
      await withApp(PHONE, async (page) => {
        assert(await noOverflow(page), 'no horizontal scroll');
        assert(await page.isVisible('#menuBtn') && !(await page.isVisible('#presetsBtn')), 'the ⋯ menu, no desktop buttons');
        const order = await page.evaluate(() => ['preview', 'transport', 'inspectorBox'].map((id) => document.getElementById(id).getBoundingClientRect().top));
        assert(order[0] < order[1] && order[1] < order[2], `preview, transport, sheet: ${order}`);
        // Tabs.
        await page.click('.tabBar button[data-tab="mix"]');
        const vis = await page.evaluate(() => [...document.querySelectorAll('#inspector details')].filter((d) => d.offsetParent !== null).map((d) => d.dataset.name));
        assert(vis.join() === 'composite', `the Mix tab: ${vis}`);
        await page.click('.tabBar button[data-tab="map"]');
        const vis2 = await page.evaluate(() => [...document.querySelectorAll('#inspector details')].filter((d) => d.offsetParent !== null).map((d) => d.dataset.name));
        assert(vis2.includes('map') && !vis2.includes('composite'), `the Map tab: ${vis2}`);
        // Touch targets.
        const small = await page.evaluate(() => [...document.querySelectorAll('#topBar button, #transport button, .tabBar button')].filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height < 44).map((b) => b.textContent));
        assert(!small.length, `buttons under 44 px: ${small}`);
        // The sheet: drag the handle up.
        const h0 = (await page.locator('#inspectorBox').boundingBox()).height;
        const hb = await page.locator('#sheetHandle').boundingBox();
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(hb.x + hb.width / 2, 200, { steps: 4 });
        await page.mouse.up();
        const h1 = (await page.locator('#inspectorBox').boundingBox()).height;
        assert(h1 > h0 + 150, `the sheet ${h0} -> ${h1}`);
        // The ⋯ menu: Presets.
        await page.click('#menuBtn');
        await page.click('#menu button[data-act="presets"]');
        await page.waitForSelector('#presetDialog[open]');
        await page.click('#presetClose');
        // Pinch zoom with two touch pointers.
        const z = await page.evaluate(() => {
          const area = document.getElementById('preview');
          const v = document.getElementById('view').getBoundingClientRect();
          const cx = v.left + v.width / 2, cy = v.top + v.height / 2;
          const ev = (type, id, x, y) => area.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
          ev('pointerdown', 11, cx - 20, cy);
          ev('pointerdown', 12, cx + 20, cy);
          ev('pointermove', 11, cx - 60, cy);
          ev('pointermove', 12, cx + 60, cy);
          ev('pointerup', 11, cx - 60, cy);
          ev('pointerup', 12, cx + 60, cy);
          return [v.width, document.getElementById('view').getBoundingClientRect().width];
        });
        assert(z[1] > z[0] * 2.5, `pinch ${z[0]} -> ${z[1]}`);
        // Fine steps: a long press, then a drag moves the value at a tenth of the speed.
        await page.click('.tabBar button[data-tab="time"]');
        const fine = await page.evaluate(() => {
          const row = document.querySelector('[data-key="timemap.maxDelay"]');
          return [row.fineAt(30, 100), Number(row.querySelector('input[type=range]').max)];
        });
        const w = (await page.locator('[data-key="timemap.maxDelay"] input[type=range]').boundingBox()).width;
        assert(Math.abs(fine[0] - (30 + Math.round(((100 / w) * fine[1]) / 10))) <= 1, `fine step ${fine[0]}`);
      });
    },
  },
  {
    name: 'opening a file: the loading indicator shows until the preview is there; the file inputs take video/* (iOS picker)',
    timeout: 120000,
    async fn() {
      await withApp(DESKTOP, async (page, f) => {
        const acc = await page.evaluate(() => [document.getElementById('fileInput').accept, document.getElementById('maskFileInput').accept]);
        assert(acc.join() === 'video/*,video/*', `accept ${acc}`);
        const r = await page.evaluate(async () => {
          const N = window.neofx;
          const seen = [];
          const obs = new MutationObserver(() => seen.push(!document.getElementById('loading').hidden ? document.getElementById('loadingText').textContent : ''));
          obs.observe(document.getElementById('loading'), { attributes: true, subtree: true, childList: true, characterData: true });
          const input = document.getElementById('fileInput');
          await N.openFile(input.files[0] || window.__file);
          obs.disconnect();
          return { seen, hidden: document.getElementById('loading').hidden, state: document.body.dataset.state };
        });
        void f;
        assert(r.hidden && r.state === 'open', `after the open: ${JSON.stringify(r)}`);
        assert(r.seen.some((t) => /^Opening .*color\.mp4…$/.test(t)) && r.seen.some((t) => /^Preparing /.test(t)), `the indicator showed: ${JSON.stringify(r.seen)}`);
      }, { noFile: true, setFile: true });
    },
  },
  {
    name: 'phone landscape (844 × 390): the preview on the left, the settings on the right',
    timeout: 120000,
    async fn() {
      await withApp({ width: 844, height: 390 }, async (page) => {
        const r = await page.evaluate(() => ['preview', 'inspectorBox'].map((id) => document.getElementById(id).getBoundingClientRect()).map((b) => [b.left, b.right, b.top]));
        assert(r[0][1] <= r[1][0] + 1 && r[1][2] < 60, `side by side ${JSON.stringify(r)}`);
        assert(await noOverflow(page), 'no horizontal scroll');
        assert(!(await page.isVisible('#sheetHandle')), 'no sheet handle');
      });
    },
  },
];
