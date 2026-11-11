// Compositor constants (plan §10.2, §10.3). The order of BLEND_MODES is u_blendMode of composite.glsl.

export const BLEND_MODES = [
  ['normal', 'Normal'], ['add', 'Add'], ['screen', 'Screen'], ['lighten', 'Lighten'], ['colordodge', 'Color dodge'],
  ['overlay', 'Overlay'], ['softlight', 'Soft light'], ['hardlight', 'Hard light'], ['multiply', 'Multiply'],
  ['darken', 'Darken'], ['colorburn', 'Color burn'], ['subtract', 'Subtract'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['divide', 'Divide'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];
export const BLEND_INDEX = Object.fromEntries(BLEND_MODES.map(([id], i) => [id, i]));

export const DECAYS = [['full', 'Full'], ['linear', 'Linear'], ['exp', 'Exponential'], ['curve', 'Curve']];
export const DECAY_INDEX = Object.fromEntries(DECAYS.map(([id], i) => [id, i]));

// '#rrggbb' -> [r, g, b] (0..1).
export const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
