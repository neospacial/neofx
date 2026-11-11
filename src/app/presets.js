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

const m1 = (type, params = {}, time = {}, more = {}) => ({ mode: 'timemap', map: { source: 'builtin', type, params: { [type]: params } }, timemap: { blend: true, ...time }, ...more });
const m2 = (slit = {}, more = {}) => ({ mode: 'slitscan', slitscan: slit, ...more });

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
];

// The settings of a preset: on the defaults, keeping the cutout method settings, the custom maps,
// and the view of the user (a preset is a look, not the footage setup).
export function applyPreset(current, preset) {
  const s = merge(DEFAULTS, preset.s);
  s.view = current.view;
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
