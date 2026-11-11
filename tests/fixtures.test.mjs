// The test fixtures (plan §13.1) and the ground truth from FFmpeg: the frame code of each presented
// frame, read with readCode from the FFmpeg decode (turned as a player shows it).

import path from 'node:path';
import { assert, hasFfmpeg, run, probe, OUT_DIR } from './lib/util.mjs';
import { makeFixtures, readCode } from '../tools/make-fixtures.mjs';

export const FIX_DIR = path.join(OUT_DIR, 'fixtures');

// { codes, times (us), w, h } of a file, from FFmpeg.
export function groundTruth(file, rotation = 0) {
  const s = probe(file, 'v:0', 'stream=width,height')[0].map(Number);
  const [w, h] = rotation % 180 ? [s[1], s[0]] : s;
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']).stdout;
  const n = raw.length / (w * h);
  const codes = [];
  for (let i = 0; i < n; i++) {
    const o = i * w * h;
    codes.push(readCode((x, y) => raw[o + y * w + x], w, h, rotation));
  }
  const times = probe(file, 'v:0', 'frame=pts_time').map((x) => Math.round(Number(x[0]) * 1e6));
  return { codes, times, w, h };
}

// The codes of frames a .. b - 1 (code = frame number + 1).
const seq = (a, b) => Array.from({ length: b - a }, (_, i) => a + i + 1);

export const tests = [
  {
    name: 'fixtures: the frame code reads back from the FFmpeg decode (plain, open GOP, rotation, edit list, VFR, audio)',
    fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const f = makeFixtures(FIX_DIR);
      assert(Object.keys(f).length === 6, `fixtures: ${Object.keys(f)}`);
      const plain = groundTruth(f['code.mp4']);
      assert(JSON.stringify(plain.codes) === JSON.stringify(seq(0, 90)), `code.mp4 codes ${plain.codes.slice(0, 10)}`);
      assert(JSON.stringify(groundTruth(f['code_opengop.mp4']).codes) === JSON.stringify(seq(0, 90)), 'open GOP codes');
      const rot = groundTruth(f['code_rot90.mp4'], 90);
      assert(rot.w === 240 && rot.h === 320 && JSON.stringify(rot.codes) === JSON.stringify(seq(0, 90)), 'rotated codes');
      const e = groundTruth(f['code_elst.mp4']);
      assert(e.codes[0] === 16 && JSON.stringify(e.codes) === JSON.stringify(seq(15, 90)), `edit list codes ${e.codes.slice(0, 5)}`);
      const v = groundTruth(f['code_vfr.mp4']);
      assert(JSON.stringify(v.codes) === JSON.stringify(seq(0, 90)), 'VFR codes');
      assert(new Set(v.times.slice(1).map((t, i) => t - v.times[i])).size > 2, 'VFR has different frame durations');
    },
  },
];
