// The settings (plan §7.2, §7.3). One plain object, so presets and undo (phase 11) can copy it.

export const DEFAULTS = {
  mode: 'timemap', // 'timemap' | 'slitscan' (phase 7)
  view: 'result', // 'result' | 'original' | 'map'
  timemap: {
    maxDelay: 30, // frames (white); the store limits it to N - 1
    steps: 0, // 0 = smooth, else 2..64
    blend: true, // frame blend
  },
  map: {
    type: 'linear',
    linear: { angle: 90, x: 0.5, y: 0.5, width: 1 },
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
