// Mode 3, Datamosh (from neomosh, file source): record clips from the open video, a cut without a
// keyframe (the mosh), bloom, revert, the history look, and the export (Original: Mosh / Clean cuts;
// Upscale). FFmpeg decodes the exported files: a conforming decoder shows the moshed pictures.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { assert, hasFfmpeg, OUT_DIR, probe, run } from './lib/util.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { moshSize, MOSH_DEFAULTS } from '../src/app/mosh.js';
import { DEFAULTS } from '../src/app/settings.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

// Export in the page; the file goes to tests/out/<name>.
async function doExport(page, opts, name) {
  const r = await page.evaluate(async (opts) => {
    try {
      const r = await window.neofx.mosh.export(opts);
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
      return { b64: btoa(s), frames: r.frames, width: r.width, height: r.height, size: r.size };
    } catch (e) {
      return { error: e.message };
    }
  }, opts);
  if (r.error) return r;
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(r.b64, 'base64'));
  return { ...r, b64: undefined, file };
}

// The luma of each frame of a file (FFmpeg), as arrays of w × h bytes.
function grayFrames(file, w, h) {
  const out = run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']).stdout;
  const frames = [];
  for (let o = 0; o + w * h <= out.length; o += w * h) frames.push(out.subarray(o, o + w * h));
  return frames;
}

const diff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += Math.abs(a[i] - b[i]);
  return n / a.length;
};

const M = (page) => page.evaluate(() => {
  const m = window.neofx.mosh;
  return { state: m.state, session: m.session, look: m.lookUs };
});
const idle = (page) => page.waitForFunction(() => window.neofx.mosh.state === 'idle', null, { timeout: 60000 });

export const tests = [
  {
    name: 'datamosh (Node): the session size keeps the shape of the source, even numbers, never above the source; the defaults are the neomosh look',
    fn() {
      assert(JSON.stringify(moshSize(1920, 1080, 480)) === JSON.stringify({ w: 854, h: 480 }), JSON.stringify(moshSize(1920, 1080, 480)));
      assert(JSON.stringify(moshSize(1080, 1920, 720)) === JSON.stringify({ w: 720, h: 1280 }), 'vertical');
      assert(JSON.stringify(moshSize(320, 240, 480)) === JSON.stringify({ w: 320, h: 240 }), 'not above the source');
      assert(moshSize(3840, 1600, 1080).w === 1920, 'at most 1920 on the long side');
      assert(DEFAULTS.mosh.qp === 30 && DEFAULTS.mosh.precision === 'quarter' && DEFAULTS.mosh.heal === 'low' && MOSH_DEFAULTS.fps === 30, 'defaults');
    },
  },
  {
    name: 'datamosh: record two clips (a cut without a keyframe), bloom, the history look, revert, and the export: Mosh and Clean cuts (FFmpeg decodes both), Upscale; the record bar and the keys',
    timeout: 300000,
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const f = makeFixtures(FIX_DIR, ['subject.mp4', 'color.mp4']);
      const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
      try {
        await open(page, f['subject.mp4']);
        await page.evaluate(() => window.neofx.change('mode', 'datamosh'));
        assert(await page.isVisible('#moshBar') && !(await page.isVisible('#viewBar button[data-view="mask"]')), 'the record bar shows, the view buttons do not');
        assert(!(await page.evaluate(() => document.getElementById('exportBtn').disabled)), 'Export is on');
        // Clip 1: frames 0 – 29 of the video (fast: no real-time clock).
        const n = await page.evaluate(() => window.neofx.player.frameCount);
        await page.evaluate(async () => {
          const N = window.neofx;
          await N.player.seek(0);
          await N.mosh.record({ fast: true });
        });
        await page.waitForFunction(() => window.neofx.mosh.frames >= 30);
        await page.evaluate(() => window.neofx.mosh.pause());
        let s = (await M(page)).session;
        const clip1 = s.frames;
        assert(s.w === 320 && s.h === 240 && s.fps === 30 && clip1 >= 30 && s.points.length === 1 && s.cuts === 0 && s.canBloom, `clip 1: ${JSON.stringify(s)}`);
        const head = await page.evaluate(() => window.neofx.player.current);
        assert(head >= 29 && head <= clip1 + 1, `the playhead is after the clip: ${head} (${clip1} frames)`);
        // The last picture shows over the source at the Guide opacity; the size is locked.
        const guide = await page.evaluate(() => ({ hidden: document.getElementById('moshView').hidden, opacity: document.getElementById('moshView').style.opacity, locked: document.querySelector('#inspector [data-key="mosh.size"] select').disabled }));
        assert(!guide.hidden && guide.opacity === '0.5' && guide.locked, `guide ${JSON.stringify(guide)}`);
        // Clip 2 from another video: a cut. The file runs to its end: the recording pauses itself.
        await open(page, f['color.mp4']);
        assert((await M(page)).session.frames === clip1, 'the session stays when another video opens');
        await page.evaluate(async () => {
          const N = window.neofx;
          await N.player.seek(N.player.frameCount - 20);
          await N.mosh.record({ fast: true });
        });
        await page.waitForFunction(() => window.neofx.mosh.state === 'recording' || window.neofx.mosh.session.points.length === 2);
        await idle(page);
        s = (await M(page)).session;
        const clip2 = s.frames - clip1;
        assert(clip2 >= 19 && clip2 <= 21 && s.points.length === 2 && s.cuts === 1, `clip 2: ${clip2} frames, ${JSON.stringify(s.points)}`);
        // Bloom: while held, the last motion repeats (a clip of its own, no cut).
        await page.evaluate(() => window.neofx.mosh.bloom(true));
        await page.waitForFunction((k) => window.neofx.mosh.frames >= k + 4, clip1 + clip2);
        await page.evaluate(() => window.neofx.mosh.bloom(false));
        await idle(page);
        s = (await M(page)).session;
        const bloom = s.frames - clip1 - clip2;
        assert(bloom >= 4 && s.points.length === 3 && s.cuts === 1, `bloom: ${bloom} frames, ${s.points.length} points, ${s.cuts} cuts`);
        // Export, Original: Mosh (the hidden I-frame is not in the file) and Clean (it is).
        const total = s.frames;
        const mosh = await doExport(page, { mode: 'original', cuts: ['mosh'] }, 'mosh_mosh.mp4');
        const clean = await doExport(page, { mode: 'original', cuts: ['clean'] }, 'mosh_clean.mp4');
        assert(!mosh.error && !clean.error, mosh.error || clean.error);
        assert(mosh.frames === total - 1 && clean.frames === total, `frames: mosh ${mosh.frames}, clean ${clean.frames}, session ${total}`);
        for (const r of [mosh, clean]) {
          const v = probe(r.file, 'v:0', 'stream=codec_name,profile,width,height,nb_frames')[0];
          assert(v[0] === 'h264' && /Baseline/.test(v[1]) && Number(v[2]) === 320 && Number(v[3]) === 240 && Number(v[4]) === r.frames, `ffprobe ${v}`);
          assert(!probe(r.file, 'a:0', 'stream=codec_name').length, 'no audio');
        }
        // FFmpeg decodes each frame of both. Before the cut the two are the same; after it, the Clean
        // file shows the new video, and the Mosh file keeps the old picture (moved by the new motion).
        const gm = grayFrames(mosh.file, 320, 240), gc = grayFrames(clean.file, 320, 240);
        assert(gm.length === mosh.frames && gc.length === clean.frames, `decoded ${gm.length} / ${gc.length}`);
        assert(diff(gm[clip1 - 1], gc[clip1 - 1]) === 0, 'the same pictures before the cut');
        const cutClean = diff(gc[clip1], gc[clip1 - 1]), cutMosh = diff(gm[clip1], gm[clip1 - 1]);
        const later = diff(gm[clip1 + 10], gc[clip1 + 11]);
        console.log(`      | change at the cut: Clean ${cutClean.toFixed(1)}, Mosh ${cutMosh.toFixed(1)}; Mosh against Clean 10 frames later ${later.toFixed(1)}`);
        assert(cutClean > 20 && cutMosh < cutClean * 0.5 && later > 5, 'the Mosh cut keeps the old picture');
        // The key frames: only frame 0 (Mosh); also the cut (Clean).
        const keys = (file) => probe(file, 'v:0', 'packet=flags').filter((r) => /K/.test(r[0])).length;
        assert(keys(mosh.file) === 1 && keys(clean.file) === 2, `sync frames: ${keys(mosh.file)}, ${keys(clean.file)}`);
        // Upscale (the H.264 encoder of the browser), when it is there.
        const up = await page.evaluate(() => window.neofx.mosh.canUpscale());
        if (up && up.ok) {
          const u = await doExport(page, { mode: 'upscale', cuts: 'mosh', smooth: false }, 'mosh_up.mp4');
          assert(!u.error, u.error);
          const v = probe(u.file, 'v:0', 'stream=codec_name,width,height,nb_frames')[0];
          assert(v[0] === 'h264' && Number(v[1]) === 1440 && Number(v[2]) === 1080 && Number(v[3]) === total - 1, `upscale ${v}`);
        } else console.log('      (no H.264 encoder for the Upscale export here)');
        // History: the picture at a session time, the inspector cards, Revert.
        await page.evaluate(() => window.neofx.mosh.seek(500000));
        await page.waitForFunction(() => window.neofx.mosh.lookUs !== null && !window.neofx.mosh.seeking);
        const look = await page.evaluate(() => ({ us: window.neofx.mosh.lookUs, opacity: document.getElementById('moshView').style.opacity, cards: document.querySelectorAll('#inspector .moshCard').length }));
        assert(Math.abs(look.us - 500000) < 40000 && look.opacity === '1' && look.cards === 3, `history ${JSON.stringify(look)}`);
        await page.evaluate(() => window.neofx.mosh.revert(0));
        s = (await M(page)).session;
        assert(s.frames === clip1 && s.points.length === 1 && s.cuts === 0, `revert: ${JSON.stringify(s)}`);
        // The record button and the R key (real time): record, then pause.
        await page.click('#moshBar [data-act="rec"]');
        await page.waitForFunction((k) => window.neofx.mosh.state === 'recording' && window.neofx.mosh.frames > k + 3, clip1, { timeout: 30000 });
        assert((await page.evaluate(() => document.body.dataset.mosh)) === 'recording', 'the page shows the recording');
        await page.keyboard.press('r');
        await idle(page);
        s = (await M(page)).session;
        assert(s.frames > clip1 + 3 && s.points.length === 2 && s.cuts === 1, `after the button and R: ${JSON.stringify(s)}`);
        // The export dialog: a row for the cut, Export, Download.
        await page.click('#exportBtn');
        await page.waitForSelector('#moshDialog[open] #moshGo');
        assert((await page.locator('#moshDialog select[data-cut]').count()) === 1, 'one cut row');
        await page.click('#moshGo');
        await page.waitForSelector('#moshDownload', { timeout: 60000 });
        await page.evaluate(() => document.getElementById('moshDialog').close());
        // New video (two touches), then the other modes work as before.
        await page.evaluate(() => window.neofx.mosh.revert(-1));
        s = (await M(page)).session;
        assert(s.frames === 0 && s.points.length === 0 && (await page.evaluate(() => document.getElementById('moshView').hidden)), 'New video: empty');
        await page.evaluate(() => window.neofx.change('mode', 'timemap'));
        assert(!(await page.isVisible('#moshBar')) && (await page.isVisible('#viewBar button[data-view="mask"]')), 'Time Map: no record bar');
        assert(!errors.length, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
];
