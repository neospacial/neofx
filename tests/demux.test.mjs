// The MP4/MOV reader (plan §3, §6.1), against FFmpeg (ffprobe packets and frames).

import fs from 'node:fs';
import path from 'node:path';
import { assert, ffmpeg, hasFfmpeg, probe, packets, OUT_DIR } from './lib/util.mjs';
import { demuxMp4, turnedCrop } from '../src/io/demux.js';

const vin = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30'];
const vout = ['-frames:v', '45', '-pix_fmt', 'yuv420p'];
const src = [...vin, ...vout];
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5'];
const av = (audioIn) => [...vin, ...audioIn, ...vout];

async function check(name, args, want = {}) {
  const file = ffmpeg(name, args);
  if (!file) {
    assert(!want.audio, `${name}: FFmpeg could not make the file`);
    return null;
  }
  const d = await demuxMp4(await fs.openAsBlob(file));
  assert(d, `${name}: not read`);
  const pk = probe(file, 'v:0', 'packet=size,pos,flags');
  assert(d.samples.length === pk.length, `${name}: ${d.samples.length} samples, ${pk.length} packets`);
  d.samples.forEach((s, i) => {
    assert(s.size === Number(pk[i][0]) && s.offset === Number(pk[i][1]), `${name}: sample ${i} position`);
    assert(s.key === pk[i][2].startsWith('K'), `${name}: sample ${i} sync`);
  });
  // The display times, in display order, are the frame times of FFmpeg.
  const fr = probe(file, 'v:0', 'frame=pts_time').map((x) => Math.round(Number(x[0]) * 1e6));
  const us = d.samples.map((s) => s.us).sort((a, b) => a - b);
  assert(fr.length === us.length && fr.every((t, i) => Math.abs(t - us[i]) <= 1), `${name}: times ${us.slice(0, 5)} / ${fr.slice(0, 5)}`);
  if (want.codec) assert(want.codec.test(d.codec), `${name}: codec ${d.codec}`);
  if (want.rotation !== undefined) assert(d.rotation === want.rotation, `${name}: rotation ${d.rotation}`);
  if (want.audio) checkAudio(name, file, d, want.audio);
  else if (want.audio === null) assert(d.audio === null, `${name}: no audio track expected`);
  return d;
}

function checkAudio(name, file, d, want) {
  const a = d.audio;
  assert(a, `${name}: no audio`);
  assert(want.codec.test(a.codec), `${name}: audio codec ${a.codec}`);
  assert(a.channels === want.channels && a.sampleRate === want.sampleRate, `${name}: ${a.channels} ch, ${a.sampleRate} Hz`);
  assert(a.config && a.config.length > 8 && String.fromCharCode(...a.config.subarray(4, 8)) === want.box, `${name}: config box`);
  const pk = packets(file, 'a:0');
  assert(a.samples.length === pk.length, `${name}: ${a.samples.length} audio samples, ${pk.length} packets`);
  a.samples.forEach((s, i) => {
    assert(s.size === pk[i].size && s.offset === pk[i].pos, `${name}: audio sample ${i} position`);
    assert(Math.abs(s.us / 1e6 - pk[i].pts) < 1e-4, `${name}: audio sample ${i} time ${s.us} / ${pk[i].pts}`);
  });
}

export const tests = [
  {
    name: 'MP4/MOV reader: H.264 with B-frames, MOV, rotation, HEVC, moov at the end, not MP4',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      await check('dmx_h264.mp4', [...src, '-c:v', 'libx264', '-bf', '3', '-g', '12', '-movflags', '+faststart'], { codec: /^avc1\.64/, rotation: 0, audio: null });
      await check('dmx_end.mp4', [...src, '-c:v', 'libx264', '-bf', '0'], { codec: /^avc1\./ });
      await check('dmx.mov', [...src, '-c:v', 'libx264', '-bf', '2'], { codec: /^avc1\./ });
      // -display_rotation (on a stream copy) is counterclockwise; a player turns the picture
      // clockwise by r = 360 - that angle.
      const plain = ffmpeg('dmx_plain.mp4', [...src, '-c:v', 'libx264']);
      for (const r of [90, 180, 270]) await check(`dmx_rot${r}.mp4`, ['-display_rotation', String(360 - r), '-i', plain, '-c', 'copy'], { rotation: r });
      await check('dmx_hevc.mp4', [...src, '-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'], { codec: /^hvc1\.1\.6\.L\d+/ });
      const webm = ffmpeg('dmx.webm', [...src, '-c:v', 'libvpx']);
      if (webm) assert((await demuxMp4(await fs.openAsBlob(webm))) === null, 'webm: null');
      const junk = path.join(OUT_DIR, 'dmx_junk.mp4');
      fs.writeFileSync(junk, Buffer.from('this is not a video file at all'));
      assert((await demuxMp4(await fs.openAsBlob(junk))) === null, 'junk: null');
    },
  },
  {
    name: 'edit list and variable frame rate: the display times are the FFmpeg times',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      // VFR: frames at irregular times (setpts), kept by -fps_mode passthrough.
      const d = await check('dmx_vfr.mp4', [...src, '-vf', "setpts='N/30/TB+if(gt(N,20),0.2/TB,0)+if(eq(mod(N,7),3),0.011/TB,0)'", '-fps_mode', 'passthrough', '-c:v', 'libx264', '-bf', '0']);
      const us = d.samples.map((s) => s.us);
      const steps = new Set(us.slice(1).map((t, i) => t - us[i]));
      assert(steps.size > 1, 'the file has variable frame durations');
      // An edit list that starts the video late (-ss on a stream copy writes elst with a media time).
      const b = ffmpeg('dmx_bf.mp4', [...src, '-c:v', 'libx264', '-bf', '2', '-g', '15']);
      const e = await check('dmx_elst.mp4', ['-ss', '0.5', '-i', b, '-c', 'copy']);
      assert(e.mediaTime > 0, `edit list media time ${e.mediaTime}`);
    },
  },
  {
    name: 'audio track: AAC (MP4 and MOV) and Opus; codec, config box, sample positions, times',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const v = ['-c:v', 'libx264', '-bf', '2'];
      await check('dmx_aac.mp4', [...av(tone), ...v, '-c:a', 'aac', '-b:a', '128k'], { audio: { codec: /^mp4a\.40\.2$/, channels: 1, sampleRate: 48000, box: 'esds' } });
      await check('dmx_aac_st.mp4', [...av(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=44100:duration=1.5']), ...v, '-c:a', 'aac', '-ac', '2'],
        { audio: { codec: /^mp4a\.40\.2$/, channels: 2, sampleRate: 44100, box: 'esds' } });
      await check('dmx_aac.mov', [...av(tone), ...v, '-c:a', 'aac'], { audio: { codec: /^mp4a\.40\.2$/, channels: 1, sampleRate: 48000, box: 'esds' } });
      await check('dmx_opus.mp4', [...av(tone), ...v, '-c:a', 'libopus'], { audio: { codec: /^opus$/, channels: 1, sampleRate: 48000, box: 'dOps' } });
    },
  },
  {
    name: 'turned crop: each rotation maps the display crop to the frame and back',
    fn() {
      for (const rot of [0, 90, 180, 270]) {
        const [fw, fh] = [400, 300];
        const [dw0, dh0] = rot % 180 ? [fh, fw] : [fw, fh];
        const c = { sx: 20, sy: 40, sw: dw0 - 60, sh: dh0 - 100 };
        const w = 100, h = Math.round((100 * c.sh) / c.sw);
        const t = turnedCrop(rot, fw, fh, c, w, h);
        const disp = (x, y) => (rot === 90 ? [fh - y, x] : rot === 180 ? [fw - x, fh - y] : rot === 270 ? [y, fw - x] : [x, y]);
        const out = (x, y) => {
          const u = ((x - t.sx) * t.dw) / t.sw, v = ((y - t.sy) * t.dh) / t.sh;
          const [a, b, cc, d, e, f] = t.m;
          return [a * u + cc * v + e, b * u + d * v + f];
        };
        for (const [x, y] of [[t.sx, t.sy], [t.sx + t.sw, t.sy], [t.sx, t.sy + t.sh], [t.sx + t.sw, t.sy + t.sh]]) {
          const [dx, dy] = disp(x, y);
          const [ox, oy] = out(x, y);
          const ex = ((dx - c.sx) * w) / c.sw, ey = ((dy - c.sy) * h) / c.sh;
          assert(Math.abs(ox - ex) < 0.6 && Math.abs(oy - ey) < 0.6, `rotation ${rot}: (${x},${y}) -> (${ox},${oy}), want (${ex},${ey})`);
        }
      }
    },
  },
];
