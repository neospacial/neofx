// The built-in maps (plan §7.3): ids, names, and parameters. The order of MAPS is the u_type of
// gpu/glsl/maps.glsl; the order of the params of each map is its u_k[] order.
// A param: [key, label, min, max, step, default, unit].

const C = [['x', 'Center x', 0, 1, 0.01, 0.5], ['y', 'Center y', 0, 1, 0.01, 0.5]];
const SEED = ['seed', 'Seed', 0, 999, 1, 1];

export const MAPS = [
  { id: 'linear', name: 'Linear', params: [['angle', 'Angle', 0, 360, 1, 90, '°'], ['x', 'Position x', 0, 1, 0.01, 0.5], ['y', 'Position y', 0, 1, 0.01, 0.5], ['width', 'Width', 0.05, 4, 0.01, 1]] },
  { id: 'mirrored', name: 'Mirrored', params: [['angle', 'Angle', 0, 360, 1, 90, '°'], ['x', 'Center x', 0, 1, 0.01, 0.5], ['y', 'Center y', 0, 1, 0.01, 0.5], ['width', 'Width', 0.05, 4, 0.01, 1]] },
  { id: 'radial', name: 'Radial', params: [...C, ['radius', 'Radius', 0.05, 2, 0.01, 0.7], ['aspect', 'Aspect', 0.25, 4, 0.01, 1]] },
  { id: 'angular', name: 'Angular', params: [...C, ['start', 'Start angle', 0, 360, 1, 0, '°'], ['turns', 'Turns', 1, 16, 1, 1]] },
  { id: 'spiral', name: 'Spiral', params: [...C, ['arms', 'Arms', 1, 12, 1, 2], ['tightness', 'Tightness', 0, 20, 0.1, 4]] },
  { id: 'box', name: 'Diamond / Box', params: [...C, ['size', 'Size', 0.05, 2, 0.01, 0.5], ['roundness', 'Roundness', 0, 1, 0.01, 0, '']] },
  { id: 'corners', name: 'Four corners', params: [['tl', 'Top left', 0, 1, 0.01, 0], ['tr', 'Top right', 0, 1, 0.01, 0.33], ['bl', 'Bottom left', 0, 1, 0.01, 0.66], ['br', 'Bottom right', 0, 1, 0.01, 1]] },
  { id: 'stripes', name: 'Stripes', params: [['count', 'Count', 1, 64, 1, 8], ['angle', 'Angle', 0, 360, 1, 0, '°'], ['softness', 'Softness', 0, 1, 0.01, 0], ['duty', 'Duty', 0, 1, 0.01, 0.5]] },
  { id: 'sine', name: 'Sine waves', params: [['fx', 'Frequency x', 0, 32, 0.1, 4], ['fy', 'Frequency y', 0, 32, 0.1, 0], ['angle', 'Angle', 0, 360, 1, 0, '°'], ['phase', 'Phase', 0, 1, 0.01, 0]] },
  { id: 'rings', name: 'Rings', params: [...C, ['count', 'Count', 1, 64, 1, 8], ['softness', 'Softness', 0, 1, 0.01, 0]] },
  { id: 'checker', name: 'Checkerboard', params: [['cells', 'Cells', 1, 64, 1, 8], ['softness', 'Softness', 0, 1, 0.01, 0]] },
  { id: 'fbm', name: 'Value noise', params: [['scale', 'Scale', 0.5, 64, 0.1, 4], ['octaves', 'Octaves', 1, 8, 1, 4], ['roughness', 'Roughness', 0, 1, 0.01, 0.5], SEED] },
  { id: 'ridged', name: 'Ridged noise', params: [['scale', 'Scale', 0.5, 64, 0.1, 3], ['octaves', 'Octaves', 1, 8, 1, 4], SEED] },
  { id: 'worley', name: 'Cellular', params: [['scale', 'Scale', 1, 64, 0.1, 6], SEED, ['metric', 'Metric', 0, 2, 1, 0]] },
  { id: 'voronoi', name: 'Voronoi cells', params: [['scale', 'Scale', 1, 64, 0.1, 6], SEED] },
  { id: 'blocks', name: 'Random blocks', params: [['bw', 'Block width', 1, 256, 1, 32, 'px'], ['bh', 'Block height', 1, 256, 1, 32, 'px'], SEED] },
  { id: 'rows', name: 'Random rows', params: [['size', 'Size', 1, 256, 1, 16, 'px'], ['direction', 'Columns', 0, 1, 1, 0], SEED] },
  { id: 'bayer', name: 'Bayer dither', params: [['matrix', 'Matrix (2^n)', 1, 3, 1, 2], ['base', 'Base value', 0, 1, 0.01, 0.5]] },
  { id: 'self', name: 'Video luminance', params: [] },
  { id: 'motion', name: 'Motion', params: [['gain', 'Gain', 0.5, 20, 0.1, 4], ['frames', 'Smooth (frames)', 1, 8, 1, 2]] },
  { id: 'subject', name: 'Subject mask', params: [['subject', 'Subject value', 0, 1, 0.01, 1], ['background', 'Background value', 0, 1, 0.01, 0]], usesMask: true },
  { id: 'subjectdist', name: 'Subject distance', params: [['falloff', 'Falloff', 1, 1000, 1, 120, 'px']], usesMask: true },
];

export const MAP_INDEX = Object.fromEntries(MAPS.map((m, i) => [m.id, i]));

// The default params of each map: { linear: { angle: 90, ... }, ... }.
export function defaultParams() {
  return Object.fromEntries(MAPS.map((m) => [m.id, Object.fromEntries(m.params.map((p) => [p[0], p[5]]))]));
}

// The u_k[] values of a map.
export function paramArray(id, params) {
  const m = MAPS[MAP_INDEX[id]];
  return m.params.map((p) => Number((params && params[p[0]]) ?? p[5]));
}

// A built-in map that needs the subject mask (plan §9).
export const usesMask = (map) => map.source === 'builtin' && (map.type === 'subject' || map.type === 'subjectdist');

// The map needs a new render for each frame (it changes with t).
export function isDynamic(map) {
  const a = map.anim;
  return map.source === 'video' || (map.source === 'builtin' && ['self', 'motion', 'subject', 'subjectdist'].includes(map.type))
    || (map.source === 'builtin' && !!(a.phaseSpeed || a.rotSpeed || a.pulseAmount || a.seedEvery));
}

// Video map (plan §7.4): the map frame for source frame t. end: 'loop' | 'hold' | 'pingpong'.
export function videoMapFrame(t, count, speed, offset, end) {
  if (count <= 1) return 0;
  const m = Math.round(t * speed + offset);
  if (end === 'hold') return Math.max(0, Math.min(count - 1, m));
  if (end === 'pingpong') {
    const p = 2 * (count - 1);
    const r = ((m % p) + p) % p;
    return r < count ? r : p - r;
  }
  return ((m % count) + count) % count;
}
