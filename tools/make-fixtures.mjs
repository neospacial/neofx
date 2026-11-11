// Test videos (plan §13.1), made with FFmpeg.
// The frame-number video: each frame shows its frame number + 1 as a binary code in a grid of blocks
// (8x8 px, black = 0, white = 1). The block at column cx, row cy has bit (cx + 3 * cy) mod 16, so the
// code repeats over the full frame and a test can read, at each pixel, which source frame it shows.
// Code 0 (all black) is never a frame: it is a black ("not online") pixel.
// Usage: node tools/make-fixtures.mjs [folder]   (default: samples/)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CODE_BLOCK = 8;
export const CODE_BITS = 16;

const W = 320, H = 240, FPS = 30, N = 90;
const codeFilter = `geq=lum='255*mod(floor((N+1)/pow(2,mod(floor(X/${CODE_BLOCK})+3*floor(Y/${CODE_BLOCK}),${CODE_BITS}))),2)':cb=128:cr=128`;
const codeIn = () => ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}`];
const x264 = (extra = []) => ['-frames:v', String(N), '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', ...extra];

// name -> (out, dir) => FFmpeg arguments (inputs ... outputs, without the file).
export const FIXTURES = {
  // B-frames, closed GOP, keyframe each 24 frames.
  'code.mp4': () => [...codeIn(), '-vf', codeFilter, ...x264(['-bf', '2', '-g', '24'])],
  // Open GOP: leading B-frames refer to the GOP before the keyframe.
  'code_opengop.mp4': () => [...codeIn(), '-vf', codeFilter, ...x264(['-bf', '3', '-g', '20', '-x264-params', 'open-gop=1:keyint_min=20'])],
  // 90° rotation (tkhd matrix). -display_rotation is counterclockwise: 270 = turned 90° clockwise.
  'code_rot90.mp4': (dir) => ['-display_rotation', '270', '-i', path.join(dir, 'code.mp4'), '-c', 'copy'],
  // An edit list: the presentation starts 0.5 s into the media.
  'code_elst.mp4': (dir) => ['-ss', '0.5', '-i', path.join(dir, 'code.mp4'), '-c', 'copy'],
  // Variable frame rate: a 0.2 s gap after frame 40, and jitter.
  'code_vfr.mp4': () => [...codeIn(), '-vf', `${codeFilter},setpts='N/${FPS}/TB+if(gt(N,40),0.2/TB,0)+if(eq(mod(N,7),3),0.011/TB,0)'`, '-fps_mode', 'passthrough', ...x264(['-bf', '2', '-g', '30'])],
  // AAC audio.
  'code_aac.mp4': () => [...codeIn(), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-vf', codeFilter, ...x264(['-bf', '2']), '-c:a', 'aac', '-shortest'],
};

// Make the fixtures that are not there yet (in this order: some use 'code.mp4').
// Returns { name: path }; a fixture that FFmpeg cannot make is left out.
export function makeFixtures(dir, names = Object.keys(FIXTURES)) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...FIXTURES[name](dir), file]);
      if (r.status !== 0) {
        console.log(`      (no fixture ${name}: ${r.stderr.toString().trim().split('\n').pop()})`);
        continue;
      }
    }
    out[name] = file;
  }
  return out;
}

// Read the frame code (frame number + 1; 0 = black) from a picture. get(x, y): the luma (0-255) at a display pixel. w, h: the
// display size. rotation: the clockwise turn of the display picture from the coded picture. Each bit
// is a majority vote over up to 8 blocks. Self-contained (the browser tests use its source).
export function readCode(get, w, h, rotation = 0) {
  const B = 8, BITS = 16;
  const sw = rotation % 180 ? h : w, sh = rotation % 180 ? w : h;
  const cols = Math.floor(sw / B), rows = Math.floor(sh / B);
  const disp = (x, y) => (rotation === 90 ? [sh - 1 - y, x] : rotation === 180 ? [sw - 1 - x, sh - 1 - y] : rotation === 270 ? [y, sw - 1 - x] : [x, y]);
  let code = 0;
  for (let b = 0; b < BITS; b++) {
    let ones = 0, n = 0;
    for (let cy = 0; cy < rows && n < 8; cy++) {
      for (let cx = (((b - 3 * cy) % BITS) + BITS) % BITS; cx < cols && n < 8; cx += BITS) {
        const [x, y] = disp(cx * B + B / 2, cy * B + B / 2);
        if (get(x, y) > 128) ones++;
        n++;
      }
    }
    if (ones * 2 > n) code |= 1 << b;
  }
  return code;
}

// Read the code of one block row (cy) only, at its centre pixel row (no rotation). For effects where
// each row shows a different frame (Mode 1 with a vertical map). Self-contained.
export function readCodeRow(get, w, cy) {
  const B = 8, BITS = 16;
  const cols = Math.floor(w / B), y = cy * B + B / 2;
  let code = 0;
  for (let b = 0; b < BITS; b++) {
    let ones = 0, n = 0;
    for (let cx = (((b - 3 * cy) % BITS) + BITS) % BITS; cx < cols; cx += BITS) {
      if (get(cx * B + B / 2, y) > 128) ones++;
      n++;
    }
    if (ones * 2 > n) code |= 1 << b;
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples'));
  for (const [name, file] of Object.entries(makeFixtures(dir))) console.log(`${name}: ${file}`);
}
