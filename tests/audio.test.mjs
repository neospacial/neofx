// The sound of the preview: the audio track is decoded while the video plays and scheduled on the
// playback clock; it stops with the playback; the mute button (and its state after a reload); a
// video without sound has the button off with the reason.

import { createRequire } from 'node:module';
import { assert, hasFfmpeg } from './lib/util.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

export const tests = [
  {
    name: 'preview sound: decoded and scheduled with the playback clock (in time, no late packets), stops with the pause; mute (also while it plays) and its state after a reload; no sound: the button is off',
    timeout: 180000,
    async fn() {
      if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
      const f = makeFixtures(FIX_DIR, ['code_aac.mp4', 'color.mp4']);
      const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
      try {
        // No sound in this video: the button is off and tells why.
        await open(page, f['color.mp4']);
        await page.waitForFunction(() => !window.neofx.sound.file || window.neofx.sound.reason);
        const none = await page.evaluate(() => ({ disabled: document.getElementById('muteBtn').disabled, title: document.getElementById('muteBtn').title }));
        assert(none.disabled && /no sound/i.test(none.title), `no sound: ${JSON.stringify(none)}`);
        // A video with AAC sound.
        await open(page, f['code_aac.mp4']);
        await page.waitForFunction(() => window.neofx.sound.available, null, { timeout: 10000 });
        assert(!(await page.evaluate(() => document.getElementById('muteBtn').disabled)), 'the button is on');
        await page.evaluate(() => (window.neofx.sound.log = []));
        await page.click('#transport [data-act="play"]'); // a user gesture: the audio context runs
        await page.waitForTimeout(1500);
        const r = await page.evaluate(() => {
          const S = window.neofx.sound, P = window.neofx.player;
          const run = S.run;
          // Each packet starts at the context time of its file time on the clock of the video.
          const off = run ? run.offset : 0;
          const err = S.log.map((e) => Math.abs(e.at - Math.max(((P.clock.wall + (e.us - P.clock.us) / 1000) / 1000 + off), e.now)));
          return { state: S.ctx && S.ctx.state, n: S.log.length, trimmed: S.stats.trimmed, late: S.stats.late, sources: run ? run.sources.size : 0, maxErr: Math.max(0, ...err), playing: P.playing, firstUs: S.log.length ? S.log[0].us : -1, clockUs: P.clock.us };
        });
        assert(r.playing && r.state === 'running', `the context runs: ${JSON.stringify(r)}`);
        assert(r.n >= 30 && r.late === 0, `packets scheduled: ${r.n}, late ${r.late}`);
        assert(r.maxErr < 0.025, `the packets are on the clock of the video: ${r.maxErr.toFixed(4)} s`);
        assert(Math.abs(r.firstUs - r.clockUs) < 100000 && r.trimmed <= 4, `the sound starts at the first shown frame: ${r.firstUs} / ${r.clockUs} (${r.trimmed} packets cut by the output latency)`);
        // Mute while it plays: the sound stops; unmute: it starts again at the playhead.
        await page.click('#muteBtn');
        let m = await page.evaluate(() => ({ run: !!window.neofx.sound.run, pressed: document.getElementById('muteBtn').getAttribute('aria-pressed') }));
        assert(!m.run && m.pressed === 'true', `muted: ${JSON.stringify(m)}`);
        await page.click('#muteBtn');
        await page.waitForTimeout(500);
        m = await page.evaluate(() => {
          const S = window.neofx.sound, P = window.neofx.player;
          return { run: !!S.run, playing: P.playing, from: S.run && S.run.from, at: P.clock.us + (performance.now() - P.clock.wall) * 1000 };
        });
        assert(m.run && m.playing && m.at - m.from < 800000 && m.at - m.from > 0, `unmuted at the playhead: ${JSON.stringify(m)}`);
        // Pause: no sound left.
        await page.click('#transport [data-act="play"]');
        m = await page.evaluate(() => ({ run: !!window.neofx.sound.run, playing: window.neofx.player.playing }));
        assert(!m.run && !m.playing, 'the pause stops the sound');
        // The mute state stays after a reload.
        await page.click('#muteBtn');
        await page.reload();
        await page.waitForFunction(() => window.neofx && window.neofx.player);
        assert(await page.evaluate(() => window.neofx.sound.muted), 'muted after a reload');
        await page.evaluate(() => localStorage.removeItem('neofx.muted'));
        assert(!errors.length, errors.join('; '));
      } finally {
        await browser.close();
      }
    },
  },
];
