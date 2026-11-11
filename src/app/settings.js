// The settings (plan §7.2 – §7.6). One plain object, so presets and undo (phase 11) can copy it.

import { defaultParams } from '../maps/builtin.js';

export const DEFAULTS = {
  mode: 'timemap', // 'timemap' | 'slitscan' (phase 7)
  view: 'result', // 'result' | 'original' | 'map' | 'mask'
  timemap: {
    maxDelay: 30, // frames (white); the store limits it to N - 1
    steps: 0, // 0 = smooth, else 2..64
    blend: true, // frame blend
  },
  map: {
    source: 'builtin', // 'builtin' | 'image' | 'video'
    type: 'linear', // a MAPS id (maps/builtin.js)
    params: defaultParams(), // the params of each built-in map
    image: { name: '', fit: 'fill', outside: 0, x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false }, // image and video maps
    video: { name: '', speed: 1, offset: 0, end: 'loop' },
    adjust: { invert: false, black: 0, white: 1, gamma: 1, contrast: 0, curve: 'linear', posterize: 0, blur: 0, tileX: 1, tileY: 1, mirrorTile: false, offsetX: 0, offsetY: 0 },
    anim: { phaseSpeed: 0, rotSpeed: 0, pulseAmount: 0, pulsePeriod: 60, seedEvery: 0 },
  },
  slitscan: {
    source: 'line', // 'line' | 'edge' (phase 9)
    x: 0.5, // a point on the line (0..1 of the frame)
    y: 0.5,
    angle: 90, // the direction of the line: 90° = vertical, the scan goes to the right
    flip: false, // turn the scan direction 180°
    width: 1, // slit width (px): the average across the line
    time: true, // Time On: pixels get older with the distance
    rateType: 'constant', // modes/slit.js RATE_TYPES
    rate: 1, // px/frame (at age 0)
    rateEnd: 4, // px/frame at Max age (not Constant)
    curve: 'easeIn', // the rate curve (rateType 'curve')
    maxAge: 600, // frames
    sampling: 'sharp', // 'sharp' (nearest frame) | 'blend' (mix 2 frames)
  },
  cutout: {
    mode: 'off', // 'off' | 'overlay' | 'scan' (Mode 2, phase 9) (plan §9.4)
    bgdiff: { on: true, lightTol: 0.5, threshold: 0.12, softness: 0.06, shadow: 0 },
    chroma: { on: false, key: '#00ff00', tolerance: 0.08, softness: 0.05, spill: 0.5 },
    luma: { on: false, low: 0.7, high: 1, softness: 0.05, invert: false },
    combine: 'union', // 'union' | 'intersect'
    plate: 'auto', // the clean plate: 'auto' (median) | 'frame' | 'image'
    open: 0, // px
    close: 0, // px
    fillHoles: 0, // % of the frame (0 = off)
    keepLargest: false,
    grow: 0, // px, −32 .. 32
    smooth: 0, // temporal smooth 0 .. 0.95
    hysteresis: false,
    tLow: 0.35,
    tHigh: 0.65,
    feather: 0, // px
    import: { on: false, name: '' }, // a mask video (plan §9.3)
  },
  subject: { blend: 'normal', opacity: 1, grow: 0, feather: 0, outline: 0, outlineColor: '#ffffff' }, // §10.4
  composite: {
    mode: 'replace', // effect composite: 'replace' | 'blend' (§10.1)
    blend: 'normal', // gpu/blend.js BLEND_MODES
    opacity: 1,
    linear: false, // blend in linear light
    decay: 'full', // 'full' | 'linear' | 'exp' | 'curve'
    decayLength: 0, // frames; 0 = Max age (exp: the half-life)
    decayCurve: 'linear', // a curve preset (or points): alpha = 1 − curve(age / length)
  },
  look: {
    tint: false,
    tintColors: ['#ffffff', '#ff7a00'], // new -> old, 2..4 colours
    tintAmount: 1,
    ageBrightness: 1, // multiplier at max age
    offset: 0, // Mode 1 spatial offset at white (px)
    offsetAngle: 0,
  },
};

export const clone = (o) => JSON.parse(JSON.stringify(o));

// Read and write a value by a path such as 'timemap.maxDelay'.
export function getPath(o, path) {
  return path.split('.').reduce((x, k) => x[k], o);
}

export function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((x, k) => x[k], o)[last] = v;
}

// The delay steps setting: 0 or 2..64 (1 is not a valid value).
export const fixSteps = (v, prev = 0) => (v === 1 ? (prev > 1 ? 0 : 2) : Math.max(0, Math.min(64, Math.round(v))));
