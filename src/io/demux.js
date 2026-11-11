// MP4 / MOV reader (plan §3, §6.1). From neomosh src/mux/demux.js, with the audio track added.
// It gives the video decoder configuration and each sample (offset, size, display time, sync flag),
// so a VideoDecoder can decode every frame of the file, and the audio track for the pass-through
// copy into the export (D16). Not fragmented. It returns null for other files.

const MAX_MOOV = 64 * 1048576;

const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex2 = (v) => v.toString(16).padStart(2, '0');

// The boxes in b[from..to): [{ type, head (box start), start (content), end }].
function boxes(b, from, to) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = dv.getUint32(o);
    const type = str4(b, o + 4);
    let head = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type, head: o, start: o + head, end: o + size });
    o += size;
  }
  return out;
}

const child = (b, box, type) => boxes(b, box.start, box.end).find((x) => x.type === type);
const path = (b, box, ...types) => types.reduce((x, t) => (x ? child(b, x, t) : null), box);

// The top-level boxes of the file, read from their headers only.
async function topBoxes(blob) {
  const out = [];
  let o = 0;
  while (o + 8 <= blob.size) {
    const h = new Uint8Array(await blob.slice(o, Math.min(blob.size, o + 16)).arrayBuffer());
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    let head = 8;
    if (size === 1 && h.length >= 16) {
      size = Number(dv.getBigUint64(8));
      head = 16;
    } else if (size === 0) size = blob.size - o;
    if (size < head) break;
    out.push({ type: str4(h, 4), start: o + head, end: Math.min(blob.size, o + size) });
    o += size;
  }
  return out;
}

// The codec string and the description for the VideoDecoder, from the sample entry.
function videoCodecOf(b, entry) {
  const t = entry.type;
  const kids = boxes(b, entry.start + 78, entry.end); // after the VisualSampleEntry fields
  const k = (type) => kids.find((x) => x.type === type);
  if (t === 'avc1' || t === 'avc3') {
    const c = k('avcC');
    if (!c) return null;
    const d = b.slice(c.start, c.end);
    return { codec: `avc1.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`, description: d };
  }
  if (t === 'hvc1' || t === 'hev1') {
    const c = k('hvcC');
    if (!c) return null;
    const d = b.slice(c.start, c.end);
    const space = ['', 'A', 'B', 'C'][d[1] >> 6];
    const tier = (d[1] >> 5) & 1 ? 'H' : 'L';
    let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
    let rev = 0;
    for (let i = 0; i < 32; i++, compat >>>= 1) rev = ((rev << 1) | (compat & 1)) >>> 0;
    const cons = Array.from(d.subarray(6, 12));
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const parts = [`${t}.${space}${d[1] & 31}`, rev.toString(16), `${tier}${d[12]}`, ...cons.map((x) => x.toString(16).toUpperCase())];
    return { codec: parts.join('.'), description: d };
  }
  if (t === 'vp09') {
    const c = k('vpcC');
    if (!c) return null;
    const d = b.subarray(c.start + 4, c.end); // after version and flags
    return { codec: `vp09.${String(d[0]).padStart(2, '0')}.${String(d[1]).padStart(2, '0')}.${String(d[2] >> 4).padStart(2, '0')}`, description: null };
  }
  if (t === 'av01') {
    const c = k('av1C');
    if (!c) return null;
    const d = b.slice(c.start, c.end);
    const profile = d[1] >> 5, level = d[1] & 31, tier = d[2] >> 7 ? 'H' : 'M';
    const depth = (d[2] >> 6) & 1 ? ((d[2] >> 5) & 1 ? 12 : 10) : 8;
    return { codec: `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`, description: d };
  }
  return null;
}

// MPEG-4 descriptor (ISO/IEC 14496-1): tag, size (1-4 bytes of 7 bits), content start.
function descriptor(b, o, end) {
  if (o + 2 > end) return null;
  const tag = b[o++];
  let size = 0;
  for (let i = 0; i < 4 && o < end; i++) {
    const v = b[o++];
    size = (size << 7) | (v & 127);
    if (!(v & 128)) break;
  }
  return { tag, start: o, end: Math.min(end, o + size) };
}

// esds -> { oti (objectTypeIndication), asc (AudioSpecificConfig bytes or null) }.
function parseEsds(b, esds) {
  const es = descriptor(b, esds.start + 4, esds.end); // after version and flags
  if (!es || es.tag !== 3) return null;
  const flags = b[es.start + 2];
  let o = es.start + 3;
  if (flags & 0x80) o += 2; // dependsOn_ES_ID
  if (flags & 0x40) o += 1 + b[o]; // URL
  if (flags & 0x20) o += 2; // OCR_ES_Id
  const dc = descriptor(b, o, es.end);
  if (!dc || dc.tag !== 4) return null;
  const oti = b[dc.start];
  const dsi = descriptor(b, dc.start + 13, dc.end);
  return { oti, asc: dsi && dsi.tag === 5 ? b.slice(dsi.start, dsi.end) : null };
}

// The audio sample entry: { type, codec, channels, sampleSize, sampleRate, config, description }.
// config: the raw codec box (esds or dOps, with its header), for the muxer to copy (plan §3).
function audioCodecOf(b, entry) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = entry.type;
  const version = dv.getUint16(entry.start + 8); // QuickTime sound description version (MOV)
  const channels = dv.getUint16(entry.start + 16);
  const sampleSize = dv.getUint16(entry.start + 18);
  let sampleRate = dv.getUint32(entry.start + 24) >>> 16;
  let kidsFrom = entry.start + 28;
  if (version === 1) kidsFrom += 16;
  else if (version === 2) {
    kidsFrom += 36;
    sampleRate = Math.round(dv.getFloat64(entry.start + 32));
  }
  let kids = boxes(b, kidsFrom, entry.end);
  const wave = kids.find((x) => x.type === 'wave'); // MOV: the codec box can be in a 'wave' box
  if (wave) kids = kids.concat(boxes(b, wave.start, wave.end));
  const k = (type) => kids.find((x) => x.type === type);
  if (t === 'mp4a') {
    const esds = k('esds');
    if (!esds) return null;
    const e = parseEsds(b, esds);
    if (!e) return null;
    let codec = `mp4a.${hex2(e.oti)}`;
    if (e.oti === 0x40 && e.asc && e.asc.length) {
      let aot = e.asc[0] >> 3;
      if (aot === 31 && e.asc.length > 1) aot = 32 + (((e.asc[0] & 7) << 3) | (e.asc[1] >> 5));
      codec += `.${aot}`;
    }
    return { type: t, codec, channels, sampleSize, sampleRate, config: b.slice(esds.head, esds.end), description: e.asc };
  }
  if (t === 'Opus') {
    const dops = k('dOps');
    if (!dops) return null;
    return { type: t, codec: 'opus', channels, sampleSize, sampleRate: 48000, config: b.slice(dops.head, dops.end), description: null };
  }
  return null;
}

// tkhd matrix -> 0, 90, 180, or 270 (clockwise, the way a player turns the picture).
function rotationOf(b, tkhd) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const m = tkhd.start + (b[tkhd.start] === 1 ? 52 : 40);
  const a = dv.getInt32(m), bb = dv.getInt32(m + 4);
  if (a === 0 && bb > 0) return 90;
  if (a < 0 && bb === 0) return 180;
  if (a === 0 && bb < 0) return 270;
  return 0;
}

// The sample table of a track: { timescale, entry, offsets, sizes, dts, cto, durations, sync, shift }
// or null. shift: the media time where the presentation starts (edit list).
function sampleTable(b, trak) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const mdhd = path(b, trak, 'mdia', 'mdhd');
  const stbl = path(b, trak, 'mdia', 'minf', 'stbl');
  if (!mdhd || !stbl) return null;
  const timescale = dv.getUint32(mdhd.start + (b[mdhd.start] === 1 ? 20 : 12));
  const stsd = child(b, stbl, 'stsd');
  const entry = stsd && boxes(b, stsd.start + 8, stsd.end)[0];
  if (!entry || !timescale) return null;

  // Sample sizes.
  const stsz = child(b, stbl, 'stsz');
  if (!stsz) return null;
  const fixed = dv.getUint32(stsz.start + 4), count = dv.getUint32(stsz.start + 8);
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.start + 12 + 4 * i);
  // Chunk offsets and samples per chunk -> sample offsets.
  const stco = child(b, stbl, 'stco'), co64 = child(b, stbl, 'co64'), stsc = child(b, stbl, 'stsc');
  if ((!stco && !co64) || !stsc) return null;
  const co = stco || co64;
  const nChunks = dv.getUint32(co.start + 4);
  const chunkOff = (i) => (stco ? dv.getUint32(co.start + 8 + 4 * i) : Number(dv.getBigUint64(co.start + 8 + 8 * i)));
  const scN = dv.getUint32(stsc.start + 4);
  const offsets = new Array(count);
  let s = 0;
  for (let e = 0; e < scN && s < count; e++) {
    const first = dv.getUint32(stsc.start + 8 + 12 * e) - 1;
    const per = dv.getUint32(stsc.start + 12 + 12 * e);
    const last = e + 1 < scN ? dv.getUint32(stsc.start + 8 + 12 * (e + 1)) - 1 : nChunks;
    for (let c = first; c < last && s < count; c++) {
      let o = chunkOff(c);
      for (let j = 0; j < per && s < count; j++, s++) {
        offsets[s] = o;
        o += sizes[s];
      }
    }
  }
  if (s < count) return null;
  // Decode times and durations, composition offsets, the edit list start.
  const stts = child(b, stbl, 'stts'), ctts = child(b, stbl, 'ctts'), stss = child(b, stbl, 'stss');
  if (!stts) return null;
  const dts = new Array(count);
  const durations = new Array(count);
  let t = 0, k = 0, d = 0;
  for (let e = 0, n = dv.getUint32(stts.start + 4); e < n; e++) {
    const c = dv.getUint32(stts.start + 8 + 8 * e);
    d = dv.getUint32(stts.start + 12 + 8 * e);
    for (let j = 0; j < c && k < count; j++, k++, t += d) {
      dts[k] = t;
      durations[k] = d;
    }
  }
  for (; k < count; k++, t += d) {
    dts[k] = t;
    durations[k] = d;
  }
  const cto = new Array(count).fill(0);
  if (ctts) {
    k = 0;
    for (let e = 0, n = dv.getUint32(ctts.start + 4); e < n; e++) {
      const c = dv.getUint32(ctts.start + 8 + 8 * e), o = dv.getInt32(ctts.start + 12 + 8 * e);
      for (let j = 0; j < c && k < count; j++, k++) cto[k] = o;
    }
  }
  let shift = 0;
  const elst = path(b, trak, 'edts', 'elst');
  if (elst) {
    const v1 = b[elst.start] === 1;
    const n = dv.getUint32(elst.start + 4);
    for (let e = 0; e < n; e++) {
      const o = elst.start + 8 + e * (v1 ? 20 : 12);
      const mt = v1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
      if (mt >= 0) {
        shift = mt;
        break;
      }
    }
  }
  const sync = stss ? new Set(Array.from({ length: dv.getUint32(stss.start + 4) }, (_, i) => dv.getUint32(stss.start + 8 + 4 * i) - 1)) : null;
  return { timescale, entry, offsets, sizes, dts, cto, durations, sync, shift, count };
}

const handlerOf = (b, trak) => {
  const hdlr = path(b, trak, 'mdia', 'hdlr');
  return hdlr ? str4(b, hdlr.start + 8) : '';
};

// blob: the file. Returns null, or:
// { codec, description, codedWidth, codedHeight, rotation, timescale, mediaTime, samples, durationUs, audio }
// samples (decode order): [{ offset, size, us (display time, microseconds), key, dts, duration, cto }].
// dts, duration, cto: in timescale units. mediaTime: the edit list start.
// audio: null, or { type, codec, channels, sampleSize, sampleRate, config, description, timescale,
//   mediaTime (edit list start, in timescale units), samples: [{ offset, size, dts, duration, us }],
//   durationUs }. us: the presentation time (dts - mediaTime) in microseconds.
export async function demuxMp4(blob) {
  let tops;
  try {
    tops = await topBoxes(blob);
  } catch {
    return null;
  }
  const moovTop = tops.find((x) => x.type === 'moov');
  if (!moovTop || moovTop.end - moovTop.start > MAX_MOOV) return null;
  if (tops.some((x) => x.type === 'moof')) return null; // fragmented: not supported
  const b = new Uint8Array(await blob.slice(moovTop.start, moovTop.end).arrayBuffer());
  const dv = new DataView(b.buffer);
  const traks = boxes(b, 0, b.length).filter((x) => x.type === 'trak');

  let video = null;
  for (const trak of traks) {
    if (handlerOf(b, trak) !== 'vide') continue;
    const tkhd = child(b, trak, 'tkhd');
    const st = tkhd && sampleTable(b, trak);
    if (!st) continue;
    const { entry, count, timescale } = st;
    const codec = videoCodecOf(b, entry);
    if (!codec) return null;
    const codedWidth = dv.getUint16(entry.start + 24), codedHeight = dv.getUint16(entry.start + 26);
    const samples = new Array(count);
    let maxUs = 0;
    for (let i = 0; i < count; i++) {
      const us = Math.round(((st.dts[i] + st.cto[i] - st.shift) * 1e6) / timescale);
      samples[i] = { offset: st.offsets[i], size: st.sizes[i], us, key: st.sync ? st.sync.has(i) : true, dts: st.dts[i], duration: st.durations[i], cto: st.cto[i] };
      maxUs = Math.max(maxUs, us);
    }
    if (!count || !samples[0].key) return null;
    video = { ...codec, codedWidth, codedHeight, rotation: rotationOf(b, tkhd), timescale, mediaTime: st.shift, samples, durationUs: maxUs };
    break;
  }
  if (!video) return null;

  let audio = null;
  for (const trak of traks) {
    if (handlerOf(b, trak) !== 'soun') continue;
    const st = sampleTable(b, trak);
    const a = st && st.count && audioCodecOf(b, st.entry);
    if (!a) continue;
    const ts = st.timescale;
    const samples = new Array(st.count);
    for (let i = 0; i < st.count; i++) {
      samples[i] = { offset: st.offsets[i], size: st.sizes[i], dts: st.dts[i], duration: st.durations[i], us: Math.round(((st.dts[i] - st.shift) * 1e6) / ts) };
    }
    const end = st.dts[st.count - 1] + st.durations[st.count - 1] - st.shift;
    audio = { ...a, timescale: ts, mediaTime: st.shift, samples, durationUs: Math.round((end * 1e6) / ts) };
    break;
  }
  video.audio = audio;
  return video;
}

// The source rectangle (frame coordinates) and the drawing transform for a crop in display
// coordinates of a frame that is shown turned by 'rotation' degrees (clockwise). fw, fh: the frame
// size (not turned). c: { sx, sy, sw, sh } in display coordinates. w, h: the output size.
// Returns { sx, sy, sw, sh, m: [a, b, c, d, e, f], dw, dh } for setTransform(...m) and drawImage(frame,
// sx, sy, sw, sh, 0, 0, dw, dh).
export function turnedCrop(rotation, fw, fh, c, w, h) {
  switch (rotation) {
    case 90:
      return { sx: c.sy, sy: fh - c.sx - c.sw, sw: c.sh, sh: c.sw, m: [0, 1, -1, 0, w, 0], dw: h, dh: w };
    case 180:
      return { sx: fw - c.sx - c.sw, sy: fh - c.sy - c.sh, sw: c.sw, sh: c.sh, m: [-1, 0, 0, -1, w, h], dw: w, dh: h };
    case 270:
      return { sx: fw - c.sy - c.sh, sy: c.sx, sw: c.sh, sh: c.sw, m: [0, -1, 1, 0, 0, h], dw: h, dh: w };
    default:
      return { sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh, m: [1, 0, 0, 1, 0, 0], dw: w, dh: h };
  }
}
