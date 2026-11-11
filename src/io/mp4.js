// MP4 muxer (plan §3, §11.2). From neomosh src/mux/mp4.js, with an audio track added.
// Layout: ftyp, moov, mdat. The moov comes first, so all sample sizes must be known first.
// The file is returned as a list of parts (for a Blob). There is no one large buffer.
// co64 when a chunk offset is 4 GB or more, else stco. stss lists only the video sync samples.
// With audio, the video and audio chunks are interleaved by time (default 1 s chunks).

const MOVIE_TIMESCALE = 1000;

// Big-endian byte builder.
class Bytes {
  constructor() {
    this.a = [];
  }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { this.a.push((v >>> 8) & 255, v & 255); return this; }
  u24(v) { this.a.push((v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  u32(v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  u64(v) { return this.u32(Math.floor(v / 4294967296)).u32(v >>> 0); }
  str(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 255); return this; }
  bytes(b) { for (let i = 0; i < b.length; i++) this.a.push(b[i]); return this; }
  zeros(n) { for (let i = 0; i < n; i++) this.a.push(0); return this; }
  get length() { return this.a.length; }
}

// A box: size, type, then the content (Bytes or Uint8Array of child boxes).
function box(type, ...content) {
  let len = 8;
  for (const c of content) len += c.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const c of content) {
    out.set(c instanceof Bytes ? c.a : c, o);
    o += c.length;
  }
  return out;
}

function fullBox(type, version, flags, ...content) {
  return box(type, new Bytes().u8(version).u24(flags), ...content);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function ftyp() {
  return box('ftyp', new Bytes().str('isom').u32(512).str('isom').str('iso2').str('avc1').str('mp41'));
}

function mvhd(duration, nextTrackId) {
  const b = new Bytes().u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(duration)
    .u32(0x00010000).u16(0x0100).zeros(10);
  for (const m of MATRIX) b.u32(m);
  return fullBox('mvhd', 0, 0, b.zeros(24).u32(nextTrackId));
}

function tkhd(trackId, duration, width, height, isAudio) {
  const b = new Bytes().u32(0).u32(0).u32(trackId).u32(0).u32(duration).zeros(8)
    .u16(0).u16(isAudio ? 1 : 0).u16(isAudio ? 0x0100 : 0).u16(0);
  for (const m of MATRIX) b.u32(m);
  return fullBox('tkhd', 0, 3, b.u32(width * 65536).u32(height * 65536));
}

function mdhd(timescale, duration) {
  return fullBox('mdhd', 0, 0, new Bytes().u32(0).u32(0).u32(timescale).u32(duration).u16(0x55c4).u16(0));
}

function hdlr(type, name) {
  return fullBox('hdlr', 0, 0, new Bytes().u32(0).str(type).zeros(12).str(name).u8(0));
}

function dinf() {
  return box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1), fullBox('url ', 0, 1)));
}

// avcC (ISO/IEC 14496-15 5.3.3.1) from one SPS and one PPS NAL unit (without start codes).
export function avcC(sps, pps) {
  return box('avcC', new Bytes().u8(1).u8(sps[1]).u8(sps[2]).u8(sps[3]).u8(0xff).u8(0xe1)
    .u16(sps.length).bytes(sps).u8(1).u16(pps.length).bytes(pps));
}

function avc1(v) {
  const b = new Bytes().zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height)
    .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).u16(0xffff);
  // colr nclx: BT.709 primaries, transfer, and matrix; limited range (plan §3, §11.3).
  const colr = box('colr', new Bytes().str('nclx').u16(1).u16(1).u16(1).u8(0));
  const pasp = box('pasp', new Bytes().u32(1).u32(1));
  // v.avcc: an existing avcC record (for example from a VideoEncoder), else made from the SPS and PPS.
  const c = v.avcc ? box('avcC', v.avcc) : avcC(v.sps, v.pps);
  return box('avc1', b, c, colr, pasp);
}

// AudioSampleEntry (ISO/IEC 14496-12 12.2.3, version 0) with the codec box copied from the source
// (esds for AAC, dOps for Opus). a = { type: 'mp4a' | 'Opus', channels, sampleSize, sampleRate, config }.
function audioEntry(a) {
  const b = new Bytes().zeros(6).u16(1).zeros(8).u16(a.channels || 2).u16(a.sampleSize || 16)
    .u16(0).u16(0).u32(((a.sampleRate & 0xffff) << 16) >>> 0);
  return box(a.type, b, a.config);
}

// Runs of equal values: [[count, value], ...].
function runs(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

function stts(durations) {
  const r = runs(durations);
  const b = new Bytes().u32(r.length);
  for (const [n, d] of r) b.u32(n).u32(d);
  return fullBox('stts', 0, 0, b);
}

// Composition offsets (ctts version 0): display time - decode time of each sample, for an encoder
// with B-frames (frames in decode order, not display order).
function ctts(offsets) {
  const r = runs(offsets);
  const b = new Bytes().u32(r.length);
  for (const [n, o] of r) b.u32(n).u32(o);
  return fullBox('ctts', 0, 0, b);
}

// Edit list: the presentation starts at mediaTime (the delay that the composition offsets add, or
// the audio priming of the source), so the first picture or sound plays at time 0.
function edts(segmentDur, mediaTime) {
  return box('edts', fullBox('elst', 0, 0, new Bytes().u32(1).u32(segmentDur).u32(mediaTime).u16(1).u16(0)));
}

function stss(keys) {
  const b = new Bytes().u32(keys.length);
  for (const k of keys) b.u32(k);
  return fullBox('stss', 0, 0, b);
}

function stsc(chunkSizes) {
  const r = [];
  chunkSizes.forEach((n, i) => {
    if (!r.length || r[r.length - 1][1] !== n) r.push([i + 1, n]);
  });
  const b = new Bytes().u32(r.length);
  for (const [first, n] of r) b.u32(first).u32(n).u32(1);
  return fullBox('stsc', 0, 0, b);
}

function stsz(sizes) {
  const b = new Bytes().u32(0).u32(sizes.length);
  for (const s of sizes) b.u32(s);
  return fullBox('stsz', 0, 0, b);
}

function chunkOffsets(offsets, use64) {
  const b = new Bytes().u32(offsets.length);
  for (const o of offsets) (use64 ? b.u64(o) : b.u32(o));
  return fullBox(use64 ? 'co64' : 'stco', 0, 0, b);
}

// The sample data of an export, packed into Blobs of about chunkBytes as it comes. A Blob can be kept
// by the browser out of the JavaScript memory (on disk when it is large), so a long export does not
// hold all its data in RAM. chunkBytes 0: no packing (the arrays, for tests).
export class DataPacker {
  constructor(chunkBytes = 0) {
    this.chunk = chunkBytes;
    this.parts = [];
    this.pending = [];
    this.pendingBytes = 0;
  }

  add(data) {
    if (!this.chunk) {
      this.parts.push(data);
      return;
    }
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes >= this.chunk) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  // The parts in file order (Blobs and arrays).
  done() {
    this.flush();
    return this.parts;
  }
}

// Split the samples of a track into chunks of about chunkDur (timescale units).
// Returns [{ first, n, bytes, byteStart, t (start time in seconds) }].
function makeChunks(samples, ts, chunkDur) {
  const out = [];
  let first = 0, n = 0, dur = 0, bytes = 0, byteStart = 0, t = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    n++;
    dur += s.duration;
    bytes += s.size;
    if (dur >= chunkDur || i === samples.length - 1) {
      out.push({ first, n, bytes, byteStart, t: t / ts });
      t += dur;
      byteStart += bytes;
      first = i + 1;
      n = dur = bytes = 0;
    }
  }
  return out;
}

// The data of one chunk, as parts. With dataParts (the track data in sample order), a slice of them.
function chunkData(track, c, whole) {
  if (whole) return [whole.slice(c.byteStart, c.byteStart + c.bytes)];
  const out = [];
  for (let i = c.first; i < c.first + c.n; i++) out.push(track.samples[i].data);
  return out;
}

// Make the MP4 file.
// video = { width, height, timescale, sps, pps | avcc, samples: [{ data: Uint8Array | Blob, size, duration, key, cto }] }
// The samples are in decode order. duration: the decode time to the next sample. cto (optional): the
// composition offset (display time - decode time, >= 0). video.mediaTime: the edit list start (the
// largest delay), when the samples have composition offsets. video.dataParts (optional): the sample
// data in file order (from a DataPacker); then the samples need only their sizes.
// opts.audio (optional): { type: 'mp4a' | 'Opus', channels, sampleSize, sampleRate, config (the codec
//   box from demuxMp4), timescale, mediaTime, samples: [{ data, size, duration }], dataParts }.
// opts.chunkDuration: video chunk length in video timescale units (default 1 s). Audio chunks have
// the same length in seconds.
// opts.forceCo64, opts.forceLargeMdat: for tests only.
// Returns { parts, size }. parts: Uint8Array headers and the sample data, in file order.
export function muxMp4(video, opts = {}) {
  const samples = video.samples;
  if (!samples.length) throw new Error('No samples');
  const ts = video.timescale;
  const chunkDur = opts.chunkDuration ?? ts;
  const audio = opts.audio && opts.audio.samples.length ? opts.audio : null;

  const vChunks = makeChunks(samples, ts, chunkDur);
  const aChunks = audio ? makeChunks(audio.samples, audio.timescale, (chunkDur / ts) * audio.timescale) : [];
  // File order of the chunks: by start time; video first at the same time.
  const order = [...vChunks.map((c, i) => ({ c, i, a: false })), ...aChunks.map((c, i) => ({ c, i, a: true }))]
    .sort((x, y) => x.c.t - y.c.t || x.a - y.a);

  let mdatPayload = 0;
  for (const { c } of order) mdatPayload += c.bytes;
  const largeMdat = opts.forceLargeMdat || mdatPayload + 8 > 0xffffffff;
  const mdatHeader = largeMdat
    ? new Uint8Array([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, ...new Bytes().u64(mdatPayload + 16).a])
    : new Uint8Array([...new Bytes().u32(mdatPayload + 8).a, 0x6d, 0x64, 0x61, 0x74]);

  const durations = samples.map((s) => s.duration);
  const totalDur = durations.reduce((a, b) => a + b, 0);
  const movieDur = Math.round((totalDur * MOVIE_TIMESCALE) / ts);
  const reordered = samples.some((s) => s.cto);
  const keys = [];
  samples.forEach((s, i) => s.key && keys.push(i + 1));
  if (keys[0] !== 1) throw new Error('The first sample must be a sync sample');

  let aTotal = 0, aMovieDur = 0;
  if (audio) {
    for (const s of audio.samples) aTotal += s.duration;
    aMovieDur = Math.round(((aTotal - (audio.mediaTime || 0)) * MOVIE_TIMESCALE) / audio.timescale);
  }

  const head = ftyp();
  const build = (use64) => {
    // The chunk offsets depend on the moov size. The moov size depends only on use64.
    const vOff = vChunks.map(() => 0), aOff = aChunks.map(() => 0);
    const make = () => {
      const vStbl = box('stbl',
        fullBox('stsd', 0, 0, new Bytes().u32(1), avc1(video)),
        stts(durations), ...(reordered ? [ctts(samples.map((s) => s.cto || 0))] : []),
        stss(keys), stsc(vChunks.map((c) => c.n)), stsz(samples.map((s) => s.size)),
        chunkOffsets(vOff, use64));
      const vMinf = box('minf', fullBox('vmhd', 0, 1, new Bytes().zeros(8)), dinf(), vStbl);
      const vMdia = box('mdia', mdhd(ts, totalDur), hdlr('vide', 'neofx video'), vMinf);
      const traks = [box('trak', tkhd(1, movieDur, video.width, video.height, false),
        ...(reordered ? [edts(movieDur, video.mediaTime || 0)] : []), vMdia)];
      if (audio) {
        const aStbl = box('stbl',
          fullBox('stsd', 0, 0, new Bytes().u32(1), audioEntry(audio)),
          stts(audio.samples.map((s) => s.duration)), stsc(aChunks.map((c) => c.n)),
          stsz(audio.samples.map((s) => s.size)), chunkOffsets(aOff, use64));
        const aMinf = box('minf', fullBox('smhd', 0, 0, new Bytes().u16(0).u16(0)), dinf(), aStbl);
        const aMdia = box('mdia', mdhd(audio.timescale, aTotal), hdlr('soun', 'neofx audio'), aMinf);
        traks.push(box('trak', tkhd(2, aMovieDur, 0, 0, true),
          ...(audio.mediaTime ? [edts(aMovieDur, audio.mediaTime)] : []), aMdia));
      }
      return box('moov', mvhd(Math.max(movieDur, aMovieDur), traks.length + 1), ...traks);
    };
    let moov = make();
    let o = head.length + moov.length + mdatHeader.length;
    let last = 0;
    for (const x of order) {
      (x.a ? aOff : vOff)[x.i] = o;
      last = o;
      o += x.c.bytes;
    }
    moov = make();
    return { moov, lastOffset: last };
  };
  let r = build(!!opts.forceCo64);
  if (!opts.forceCo64 && r.lastOffset > 0xffffffff) r = build(true);

  const parts = [head, r.moov, mdatHeader];
  if (!audio) {
    // One track: the data is already in file order.
    if (video.dataParts) parts.push(...video.dataParts);
    else for (const s of samples) parts.push(s.data);
  } else {
    const vWhole = video.dataParts ? new Blob(video.dataParts) : null;
    const aWhole = audio.dataParts ? new Blob(audio.dataParts) : null;
    for (const x of order) parts.push(...chunkData(x.a ? audio : video, x.c, x.a ? aWhole : vWhole));
  }
  return { parts, size: head.length + r.moov.length + mdatHeader.length + mdatPayload };
}

// The data of packets ({ offset, size }, in file order) as one array. Packets that are near each
// other (the audio of an interleaved chunk) are read with one read.
export async function readPackets(file, list, gap = 262144, maxRun = 8 * 1048576) {
  const total = list.reduce((n, s) => n + s.size, 0);
  const out = new Uint8Array(total);
  let i = 0, o = 0;
  while (i < list.length) {
    const start = list[i].offset;
    let j = i, end = start + list[i].size;
    while (j + 1 < list.length && list[j + 1].offset >= end && list[j + 1].offset - end <= gap && list[j + 1].offset + list[j + 1].size - start <= maxRun) {
      j++;
      end = list[j].offset + list[j].size;
    }
    const buf = new Uint8Array(await file.slice(start, end).arrayBuffer());
    for (let k = i; k <= j; k++) {
      out.set(buf.subarray(list[k].offset - start, list[k].offset - start + list[k].size), o);
      o += list[k].size;
    }
    i = j + 1;
  }
  return out;
}
