// Phase 2 (plan §14): the fixtures play and seek frame-exact in the app (Chromium, Playwright).
// The code on the preview canvas must be the FFmpeg ground truth of the frame index.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, hasFfmpeg, OUT_DIR } from './lib/util.mjs';
import { makeFixtures, readCode } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { PAGES } from '../tools/build.mjs';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const ROT = { 'code_rot90.mp4': 90 };

// The code reader on the page: __read() reads the GPU canvas (the last render). A hook reads each
// frame that is shown, when __hook is on.
export async function installReader(page) {
  await page.evaluate((src) => {
    const readCode = (0, eval)(`(${src})`);
    const N = window.neofx;
    window.__decode = (r) => {
      const info = N.player.info;
      const { width: w, height: h, pixels: d } = r;
      // readPixels gives the bottom row first. Canvas pixel for a display pixel.
      const sx = w / info.width, sy = h / info.height;
      return readCode((x, y) => d[((h - 1 - Math.floor((y + 0.5) * sy)) * w + Math.floor((x + 0.5) * sx)) * 4], info.width, info.height, info.rotation);
    };
    window.__readPixels = () => N.gpu.call({ cmd: 'read' });
    window.__read = async () => window.__decode(await window.__readPixels());
    window.__seen = [];
    window.__tl = () => N.timeline.thumbs;
    const consume = N.player.opts.consume;
    N.player.opts.consume = (i, f, show) => {
      const p = consume(i, f, show);
      if (show && window.__hook) window.__seen.push(N.gpu.call({ cmd: 'read' }).then((r) => [i, window.__decode(r)]));
      return p;
    };
  }, readCode.toString());
}

export async function launch(viewport = { width: 1280, height: 800 }, query = '') {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(pathToFileURL(path.join(root, 'dist', PAGES[0][1])).href + query);
  await page.waitForFunction(() => window.neofx && window.neofx.player);
  await installReader(page);
  return { browser, page, errors };
}

export async function open(page, file) {
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => {
    const P = window.neofx.player;
    return (P.info && P.current === 0 && !P.busy) || !document.getElementById('message').hidden;
  }, null, { timeout: 20000 });
  return page.evaluate(() => (window.neofx.player.info ? { n: window.neofx.player.info.times.length, info: window.neofx.player.info } : { error: document.getElementById('message').textContent }));
}

const seekRead = (page, t) => page.evaluate(async (t) => {
  await window.neofx.player.seek(t);
  return [window.neofx.player.current, await window.__read()];
}, t);

export const tests = [
  {
    name: 'seek frame-exact: every fixture, random order, forward and backward, both ends',
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const f = makeFixtures(FIX_DIR);
      const { browser, page, errors } = await launch();
      try {
        for (const [name, file] of Object.entries(f)) {
          const gt = groundTruth(file, ROT[name] || 0);
          const r = await open(page, file);
          assert(!r.error, `${name}: ${r.error}`);
          assert(r.n === gt.codes.length, `${name}: ${r.n} frames, FFmpeg ${gt.codes.length}`);
          assert(r.info.width === gt.w && r.info.height === gt.h, `${name}: size ${r.info.width}x${r.info.height}`);
          const t0 = gt.times[0];
          assert(r.info.times.every((t, i) => Math.abs(t - (gt.times[i] - t0)) <= 1), `${name}: frame times`);
          const n = r.n;
          const order = [0, n - 1, 1, n - 2, Math.floor(n / 2), 23, 24, 25, 19, 20, 21, 47, 48, 3, 70, 69, 68];
          let s = 7;
          for (let i = 0; i < 12; i++) order.push((s = (s * 37 + 11) % n));
          for (const t of order.filter((x) => x < n)) {
            const [cur, code] = await seekRead(page, t);
            assert(cur === t && code === gt.codes[t], `${name}: seek ${t} shows frame ${cur}, code ${code}, want ${gt.codes[t]}`);
          }
        }
        assert(!errors.length, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
  {
    name: 'step through all frames with next / previous frame (open GOP, VFR)',
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const f = makeFixtures(FIX_DIR);
      const { browser, page, errors } = await launch();
      try {
        for (const name of ['code_opengop.mp4', 'code_vfr.mp4']) {
          const gt = groundTruth(f[name]);
          const { n } = await open(page, f[name]);
          const fwd = await page.evaluate(async (n) => {
            const out = [];
            for (let i = 1; i < n; i++) {
              await window.neofx.player.step(1);
              out.push(await window.__read());
            }
            return out;
          }, n);
          assert(JSON.stringify(fwd) === JSON.stringify(gt.codes.slice(1)), `${name}: forward steps ${fwd.slice(0, 8)}`);
          const back = await page.evaluate(async () => {
            const out = [];
            for (let i = 0; i < 30; i++) {
              await window.neofx.player.step(-1);
              out.push(await window.__read());
            }
            return out;
          });
          assert(JSON.stringify(back) === JSON.stringify(gt.codes.slice(n - 31, n - 1).reverse()), `${name}: backward steps ${back.slice(0, 8)}`);
        }
        // Keyboard: Shift+Right = 10 frames, Home, End.
        await page.keyboard.press('Home');
        await page.waitForFunction(() => window.neofx.player.current === 0 && !window.neofx.player.busy);
        await page.keyboard.press('Shift+ArrowRight');
        await page.waitForFunction(() => window.neofx.player.current === 10 && !window.neofx.player.busy);
        await page.keyboard.press('End');
        await page.waitForFunction(() => window.neofx.player.current === window.neofx.player.frameCount - 1 && !window.neofx.player.busy);
        assert(!errors.length, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
  {
    name: 'scrub: many seeks at once end on the last one; each drawn frame is the right one',
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const f = makeFixtures(FIX_DIR, ['code.mp4']);
      const gt = groundTruth(f['code.mp4']);
      const { browser, page, errors } = await launch();
      try {
        await open(page, f['code.mp4']);
        const r = await page.evaluate(async () => {
          window.__seen = [];
          window.__hook = true;
          const P = window.neofx.player;
          const all = [];
          for (let i = 0; i < 40; i++) all.push(P.seek((i * 53) % 90));
          all.push(P.seek(61));
          await Promise.all(all);
          window.__hook = false;
          return { cur: P.current, code: await window.__read(), seen: await Promise.all(window.__seen) };
        });
        assert(r.cur === 61 && r.code === gt.codes[61], `last seek: frame ${r.cur}, code ${r.code}`);
        assert(r.seen.length < 20, `${r.seen.length} frames drawn for 41 seeks (the seeks must be joined)`);
        for (const [i, c] of r.seen) assert(c === gt.codes[i], `drawn frame ${i} has code ${c}`);
        // Scrub with the pointer on the timeline strip.
        const box = await page.locator('#transport .strip').boundingBox();
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        for (let k = 1; k <= 10; k++) await page.mouse.move(box.x + (box.width * k) / 20, box.y + box.height / 2);
        await page.mouse.up();
        await page.waitForFunction(() => !window.neofx.player.busy && !window.neofx.player.pendingSeek);
        const [cur, code] = await page.evaluate(async () => [window.neofx.player.current, await window.__read()]);
        assert(Math.abs(cur - 45) <= 2 && code === gt.codes[cur], `scrub to the middle: frame ${cur}, code ${code}`);
        assert(!errors.length, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
  {
    name: 'play: frames in order at the file times; each drawn frame is right; loop and In/Out range',
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const f = makeFixtures(FIX_DIR);
      const { browser, page, errors } = await launch();
      try {
        for (const name of ['code.mp4', 'code_opengop.mp4', 'code_vfr.mp4', 'code_rot90.mp4', 'code_elst.mp4']) {
          const gt = groundTruth(f[name], ROT[name] || 0);
          const { n, info } = await open(page, f[name]);
          const r = await page.evaluate(async () => {
            const P = window.neofx.player;
            window.__seen = [];
            window.__hook = true;
            const t0 = performance.now();
            P.play();
            await new Promise((res) => {
              const k = () => (P.playing ? setTimeout(k, 20) : res());
              k();
            });
            window.__hook = false;
            const ms = performance.now() - t0;
            return { ms, seen: await Promise.all(window.__seen), log: P.log, stats: P.stats, cur: P.current };
          });
          assert(r.cur === n - 1, `${name}: stopped at ${r.cur}`);
          assert(r.log.every((t, i) => !i || t > r.log[i - 1]), `${name}: frames out of order`);
          assert(r.log.length >= n * 0.7, `${name}: only ${r.log.length} of ${n} frames shown (${r.stats.dropped} dropped)`);
          for (const [i, c] of r.seen) assert(c === gt.codes[i], `${name}: played frame ${i} has code ${c}, want ${gt.codes[i]}`);
          // Real time: the playback takes about the file duration (from frame 1 to the end).
          const want = (info.times[n - 1] - info.times[1]) / 1000;
          assert(r.ms > want * 0.85 && r.ms < want * 1.6 + 300, `${name}: played in ${r.ms.toFixed(0)} ms, file ${want.toFixed(0)} ms`);
        }
        // The timeline thumbnails (one for each 2 %) came from the second decode worker.
        await page.waitForFunction(() => window.__tl().filter(Boolean).length >= 50, null, { timeout: 10000 });
        // In / Out and Loop: play 30..40 in a loop for a while.
        const r = await page.evaluate(async () => {
          const P = window.neofx.player;
          await P.seek(30);
          document.querySelector('[data-act=in]').click();
          await P.seek(40);
          document.querySelector('[data-act=out]').click();
          document.querySelector('[data-act=loop]').click();
          await P.seek(30);
          P.play();
          await new Promise((res) => setTimeout(res, 1200));
          const log = P.log.slice();
          const playing = P.playing;
          P.pause();
          return { log, playing, range: P.range() };
        });
        assert(r.playing && r.range.join() === '30,40', `loop: playing ${r.playing}, range ${r.range}`);
        assert(r.log.every((t) => t >= 30 && t <= 40), `loop range: ${r.log}`);
        assert(errors.length === 0, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
  {
    name: 'files that are not supported show one clear message',
    async fn() {
      if (!chromium) return console.log('      (skipped: no Playwright)');
      const junk = path.join(OUT_DIR, 'junk.mp4');
      fs.writeFileSync(junk, Buffer.from('this is not a video file at all'));
      const txt = path.join(OUT_DIR, 'notes.txt');
      fs.writeFileSync(txt, 'x');
      const { browser, page } = await launch();
      try {
        const r = await open(page, junk);
        assert(r.error === 'Only MP4 and MOV files are supported.', `junk: ${r.error}`);
        await page.setInputFiles('#fileInput', txt);
        const m = await page.textContent('#message');
        assert(m === 'Only MP4 and MOV files are supported.', `txt: ${m}`);
      } finally {
        await browser.close();
      }
    },
  },
];
