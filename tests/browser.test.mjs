// The built page in Chromium (Playwright): it starts with no errors and no network requests, the
// platform checks run (plan §4), and demuxMp4 feeds a WebCodecs VideoDecoder in the browser.
// Skipped when Playwright is not available.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, ffmpeg, hasFfmpeg } from './lib/util.mjs';
import { bundle, PAGES } from '../tools/build.mjs';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

async function withPage(fn, viewport = { width: 1280, height: 800 }) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport });
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('request', (r) => !r.url().startsWith('file:') && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && requests.push(r.url()));
    await page.goto(pathToFileURL(path.join(root, 'dist', PAGES[0][1])).href);
    await page.waitForFunction(() => window.neofx && window.neofx.platform);
    await fn(page);
    assert(!errors.length, `page errors: ${errors.join('; ')}`);
    assert(!requests.length, `network requests: ${requests.join(', ')}`);
  } finally {
    await browser.close();
  }
}

export const tests = [
  {
    name: 'the app shell starts in Chromium (desktop and phone size), platform checks run, no network',
    async fn() {
      if (!chromium) return console.log('      (skipped: no Playwright)');
      for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        await withPage(async (page) => {
          const r = await page.evaluate(() => ({ v: window.neofx.version, p: window.neofx.platform, title: document.title, drop: !!document.getElementById('dropArea').offsetWidth }));
          assert(r.v === '0.1.0' && r.title === 'neofx 0.1.0', `version ${r.v}`);
          assert(r.drop, 'the start screen shows the drop area');
          if (r.p.ok) assert(r.p.gl.maxLayers >= 256 && r.p.gl.maxTexture >= 2048, `GL limits ${JSON.stringify(r.p.gl)}`);
          else console.log(`      (platform: ${r.p.fatal})`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          assert(!overflow, `horizontal scroll at ${vp.width} px`);
        }, vp);
      }
    },
  },
  {
    name: 'demuxMp4 in the browser: a VideoDecoder decodes every sample of the file',
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const file = ffmpeg('br_dmx.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-bf', '2', '-g', '10']);
      const code = bundle(['io/demux.js']);
      const b64 = fs.readFileSync(file).toString('base64');
      await withPage(async (page) => {
        const r = await page.evaluate(async ({ code, b64 }) => {
          (0, eval)(code + '\nwindow.__demux = demuxMp4;');
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes]);
          const d = await window.__demux(blob);
          const config = { codec: d.codec, codedWidth: d.codedWidth, codedHeight: d.codedHeight, description: d.description };
          const sup = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
          if (!sup.supported) return { skipped: d.codec };
          const times = [];
          let err = null;
          const dec = new VideoDecoder({ output: (f) => { times.push(f.timestamp); f.close(); }, error: (e) => (err = String(e)) });
          dec.configure(config);
          for (const s of d.samples) dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.us, data: bytes.subarray(s.offset, s.offset + s.size) }));
          await dec.flush();
          return { err, times, want: d.samples.map((s) => s.us).sort((a, b) => a - b) };
        }, { code, b64 });
        if (r.skipped) return console.log(`      (skipped: this Chromium cannot decode ${r.skipped})`);
        assert(!r.err, r.err);
        assert(JSON.stringify(r.times) === JSON.stringify(r.want), `frame times ${r.times.slice(0, 5)} / ${r.want.slice(0, 5)}`);
      });
    },
  },
];
