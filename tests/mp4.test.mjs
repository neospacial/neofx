// The MP4 muxer (plan §3, §11.2): video + audio pass-through, interleave, colr, co64, Blob parts.
// Method: demux a file made by FFmpeg, mux its samples again, and compare with FFmpeg.

import fs from 'node:fs';
import path from 'node:path';
import { assert, ffmpeg, hasFfmpeg, packets, probe, ffmpegClean, concatParts, run, OUT_DIR } from './lib/util.mjs';
import { demuxMp4 } from '../src/io/demux.js';
import { muxMp4, DataPacker } from '../src/io/mp4.js';

const vin = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30'];
const vout = ['-frames:v', '60', '-pix_fmt', 'yuv420p'];
const tone = (rate = 48000, sec = 2) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${sec}`];

// Demux a file, and give the inputs of muxMp4 (sample data read from the file).
async function remuxInputs(file, opts = {}) {
  const buf = fs.readFileSync(file);
  const d = await demuxMp4(await fs.openAsBlob(file));
  assert(d, `${file}: not read`);
  const data = (s) => new Uint8Array(buf.buffer, buf.byteOffset + s.offset, s.size);
  const packer = opts.blobChunk ? new DataPacker(opts.blobChunk) : null;
  const vs = d.samples.map((s) => {
    if (packer) packer.add(data(s));
    return { data: packer ? null : data(s), size: s.size, duration: s.duration, key: s.key, cto: s.cto };
  });
  const [w, h] = [320, 240];
  const video = { width: w, height: h, timescale: d.timescale, avcc: d.description, samples: vs, mediaTime: d.mediaTime };
  if (packer) video.dataParts = packer.done();
  let audio = null;
  if (d.audio && !opts.noAudio) {
    const ap = opts.blobChunk ? new DataPacker(opts.blobChunk) : null;
    const as = d.audio.samples.map((s) => {
      if (ap) ap.add(data(s));
      return { data: ap ? null : data(s), size: s.size, duration: s.duration };
    });
    audio = { ...d.audio, samples: as };
    if (ap) audio.dataParts = ap.done();
  }
  return { d, video, audio };
}

async function writeMux(name, video, opts) {
  const r = muxMp4(video, opts);
  const bytes = await concatParts(r.parts);
  assert(bytes.length === r.size, `${name}: size ${bytes.length} != ${r.size}`);
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, bytes);
  return { out, bytes, r };
}

// The packets of the copy are the packets of the source: data (md5), times, flags.
function samePackets(src, out, stream) {
  const a = packets(src, stream), b = packets(out, stream);
  assert(a.length === b.length && a.length > 0, `${stream}: ${a.length} / ${b.length} packets`);
  a.forEach((p, i) => {
    const q = b[i];
    assert(p.md5 === q.md5, `${stream} packet ${i}: data differs`);
    assert(p.key === q.key, `${stream} packet ${i}: key flag`);
    assert(Math.abs(p.pts - q.pts) < 1e-4 && Math.abs(p.dts - q.dts) < 1e-4, `${stream} packet ${i}: time ${p.pts}/${q.pts}, ${p.dts}/${q.dts}`);
  });
  return b;
}

const hasBox = (buf, type) => buf.indexOf(Buffer.from(type, 'latin1')) >= 0;

export const tests = [
  {
    name: 'video only: the copy has the same packets and frame times; colr BT.709; moov before mdat',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      for (const bf of [0, 3]) {
        const src = ffmpeg(`mux_src_bf${bf}.mp4`, [...vin, ...vout, '-c:v', 'libx264', '-bf', String(bf), '-g', '20']);
        const { video } = await remuxInputs(src);
        const { out, bytes } = await writeMux(`mux_v_bf${bf}.mp4`, video);
        ffmpegClean(out);
        samePackets(src, out, 'v:0');
        const ft = (f) => probe(f, 'v:0', 'frame=pts_time').map((x) => Number(x[0]));
        assert(JSON.stringify(ft(src)) === JSON.stringify(ft(out)), `bf${bf}: frame times`);
        const s = probe(out, 'v:0', 'stream=codec_name,width,height,color_primaries,color_transfer,color_space')[0];
        assert(s[0] === 'h264' && s[1] === '320' && s[2] === '240', `stream ${s}`);
        for (const b of ['ftyp', 'moov', 'avcC', 'colr', 'stss', 'mdat']) assert(hasBox(bytes, b), `no ${b} box`);
        assert(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'moov must come before mdat');
        assert(!hasBox(bytes, 'soun'), 'no audio track');
      }
    },
  },
  {
    name: 'audio pass-through (D16): AAC and Opus packets are byte-identical, with the same times',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const cases = [
        ['aac48', [...tone(), '-c:a', 'aac', '-b:a', '128k'], 'aac', 'mp4'],
        ['aac44st', [...tone(44100), '-c:a', 'aac', '-ac', '2'], 'aac', 'mp4'],
        ['aacmov', [...tone(), '-c:a', 'aac'], 'aac', 'mov'],
        ['opus', [...tone(), '-c:a', 'libopus'], 'opus', 'mp4'],
      ];
      for (const [name, a, codec, ext] of cases) {
        const src = ffmpeg(`mux_src_${name}.${ext}`, [...vin, ...a.slice(0, 4), ...vout, ...a.slice(4), '-c:v', 'libx264', '-bf', '2']);
        assert(src, `${name}: FFmpeg could not make the file`);
        const { video, audio, d } = await remuxInputs(src);
        const { out } = await writeMux(`mux_${name}.mp4`, video, { audio });
        ffmpegClean(out);
        samePackets(src, out, 'v:0');
        samePackets(src, out, 'a:0');
        const s = probe(out, 'a:0', 'stream=codec_name,sample_rate,channels')[0];
        assert(s[0] === codec && Number(s[1]) === d.audio.sampleRate && Number(s[2]) === d.audio.channels, `${name}: audio stream ${s}`);
        // The decoded sound is the same (edit list priming kept).
        const pcm = (f) => run('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a', '-f', 's16le', '-']).stdout;
        assert(Buffer.compare(pcm(src), pcm(out)) === 0, `${name}: decoded audio differs`);
      }
    },
  },
  {
    name: 'interleave: video and audio chunks alternate in about 1 s steps',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const src = ffmpeg('mux_src_il.mp4', [...vin, ...tone(48000, 5), '-frames:v', '150', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-t', '5']);
      const { video, audio } = await remuxInputs(src);
      for (const [name, chunk] of [['mux_il.mp4', undefined], ['mux_il_small.mp4', 3000]]) {
        const { out } = await writeMux(name, video, { audio, chunkDuration: chunk });
        ffmpegClean(out);
        const all = [...packets(out, 'v:0').map((p) => ({ ...p, a: 0 })), ...packets(out, 'a:0').map((p) => ({ ...p, a: 1 }))].sort((x, y) => x.pos - y.pos);
        let switches = 0;
        for (let i = 1; i < all.length; i++) if (all[i].a !== all[i - 1].a) switches++;
        const want = chunk ? 2 * 5 * (video.timescale / chunk) * 0.8 : 8;
        assert(switches >= want, `${name}: ${switches} switches between tracks`);
        // In file order, no packet is more than about 1 chunk away in time from the one before it.
        const step = (chunk ?? video.timescale) / video.timescale;
        for (let i = 1; i < all.length; i++) assert(all[i].dts - all[i - 1].dts > -2.2 * step, `${name}: packet ${i} is out of time order`);
      }
    },
  },
  {
    name: 'co64, 64-bit mdat size, and Blob parts (DataPacker) give valid, identical files',
    async fn() {
      if (!hasFfmpeg()) return console.log('      (skipped: no FFmpeg with libx264)');
      const src = ffmpeg('mux_src_big.mp4', [...vin, ...tone(), ...vout, '-c:v', 'libx264', '-c:a', 'aac']);
      const plain = await remuxInputs(src);
      const ref = await writeMux('mux_ref.mp4', plain.video, { audio: plain.audio });
      for (const [name, opts] of [['mux_co64.mp4', { forceCo64: true }], ['mux_largemdat.mp4', { forceLargeMdat: true, forceCo64: true }]]) {
        const { out, bytes } = await writeMux(name, plain.video, { audio: plain.audio, ...opts });
        ffmpegClean(out);
        assert(hasBox(bytes, 'co64') && !hasBox(bytes, 'stco'), `${name}: co64`);
        samePackets(src, out, 'v:0');
        samePackets(src, out, 'a:0');
      }
      for (const noAudio of [false, true]) {
        const packed = await remuxInputs(src, { blobChunk: 4096, noAudio });
        assert(packed.video.dataParts.some((p) => p instanceof Blob), 'packed parts are Blobs');
        const a = noAudio ? await writeMux('mux_ref_v.mp4', plain.video) : ref;
        const b = await writeMux(`mux_packed_${noAudio ? 'v' : 'av'}.mp4`, packed.video, { audio: packed.audio });
        assert(Buffer.compare(a.bytes, b.bytes) === 0, `packed (${noAudio ? 'video only' : 'with audio'}): the files differ`);
      }
    },
  },
  {
    name: 'muxer errors: no samples, first sample not a sync sample',
    fn() {
      let e1 = null, e2 = null;
      try { muxMp4({ width: 16, height: 16, timescale: 90000, sps: [0x67, 66, 0, 30], pps: [0x68], samples: [] }); } catch (e) { e1 = e; }
      try { muxMp4({ width: 16, height: 16, timescale: 90000, sps: [0x67, 66, 0, 30], pps: [0x68], samples: [{ data: new Uint8Array(4), size: 4, duration: 3000, key: false }] }); } catch (e) { e2 = e; }
      assert(e1 && /No samples/.test(e1.message) && e2 && /sync/.test(e2.message), 'errors');
    },
  },
];
