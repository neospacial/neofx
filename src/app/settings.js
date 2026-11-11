// The settings (plan §7.2 – §7.6). One plain object, so presets and undo (phase 11) can copy it.

import { defaultParams } from '../maps/builtin.js';

export const DEFAULTS = {
  mode: 'timemap', // 'timemap' | 'slitscan' (phase 7)
  view: 'result', // 'result' | 'original' | 'map'
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
