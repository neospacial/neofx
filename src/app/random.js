// Randomize (plan §12.5): safe random values for one section of the settings. A seed makes it
// repeatable (the same seed gives the same look).

import { MAPS } from '../maps/builtin.js';
import { BLEND_MODES } from '../gpu/blend.js';
import { RATE_TYPES } from '../modes/slit.js';

// mulberry32: a small seeded random generator, 0 <= r() < 1.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const range = (r, a, b, step = 0) => {
  const v = a + r() * (b - a);
  return step ? Math.round(v / step) * step : v;
};
const hex = (r) => `#${[0, 0, 0].map(() => Math.floor(64 + r() * 192).toString(16).padStart(2, '0')).join('')}`;

// The sections that Randomize can change (the cutout is not random: it depends on the footage).
export const RANDOM_SECTIONS = ['map', 'adjust', 'anim', 'time', 'source', 'time2', 'composite', 'look'];

// Change the settings S of one section with r. limits: { maxDelay, maxAge, maxAgeEdge }.
export function randomizeSection(S, section, r, limits) {
  const M = S.map;
  if (section === 'map') {
    const list = MAPS.filter((m) => !m.usesMask && m.id !== 'motion').map((m) => m.id);
    M.source = 'builtin';
    M.type = pick(r, list);
    const spec = MAPS.find((m) => m.id === M.type);
    for (const [k, , min, max, step, def] of spec.params) {
      // Near the default: half of the range around it (safe looks).
      const lo = Math.max(min, def - (max - min) / 4), hi = Math.min(max, def + (max - min) / 4);
      M.params[M.type][k] = Math.min(max, Math.max(min, range(r, lo, hi, step)));
    }
  } else if (section === 'adjust') {
    Object.assign(M.adjust, {
      invert: r() < 0.3, gamma: range(r, 0.6, 1.8, 0.01), contrast: range(r, -0.3, 0.5, 0.01),
      posterize: r() < 0.25 ? Math.floor(range(r, 3, 12)) : 0, curve: pick(r, ['linear', 'linear', 'easeIn', 'easeOut', 'sCurve']),
      blur: r() < 0.3 ? range(r, 1, 8, 0.5) : 0,
    });
  } else if (section === 'anim') {
    const on = r() < 0.5;
    Object.assign(M.anim, { phaseSpeed: on ? range(r, -0.02, 0.02, 0.001) : 0, rotSpeed: on && r() < 0.5 ? range(r, -1, 1, 0.1) : 0, pulseAmount: 0, seedEvery: 0 });
  } else if (section === 'time') {
    Object.assign(S.timemap, {
      maxDelay: Math.max(1, Math.round(range(r, 8, Math.max(9, Math.min(120, limits.maxDelay))))),
      steps: r() < 0.3 ? Math.floor(range(r, 2, 16)) : 0, blend: r() < 0.7,
    });
  } else if (section === 'source') {
    const sl = S.slitscan;
    if (sl.source === 'edge' || S.cutout.mode === 'scan') sl.edgeAngle = Math.round(range(r, 0, 360));
    else Object.assign(sl, { x: range(r, 0.25, 0.75, 0.001), y: range(r, 0.25, 0.75, 0.001), angle: Math.round(range(r, 0, 360)) });
    sl.flip = r() < 0.5;
  } else if (section === 'time2') {
    const sl = S.slitscan;
    Object.assign(sl, {
      time: r() < 0.85, rateType: pick(r, RATE_TYPES.map(([id]) => id).filter((id) => id !== 'curve')),
      rate: range(r, 0.25, 4, 0.05), rateEnd: range(r, 0.25, 6, 0.05),
      maxAge: Math.max(1, Math.round(range(r, 30, Math.max(31, Math.min(600, limits.maxAge))))),
      maxAgeEdge: Math.max(1, Math.round(range(r, 20, Math.max(21, Math.min(240, limits.maxAgeEdge))))),
      sampling: r() < 0.5 ? 'sharp' : 'blend',
    });
  } else if (section === 'composite') {
    const blend = r() < 0.5;
    Object.assign(S.composite, {
      mode: blend ? 'blend' : 'replace', blend: pick(r, BLEND_MODES.map(([id]) => id)), opacity: range(r, 0.6, 1, 0.01),
      decay: pick(r, ['full', 'full', 'linear', 'exp']), decayLength: 0, linear: false,
    });
  } else if (section === 'look') {
    const tint = r() < 0.5;
    Object.assign(S.look, { tint, tintColors: [hex(r), hex(r)], tintAmount: range(r, 0.4, 1, 0.01), ageBrightness: range(r, 0.6, 1.4, 0.01) });
  }
  return S;
}
