// The frame timeline and the seek plan (plan §6.1, §6.2), against the FFmpeg ground truth.

import fs from 'node:fs';
import { assert, hasFfmpeg } from './lib/util.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR, groundTruth } from './fixtures.test.mjs';
import { demuxMp4 } from '../src/io/demux.js';
import { buildTimeline, keyBefore, planSegments, frameAtUs, thumbIndices, displaySize, isCleanStart } from '../src/io/timeline.js';

const ROT = { 'code_rot90.mp4': 90 };

export const tests = [
  {
    name: 'timeline: frame count, display times, size, fps equal FFmpeg (rotation, edit list, VFR)',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const f = makeFixtures(FIX_DIR);
      for (const [name, file] of Object.entries(f)) {
        const d = await demuxMp4(await fs.openAsBlob(file));
        const tl = buildTimeline(d);
        const gt = groundTruth(file, ROT[name] || 0);
        assert(tl.frames.length === gt.codes.length, `${name}: ${tl.frames.length} frames, FFmpeg ${gt.codes.length}`);
        // FFmpeg times start at the first presented frame (0 with an edit list too).
        const t0 = gt.times[0];
        tl.frames.forEach((fr, i) => assert(Math.abs(fr.us - (gt.times[i] - t0)) <= 1, `${name}: frame ${i} time ${fr.us} / ${gt.times[i] - t0}`));
        const ds = displaySize(d);
        assert(ds.width === gt.w && ds.height === gt.h, `${name}: size ${ds.width}x${ds.height}`);
        if (name !== 'code_vfr.mp4') assert(Math.abs(tl.fps - 30) < 0.01, `${name}: fps ${tl.fps}`);
        // keyBefore: a sync sample, at or before the frame in decode order and in display time.
        tl.frames.forEach((fr, t) => {
          const k = keyBefore(tl, t);
          assert(d.samples[k].key && k <= fr.sample && d.samples[k].us <= fr.us, `${name}: key of frame ${t}`);
        });
        // frameAtUs is the inverse of the frame times.
        tl.frames.forEach((fr, t) => assert(frameAtUs(tl, fr.us) === t && frameAtUs(tl, fr.us + fr.dur - 1) === t, `${name}: frameAtUs ${t}`));
      }
    },
  },
  {
    name: 'seek plan: contiguous frames share one segment; far frames jump to their own sync sample',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const f = makeFixtures(FIX_DIR, ['code.mp4']);
      const tl = buildTimeline(await demuxMp4(await fs.openAsBlob(f['code.mp4'])));
      const all = Array.from({ length: 90 }, (_, i) => i);
      const one = planSegments(tl, all);
      assert(one.length === 1 && one[0].start === 0 && one[0].end === 89, `all frames: ${JSON.stringify(one.map((s) => [s.start, s.end]))}`);
      const far = planSegments(tl, [2, 50, 51, 80]);
      assert(far.length === 3 && far[1].frames.join() === '50,51', `far: ${JSON.stringify(far.map((s) => [s.start, s.end, s.frames]))}`);
      for (const s of far) for (const t of s.frames) assert(s.start <= tl.frames[t].sample && s.end >= tl.frames[t].sample, 'frame in its segment');
      const th = thumbIndices(90, 50);
      assert(th.length <= 50 && th[0] >= 0 && th[th.length - 1] <= 89 && th.every((t, i) => !i || t > th[i - 1]), 'thumb indices');
      assert(thumbIndices(10, 50).length === 10, 'short video: one thumb for each frame');
    },
  },
  {
    name: 'clean starts: IDR sync samples are clean; open-GOP I-frames (recovery points) are not',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const f = makeFixtures(FIX_DIR, ['code.mp4', 'code_opengop.mp4']);
      const kinds = async (name) => {
        const buf = fs.readFileSync(f[name]);
        const d = await demuxMp4(await fs.openAsBlob(f[name]));
        return d.samples.filter((s) => s.key).map((s) => isCleanStart(d, buf.subarray(s.offset, s.offset + Math.min(s.size, 4096))));
      };
      const closed = await kinds('code.mp4');
      assert(closed.length >= 3 && closed.every(Boolean), `closed GOP: ${closed}`);
      const open = await kinds('code_opengop.mp4');
      assert(open[0] && open.some((x) => !x), `open GOP: ${open}`);
    },
  },
];
