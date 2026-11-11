// Test helpers: assert, the output folder, FFmpeg / ffprobe calls.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export const run = (cmd, args) => spawnSync(cmd, args, { maxBuffer: 1 << 28 });

let ffOk = null;
// FFmpeg with libx264 and the AAC encoder. The tests that need it are skipped without it.
export function hasFfmpeg() {
  if (ffOk === null) {
    const r = run('ffmpeg', ['-hide_banner', '-encoders']);
    ffOk = r.status === 0 && /libx264/.test(r.stdout) && /\baac\b/.test(r.stdout);
  }
  return ffOk;
}

// Make a file with FFmpeg. Returns the path, or null (and a note) when FFmpeg cannot.
export function ffmpeg(name, args) {
  const file = path.join(OUT_DIR, name);
  const r = run('ffmpeg', ['-v', 'error', '-y', ...args, file]);
  if (r.status !== 0) {
    console.log(`      (skipped ${name}: ${r.stderr.toString().trim().split('\n').pop()})`);
    return null;
  }
  return file;
}

// ffprobe -show_entries for one stream ('v:0', 'a:0'): rows of fields.
export function probe(file, stream, what) {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', what, '-of', 'csv=p=0', file]).stdout.toString().trim();
  return out ? out.split('\n').map((l) => l.split(',')) : [];
}

// The packets of one stream: [{ pts, dts, duration (seconds), size, pos, key, md5 }] (decode order).
export function packets(file, stream) {
  const rows = probe(file, stream, 'packet=pts_time,dts_time,duration_time,size,pos,flags');
  const data = run('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${stream}`, '-c', 'copy', '-f', 'framemd5', '-']).stdout.toString()
    .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').map((x) => x.trim()));
  return rows.map((r, i) => ({ pts: Number(r[0]), dts: Number(r[1]), duration: Number(r[2]), size: Number(r[3]), pos: Number(r[4]), key: r[5].startsWith('K'), md5: data[i] && data[i][5] }));
}

// FFmpeg reads the file with no warning.
export function ffmpegClean(file) {
  const r = run('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', file, '-f', 'null', '-']);
  assert(r.status === 0 && r.stderr.toString().trim() === '', `ffmpeg ${path.basename(file)}: ${r.stderr}`);
}

export const concatParts = async (parts) => Buffer.concat(await Promise.all(parts.map(async (p) => Buffer.from(p instanceof Blob ? await p.arrayBuffer() : p))));
