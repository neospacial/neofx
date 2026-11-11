// Phase 10 (plan §14, §13.3): the export. Checks with FFmpeg:
// - ffprobe: H.264, the size, the frame count, the frame times equal the source, audio present with
//   the same duration;
// - the decoded export has the right delays (read with the frame block code, not exact pixels);
// - the audio packets are byte-identical to the source packets in the range.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { assert, hasFfmpeg, run, probe, packets, ffmpegClean, OUT_DIR } from './lib/util.mjs';
import { makeFixtures, readCode, readCodeRow, subjectAt } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { expectRows } from './mode1.test.mjs';
import { h264Level, codecCandidates, bitrateFor, exportSizes, chunkSamples, exportName } from '../src/io/encoder-config.js';
import { frameBytes } from '../src/gpu/store.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

// Export in the page; the file goes to tests/out/<name>. Returns the result info (or { error }).
async function doExport(page, opts, name) {
  const r = await page.evaluate(async (opts) => {
    try {
      const r = await window.neofx.exportVideo({ quality: 'veryhigh', keyint: 2, audio: true, hardware: 'hardware', name: 'x.mp4', ...opts });
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
      return { b64: s, info: { size: r.size, frames: r.frames, codec: r.config.codec, width: r.width, height: r.height, opfs: r.opfs, audio: r.audio, type: r.blob.type, name: r.blob.name } };
    } catch (e) {
      return { error: e.message };
    }
  }, opts);
  if (r.error) return r;
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(r.b64, 'latin1'));
  return { ...r.info, file };
}

// A small HTTP server for dist/ (the OPFS needs a real origin; file:// pages have none).
function serveDist() {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
  const server = http.createServer((req, res) => {
    const f = path.join(root, path.basename(decodeURIComponent(req.url.split('?')[0])));
    if (!fs.existsSync(f)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withApp(fixture, fn, http = false) {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, [fixture]);
  const server = http ? await serveDist() : null;
  const base = server ? `http://127.0.0.1:${server.address().port}/` : undefined;
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false, base);
  try {
    await open(page, f[fixture]);
    await fn(page, f[fixture]);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

const set = (page, values) => page.evaluate(async (v) => {
  for (const [k, x] of Object.entries(v)) window.neofx.change(k, x);
  await window.neofx.applySettings();
}, values);

// The decoded frames of a file (gray, full range, display orientation).
function decodeGray(file) {
  const [w, h] = probe(file, 'v:0', 'stream=width,height')[0].map(Number);
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']).stdout;
  const n = raw.length / (w * h);
  return { w, h, n, frame: (i) => raw.subarray(i * w * h, (i + 1) * w * h) };
}

const frameTimes = (file) => probe(file, 'v:0', 'frame=pts_time').map((x) => Number(x[0]));
const streamDur = (file, s) => Number(probe(file, s, 'stream=duration')[0][0]);

// The common §13.3 checks of an export of frames a..b of src.
function checkFile(name, out, src, a, b, w, h, opts = {}) {
  ffmpegClean(out);
  const s = probe(out, 'v:0', 'stream=codec_name,width,height')[0];
  assert(s[0] === 'h264' && Number(s[1]) === w && Number(s[2]) === h, `${name}: stream ${s}`);
  const ft = frameTimes(out), st = frameTimes(src);
  assert(ft.length === b - a + 1, `${name}: ${ft.length} frames, want ${b - a + 1}`);
  ft.forEach((t, i) => assert(Math.abs(t - (st[a + i] - st[a])) < 1e-4, `${name}: frame ${i} at ${t}, the source at ${st[a + i] - st[a]}`));
  if (opts.audio) {
    // The audio packets: byte-identical to the source packets in the range.
    const pa = packets(out, 'a:0'), ps = packets(src, 'a:0');
    assert(pa.length > 0, `${name}: no audio`);
    const first = ps.findIndex((p) => p.md5 === pa[0].md5);
    assert(first >= 0, `${name}: the first audio packet is not in the source`);
    pa.forEach((p, i) => assert(p.md5 === ps[first + i].md5 && p.size === ps[first + i].size, `${name}: audio packet ${i} differs`));
    if (opts.fullAudio) {
      assert(pa.length === ps.length, `${name}: ${pa.length} of ${ps.length} audio packets`);
      assert(Math.abs(streamDur(out, 'a:0') - streamDur(src, 'a:0')) < 1e-3, `${name}: audio duration ${streamDur(out, 'a:0')} / ${streamDur(src, 'a:0')}`);
    } else {
      const dv = ft[ft.length - 1] - ft[0] + (st[1] - st[0]);
      assert(Math.abs(streamDur(out, 'a:0') - dv) < 0.05, `${name}: audio ${streamDur(out, 'a:0')} s for ${dv} s of video`);
    }
  }
}

export const tests = [
  {
    name: 'export settings (Node): H.264 level, codec order, bitrate, sizes, file name, samples with B-frames',
    fn() {
      assert(h264Level(1920, 1080, 30) === 40 && h264Level(1920, 1080, 60) === 42 && h264Level(3840, 2160, 30) === 51 && h264Level(320, 240, 30) === 30, 'levels');
      assert(codecCandidates(1920, 1080, 30).join() === 'avc1.640028,avc1.4D0028,avc1.42E028', codecCandidates(1920, 1080, 30).join());
      assert(Math.abs(bitrateFor(1920, 1080, 30, 'high') - 1920 * 1080 * 30 * 0.12) < 1 && bitrateFor(1, 1, 1, 'custom', 12) === 12e6, 'bitrate');
      const s = exportSizes(3840, 2160).map((x) => `${x.id}:${x.width}x${x.height}`).join();
      assert(s === 'source:3840x2160,1440:2560x1440,1080:1920x1080,720:1280x720,540:960x540', s);
      assert(exportSizes(1080, 1920).find((x) => x.id === '720').width === 720, 'portrait');
      assert(exportName('holiday.MOV') === 'holiday-neofx.mp4', 'name');
      // Decode order I P B B (pts 0 3 1 2): dts are the sorted pts minus the delay; cto >= 0.
      const r = chunkSamples([{ pts: 0, key: true, size: 1 }, { pts: 3, size: 1 }, { pts: 1, size: 1 }, { pts: 2, size: 1 }], 1);
      assert(r.mediaTime === 1 && r.samples.map((x) => x.cto).join() === '1,3,0,0' && r.samples.map((x) => x.duration).join() === '1,1,1,1', JSON.stringify(r));
    },
  },
  {
    name: '§13.3 export, Mode 1: H.264, size, frame count, frame times, audio packets byte-identical, the delays of the decoded frames',
    timeout: 240000,
    async fn() {
      await withApp('code_aac.mp4', async (page, src) => {
        await set(page, { 'timemap.maxDelay': 30, 'timemap.blend': false });
        const r = await doExport(page, { width: 320, height: 240, range: [0, 89] }, 'export_mode1.mp4');
        assert(!r.error, r.error);
        assert(r.audio && r.frames === 90 && /^avc1\./.test(r.codec) && r.type === 'video/mp4' && r.name === 'x.mp4', JSON.stringify(r));
        checkFile('mode 1', r.file, src, 0, 89, 320, 240, { audio: true, fullAudio: true });
        // The rows of each decoded frame show frame t − round(30 v) (black before frame 0).
        const codes = groundTruth(src).codes;
        const d = decodeGray(r.file);
        let bad = 0;
        for (let t = 0; t < d.n; t++) {
          const f = d.frame(t);
          const rows = Array.from({ length: 30 }, (_, cy) => readCodeRow((x, y) => f[y * 320 + x], 320, cy));
          const want = expectRows(codes, t, 30);
          rows.forEach((c, i) => (bad += c !== want[i] ? 1 : 0));
        }
        assert(bad <= 0.005 * d.n * 30, `${bad} of ${d.n * 30} rows have a wrong delay`);
        // The preview is back after the export.
        const p = await page.evaluate(() => ({ w: window.neofx.store.width, view: window.neofx.settings.view, cur: window.neofx.player.current }));
        assert(p.w === 320 && p.view === 'result', `preview after the export ${JSON.stringify(p)}`);
      });
    },
  },
  {
    name: '§13.3 export: In – Out range (frames, times moved, the audio packets of the range); VFR times; a 90° rotated file',
    timeout: 300000,
    async fn() {
      await withApp('code_aac.mp4', async (page, src) => {
        await set(page, { 'timemap.maxDelay': 0 });
        const r = await doExport(page, { width: 320, height: 240, range: [20, 59] }, 'export_range.mp4');
        assert(!r.error, r.error);
        checkFile('range 20..59', r.file, src, 20, 59, 320, 240, { audio: true });
        const codes = groundTruth(src).codes;
        const d = decodeGray(r.file);
        const got = Array.from({ length: d.n }, (_, i) => readCode((x, y) => d.frame(i)[y * 320 + x], 320, 240));
        assert(got.join() === codes.slice(20, 60).join(), `range codes ${got.slice(0, 5)}`);
      });
      await withApp('code_vfr.mp4', async (page, src) => {
        await set(page, { 'timemap.maxDelay': 0 });
        const r = await doExport(page, { width: 320, height: 240, range: [0, 89] }, 'export_vfr.mp4');
        assert(!r.error, r.error);
        checkFile('vfr', r.file, src, 0, 89, 320, 240);
      });
      await withApp('code_rot90.mp4', async (page, src) => {
        await set(page, { 'timemap.maxDelay': 0 });
        const r = await doExport(page, { width: 240, height: 320, range: [0, 89] }, 'export_rot.mp4');
        assert(!r.error, r.error);
        checkFile('rot90', r.file, src, 0, 89, 240, 320);
        const codes = groundTruth(src, 90).codes;
        const d = decodeGray(r.file);
        // The export is upright (no rotation in the file): read with rotation 90 in display space.
        const got = Array.from({ length: d.n }, (_, i) => readCode((x, y) => d.frame(i)[y * 240 + x], 240, 320, 90));
        assert(got.join() === codes.join(), `rotated codes ${got.slice(0, 5)}`);
      });
    },
  },
  {
    name: '§13.3 export, Mode 2 (line, rate 1): the analysis pass at the export size; column k shows frame t − k',
    timeout: 240000,
    async fn() {
      await withApp('code.mp4', async (page, src) => {
        await set(page, { mode: 'slitscan', 'slitscan.x': 164.5 / 320, 'slitscan.y': 0.5, 'slitscan.angle': 90, 'slitscan.rate': 1, 'slitscan.maxAge': 90 });
        const r = await doExport(page, { width: 320, height: 240, range: [0, 89], audio: false }, 'export_mode2.mp4');
        assert(!r.error, r.error);
        checkFile('mode 2', r.file, src, 0, 89, 320, 240);
        const codes = groundTruth(src).codes;
        const lumaOf = (k, x, y) => (k < 0 ? 0 : 255 * ((codes[k] >> ((Math.floor(x / 8) + 3 * Math.floor(y / 8)) % 16)) & 1));
        const d = decodeGray(r.file);
        let bad = 0, n = 0;
        for (const t of [10, 45, 89]) {
          const f = d.frame(t);
          for (let cy = 0; cy < 30; cy++) for (let cx = 0; cx < 40; cx++) {
            const x = cx * 8 + 4, y = cy * 8 + 4;
            // Distance s > Max age (90): the original; else frame t − s (black before frame 0).
            const sd = x - 164;
            const want = x >= 164 && sd <= 90 ? lumaOf(t - sd, 164, y) : lumaOf(t, x, y);
            n++;
            if (Math.abs(f[y * 320 + x] - want) > 60) bad++;
          }
        }
        assert(bad <= 0.005 * n, `mode 2: ${bad} of ${n} block centres wrong`);
      });
    },
  },
  {
    name: 'export, Scan object (subject edge): the preview GPU-time limit does not apply to the export',
    timeout: 240000,
    async fn() {
      await withApp('subject.mp4', async (page, src) => {
        const f = makeFixtures(FIX_DIR, ['subjectmask.mp4']);
        await page.evaluate(() => window.neofx.change('cutout.bgdiff.on', false));
        await page.setInputFiles('#maskFileInput', f['subjectmask.mp4']);
        await page.waitForFunction(() => window.neofx.settings.cutout.import.on, null, { timeout: 30000 });
        await set(page, { mode: 'slitscan', 'cutout.mode': 'scan', 'slitscan.edgeAngle': 180, 'slitscan.maxAgeEdge': 30 });
        // A slow GPU for the preview: the preview limit is 10 frames of age.
        await page.evaluate(async () => {
          await window.neofx.gpu.call({ cmd: 'edgeTest', msPerAge: 2 });
          await window.neofx.player.seek(45);
          await window.neofx.player.seek(44);
        });
        const lim = await page.evaluate(() => window.neofx.gpu.call({ cmd: 'slitStatus' }));
        assert(lim.edge.maxAge === 10, `preview Max age ${lim.edge.maxAge}`);
        const r = await doExport(page, { width: 320, height: 240, range: [0, 59], audio: false }, 'export_scan.mp4');
        assert(!r.error, r.error);
        checkFile('scan object', r.file, src, 0, 59, 320, 240);
        // In the export, the trail of frame 45 is 30 frames long: 20 px left of the disc is a trail.
        const d = decodeGray(r.file).frame(45);
        const s = subjectAt(45);
        const y = Math.round(s.cy);
        const at = (dx) => d[y * 320 + Math.round(s.cx - s.r - dx)];
        assert(at(4) > 150 && at(20) > 150, `trail at 4 px ${at(4)}, at 20 px ${at(20)} (the background is about 90)`);
      });
    },
  },
  {
    name: 'export: a smaller size, OPFS for the file, cancel (the preview comes back), the dialog, the buffer warning',
    timeout: 300000,
    async fn() {
      await withApp('code_aac.mp4', async (page, src) => {
        const small = await doExport(page, { width: 160, height: 120, range: [0, 29], opfs: true }, 'export_small.mp4');
        assert(!small.error, small.error);
        assert(small.opfs, 'the file came from the OPFS');
        checkFile('160x120 (OPFS)', small.file, src, 0, 29, 160, 120, { audio: true });
        // Cancel after some frames: the export stops, the preview works again.
        const c = await page.evaluate(async () => {
          const N = window.neofx;
          let seen = 0;
          const p = N.exportVideo({ width: 320, height: 240, quality: 'high', keyint: 2, range: [0, 89], audio: true, hardware: 'hardware', name: 'c.mp4' }, (pr) => {
            if (pr.phase === 'encode' && ++seen === 10) N.cancelExport();
          });
          let error = null;
          try {
            await p;
          } catch (e) {
            error = e.message;
          }
          await N.player.seek(33);
          const r = await N.gpu.call({ cmd: 'read' });
          return { error, w: r.width, cur: N.player.current, busy: N.player.busy };
        });
        assert(c.error === 'Export cancelled' && c.w === 320 && c.cur === 33, `cancel ${JSON.stringify(c)}`);
        // The dialog: Export, then the Download link.
        await page.click('#exportBtn');
        await page.waitForSelector('#exportDialog[open] #exportGo');
        assert((await page.inputValue('#exportDialog input[name=name]')) === 'code_aac-neofx.mp4', 'the default name');
        await page.click('#exportGo');
        await page.waitForSelector('#exportDownload', { timeout: 120000 });
        const dl = await page.evaluate(async () => {
          const a = document.getElementById('exportDownload');
          return { name: a.download, size: (await (await fetch(a.href)).blob()).size };
        });
        assert(dl.name === 'code_aac-neofx.mp4' && dl.size > 10000, `download ${JSON.stringify(dl)}`);
        await page.evaluate(() => document.getElementById('exportDialog').close());
        // A Max delay larger than the buffer at that size: a warning, and no Export.
        const w = await page.evaluate(async (budget) => {
          const N = window.neofx;
          N.store.budget = budget;
          await N.configureStore();
          N.change('timemap.maxDelay', 15);
          N.store.usedBudget = budget / 4; // as if the export size had less memory
          N.exportDialog.open();
          return { text: document.querySelector('.exportWarn').textContent, disabled: document.getElementById('exportGo').disabled };
        }, 16 * frameBytes(320, 240));
        assert(/more than the buffer/.test(w.text) && w.disabled, `warning ${JSON.stringify(w)}`);
      }, true);
    },
  },
];
