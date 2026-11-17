// Presets (plan §12.5): built-in looks (both modes and the cutout modes), and preset files.
// File: { app: 'neofx', version, settings, assets: { mapImage, matte } } (PNG data URLs). A video
// map is stored by its file name only: at load, the app asks for the file.

import { DEFAULTS, clone, migrateSettings } from './settings.js';

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
// Datamosh: the encoder look (the session size and frame rate stay those of the user).
const m3 = (look = {}, more = {}) => merge({ mode: 'datamosh', mosh: look }, more);
const tint = (colors, amount = 1) => ({ look: { tint: true, tintColors: colors, tintAmount: amount } });

// The groups of the gallery (the mode of each preset).
export const PRESET_GROUPS = [['timemap', 'Time Map'], ['slitscan', 'Slit Scan'], ['datamosh', 'Datamosh']];

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
  { id: 'twistscan', name: 'Twisted scan', s: m2({ source: 'line', time: true, rate: 2, angle: 90, x: 0.5, y: 0.5, warp: { twist: 140, drift: 0, spread: 0, wave: 0 } }) },
  { id: 'ribbon', name: 'Wavy ribbon', s: m2({ source: 'line', time: true, rate: 1.5, angle: 90, x: 0.25, warp: { twist: 0, drift: 0, spread: 0.6, wave: 36, waveLength: 220, waveSpeed: 3 } }) },
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
  // Time Map: more maps and composites.
  { id: 'shutter', name: 'Rolling shutter', s: m1('linear', { angle: 90 }, { maxDelay: 8 }) },
  { id: 'stutter', name: 'Stutter steps', s: m1('linear', { angle: 0 }, { maxDelay: 32, steps: 4, blend: false }) },
  { id: 'diamond', name: 'Diamond time', s: m1('box', { size: 0.6, roundness: 0 }, { maxDelay: 40, steps: 6, blend: false }) },
  { id: 'corners', name: 'Corner clock', s: m1('corners', { tl: 0, tr: 0.33, bl: 0.66, br: 1 }, { maxDelay: 45 }) },
  { id: 'checker', name: 'Checker time', s: m1('checker', { cells: 6 }, { maxDelay: 20, blend: false }) },
  { id: 'smoke', name: 'Ridged smoke', s: m1('ridged', { scale: 3, octaves: 5 }, { maxDelay: 50 }, { map: { anim: { phaseSpeed: 0.008 } }, ...tint(['#ffffff', '#8a7cff'], 0.5) }) },
  { id: 'cells', name: 'Cell echo', s: m1('worley', { scale: 5, metric: 1 }, { maxDelay: 36 }, { map: { anim: { seedEvery: 45 } } }) },
  { id: 'galaxy', name: 'Spiral galaxy', s: m1('spiral', { arms: 5, tightness: 12 }, { maxDelay: 50 }, { map: { anim: { rotSpeed: 1 } }, ...tint(['#ffffff', '#ff7a00', '#5b2bff'], 0.7) }) },
  { id: 'heartbeat', name: 'Heartbeat', s: m1('radial', { radius: 0.8 }, { maxDelay: 30 }, { map: { anim: { pulseAmount: 0.35, pulsePeriod: 30 } } }) },
  { id: 'difference', name: 'Time difference', s: m1('linear', { angle: 0, width: 4 }, { maxDelay: 6 }, { composite: { mode: 'blend', blend: 'difference' } }) },
  { id: 'prism', name: 'Prism', s: m1('radial', { radius: 1 }, { maxDelay: 12 }, { look: { offset: 14, offsetAngle: 0, tint: true, tintColors: ['#ffffff', '#00e5ff', '#ff2bd6'], tintAmount: 0.8 } }) },
  { id: 'exposure', name: 'Long exposure', s: m1('motion', { gain: 10, frames: 4 }, { maxDelay: 40 }, { composite: { mode: 'blend', blend: 'lighten', decay: 'exp' } }) },
  { id: 'halo', name: 'Subject halo', s: m1('subjectdist', { falloff: 140 }, { maxDelay: 40 }, { cutout: { mode: 'overlay' }, ...tint(['#ffffff', '#eee100', '#ff3d7f'], 0.6) }) },
  // Slit Scan: rates and trail shapes.
  { id: 'stretch', name: 'Time stretch', s: m2({ source: 'line', time: true, rate: 0.25, angle: 90, x: 0.5, sampling: 'blend' }) },
  { id: 'warpspeed', name: 'Warp speed', s: m2({ source: 'line', time: true, rateType: 'exponential', rate: 0.5, rateEnd: 16, angle: 90, x: 0.5, warp: { spread: 2 } }, tint(['#ffffff', '#3d7bff'], 0.6)) },
  { id: 'spiralscan', name: 'Spiral scan', s: m2({ source: 'line', time: true, rate: 1, angle: 90, x: 0.5, y: 0.5, warp: { twist: 540 } }) },
  { id: 'sidewinder', name: 'Sidewinder', s: m2({ source: 'line', time: true, rate: 1.5, angle: 0, y: 0.35, warp: { drift: 0.6, wave: 20, waveLength: 160, waveSpeed: 2 } }) },
  { id: 'horizon', name: 'Horizon melt', s: m2({ source: 'line', time: true, rate: 1, angle: 0, y: 0.5, sampling: 'blend' }, { composite: { mode: 'blend', blend: 'normal', decay: 'linear' } }) },
  { id: 'diagonal', name: 'Diagonal scan', s: m2({ source: 'line', time: true, rate: 2, angle: 45, x: 0.3, y: 0.3 }, tint(['#ffffff', '#ff7a00'], 0.5)) },
  { id: 'frozen', name: 'Frozen wave', s: m2({ source: 'line', time: false, angle: 90, x: 0.6, warp: { wave: 24, waveLength: 90, waveSpeed: 4 } }) },
  { id: 'smoketrail', name: 'Smoke trail', s: m2({ source: 'edge', edgeAngle: 270, rate: 2, maxAgeEdge: 90, warp: { spread: 1, wave: 18, waveLength: 140, waveSpeed: 2 } }, { cutout: { mode: 'scan' }, composite: { mode: 'blend', blend: 'screen', decay: 'exp' } }) },
  { id: 'comet', name: 'Comet', s: m2({ source: 'edge', edgeAngle: 180, rate: 4, maxAgeEdge: 60 }, { cutout: { mode: 'overlay' }, composite: { decay: 'linear' }, ...tint(['#ffffff', '#2b6bff']) }) },
  // Datamosh: encoder looks (neomosh settings) for the next clip.
  { id: 'moshclassic', name: 'Classic mosh', s: m3({ qp: 30, searchRange: 32, precision: 'quarter', skipBias: 50, heal: 'low', denoise: 'low' }) },
  { id: 'moshmelt', name: 'Pixel melt', s: m3({ qp: 32, searchRange: 64, precision: 'quarter', skipBias: 85, heal: 'off', denoise: 'high' }) },
  { id: 'moshsmear', name: 'Long smear', s: m3({ qp: 30, searchRange: 64, precision: 'half', skipBias: 100, heal: 'off', denoise: 'low' }) },
  { id: 'moshblocks', name: 'Block storm', s: m3({ qp: 40, searchRange: 16, precision: 'full', skipBias: 30, heal: 'off', denoise: 'off' }) },
  { id: 'moshcrunch', name: 'Crunch', s: m3({ qp: 44, searchRange: 8, precision: 'full', skipBias: 60, heal: 'off', denoise: 'off' }) },
  { id: 'moshvhs', name: 'Lo-fi tape', s: m3({ qp: 38, searchRange: 32, precision: 'half', skipBias: 50, heal: 'low', denoise: 'off' }) },
  { id: 'moshdrift', name: 'Clean drift', s: m3({ qp: 22, searchRange: 32, precision: 'quarter', skipBias: 50, heal: 'high', denoise: 'low' }) },
  { id: 'moshbleed', name: 'Soft bleed', s: m3({ qp: 26, searchRange: 64, precision: 'quarter', skipBias: 0, heal: 'high', denoise: 'high' }) },
];

// The settings of a preset: on the defaults, keeping the cutout method settings, the custom maps,
// and the view of the user (a preset is a look, not the footage setup).
export function applyPreset(current, preset) {
  const s = merge(DEFAULTS, preset.s);
  s.view = current.view;
  s.loopPixels = !!migrateSettings(clone(current)).loopPixels; // an output choice, not a look
  const keep = clone(current.cutout);
  s.cutout = { ...keep, mode: (preset.s.cutout && preset.s.cutout.mode) || 'off' };
  if (s.cutout.mode === 'scan' && s.mode !== 'slitscan') s.cutout.mode = 'overlay';
  s.map.image = clone(current.map.image);
  s.map.video = clone(current.map.video);
  // Datamosh: a Datamosh preset sets the encoder look; the session size, frame rate, Guide and Mosh
  // preview stay (the setup of the user). The other presets keep the Datamosh settings as they are.
  const cm = current.mosh || DEFAULTS.mosh;
  if (s.mode === 'datamosh') Object.assign(s.mosh, { size: cm.size, fps: cm.fps, guide: cm.guide, preview: cm.preview });
  else s.mosh = clone(cm);
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
  return { settings: merge(DEFAULTS, migrateSettings(o.settings)), assets: o.assets || {}, version: o.version };
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
