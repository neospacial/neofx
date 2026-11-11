// Presets (plan §12.5): built-in looks (both modes and the cutout modes), and preset files.
// File: { app: 'neofx', version, settings, assets: { mapImage, matte } } (PNG data URLs). A video
// map is stored by its file name only: at load, the app asks for the file.

import { DEFAULTS, clone } from './settings.js';

// Deep merge of plain objects (arrays are values).
export function merge(base, over) {
  const out = clone(base);
  const walk = (o, v) => {
    for (const [k, x] of Object.entries(v || {})) {
      if (x && typeof x === 'object' && !Array.isArray(x) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) walk(o[k], x);
      else o[k] = clone(x);
    }
  };
  walk(out, over);
  return out;
}

// (more is merged deeply: { map: { anim } } keeps the map type.)
const m1 = (type, params = {}, time = {}, more = {}) => merge({ mode: 'timemap', map: { source: 'builtin', type, params: { [type]: params } }, timemap: { blend: true, ...time } }, more);
const m2 = (slit = {}, more = {}) => merge({ mode: 'slitscan', slitscan: slit }, more);

export const PRESETS = [
  { id: 'wave', name: 'Time wave', s: m1('linear', { angle: 90 }, { maxDelay: 30 }) },
  { id: 'ripple', name: 'Ripple', s: m1('rings', { count: 6, softness: 1 }, { maxDelay: 24 }) },
  { id: 'vortex', name: 'Vortex', s: m1('spiral', { arms: 3, tightness: 6 }, { maxDelay: 40 }) },
  { id: 'shatter', name: 'Shattered time', s: m1('voronoi', { scale: 5 }, { maxDelay: 45, blend: false }) },
  { id: 'blinds', name: 'Blinds', s: m1('stripes', { count: 12, angle: 0 }, { maxDelay: 20, blend: false }) },
  { id: 'fog', name: 'Time fog', s: m1('fbm', { scale: 3, octaves: 4 }, { maxDelay: 60 }, { map: { anim: { phaseSpeed: 0.01 } } }) },
  { id: 'echo', name: 'Motion echo', s: m1('motion', { gain: 6, frames: 2 }, { maxDelay: 20 }, { composite: { mode: 'blend', blend: 'screen', decay: 'linear' } }) },
  { id: 'ghost', name: 'Ghost subject', s: m1('subject', { subject: 1, background: 0 }, { maxDelay: 30 }, { cutout: { mode: 'overlay' } }) },
  { id: 'smear', name: 'Slit smear', s: m2({ source: 'line', time: false, angle: 90, x: 0.5 }) },
  { id: 'timeline', name: 'Slit timeline', s: m2({ source: 'line', time: true, rate: 1, angle: 90, x: 0.3 }) },
  { id: 'accel', name: 'Accelerated scan', s: m2({ source: 'line', time: true, rateType: 'accelerate', rate: 0.5, rateEnd: 6, angle: 0, y: 0.6 }, { look: { tint: true, tintColors: ['#ffffff', '#3060ff'] } }) },
  { id: 'trail', name: 'Subject trail', s: m2({ source: 'edge', edgeAngle: 180, rate: 2, maxAgeEdge: 90 }, { cutout: { mode: 'scan' }, composite: { decay: 'linear' } }) },
  { id: 'afterimage', name: 'Afterimage', s: m2({ source: 'edge', edgeAngle: 90, rate: 1, maxAgeEdge: 60 }, { cutout: { mode: 'overlay' }, look: { tint: true, tintColors: ['#ff60c0', '#4020ff'] } }) },
  // More looks.
  { id: 'kaleido', name: 'Kaleidoscope', s: m1('mirrored', { angle: 45 }, { maxDelay: 36 }, { map: { adjust: { tileX: 3, tileY: 3, mirrorTile: true } } }) },
  { id: 'pulse', name: 'Pulse rings', s: m1('rings', { count: 3, softness: 1 }, { maxDelay: 40 }, { map: { anim: { phaseSpeed: 0.02 } }, look: { tint: true, tintColors: ['#ffffff', '#eee100', '#ff3d7f'], tintAmount: 0.6 } }) },
  { id: 'twister', name: 'Twister', s: m1('angular', { turns: 2 }, { maxDelay: 48 }, { map: { anim: { rotSpeed: 2 } } }) },
  { id: 'liquid', name: 'Liquid time', s: m1('sine', { fx: 3, fy: 2 }, { maxDelay: 40 }, { map: { anim: { phaseSpeed: 0.015 } } }) },
  { id: 'tunnel', name: 'Time tunnel', s: m1('radial', { radius: 0.9 }, { maxDelay: 60 }, { look: { ageBrightness: 0.35 } }) },
  { id: 'mosaic', name: 'Time mosaic', s: m1('blocks', { bw: 48, bh: 48 }, { maxDelay: 60, steps: 8, blend: false }, { map: { anim: { seedEvery: 30 } } }) },
  { id: 'glitch', name: 'Scanline glitch', s: m1('rows', { size: 6 }, { maxDelay: 24, blend: false }, { map: { anim: { seedEvery: 4 } }, look: { offset: 6, offsetAngle: 0 } }) },
  { id: 'dither', name: 'Dither time', s: m1('bayer', { matrix: 3 }, { maxDelay: 16, blend: false }) },
  { id: 'thermal', name: 'Thermal echo', s: m1('self', {}, { maxDelay: 45 }, { look: { tint: true, tintColors: ['#2b00ff', '#ff2d55', '#eee100'] } }) },
  { id: 'finish', name: 'Photo finish', s: m2({ source: 'line', time: true, rate: 2, angle: 90, x: 0.5 }, { look: { tint: true, tintColors: ['#ffffff', '#eee100'], tintAmount: 0.5 } }) },
  { id: 'melt', name: 'Melt', s: m2({ source: 'line', time: true, rateType: 'decelerate', rate: 4, rateEnd: 0.5, angle: 0, y: 0.4 }) },
  { id: 'neon', name: 'Neon trail', s: m2({ source: 'edge', edgeAngle: 270, rate: 3, maxAgeEdge: 120 }, { cutout: { mode: 'scan' }, composite: { mode: 'blend', blend: 'screen', decay: 'exp' }, look: { tint: true, tintColors: ['#eee100', '#ff2d55', '#2b00ff'] } }) },
];

// The settings of a preset: on the defaults, keeping the cutout method settings, the custom maps,
// and the view of the user (a preset is a look, not the footage setup).
export function applyPreset(current, preset) {
  const s = merge(DEFAULTS, preset.s);
  s.view = current.view;
  s.timemap.perfectLoop = !!(current.timemap && current.timemap.perfectLoop); // an output choice, not a look
  const keep = clone(current.cutout);
  s.cutout = { ...keep, mode: (preset.s.cutout && preset.s.cutout.mode) || 'off' };
  if (s.cutout.mode === 'scan' && s.mode !== 'slitscan') s.cutout.mode = 'overlay';
  s.map.image = clone(current.map.image);
  s.map.video = clone(current.map.video);
  return s;
}

export function presetFile(settings, version, assets = {}) {
  return { app: 'neofx', version, settings: clone(settings), assets };
}

// Read a preset file (text). Returns { settings, assets } on the defaults (older or partial files
// get the default of each missing setting), or throws.
export function parsePresetFile(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('This is not a neofx preset file.');
  }
  if (!o || o.app !== 'neofx' || !o.settings || typeof o.settings !== 'object') throw new Error('This is not a neofx preset file.');
  return { settings: merge(DEFAULTS, o.settings), assets: o.assets || {}, version: o.version };
}

// 'data:image/png;base64,...' -> Blob (no network: decode the base64 here).
export function dataUrlBlob(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(url || '');
  if (!m) throw new Error('Not a data URL.');
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: m[1] });
}
