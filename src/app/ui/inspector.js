// The inspector (plan §12.4): the settings of the open sections. Phase 4: Mode, Map (Linear), Time.

import { slider, segmented, toggle, section } from './widgets.js';
import { getPath, fixSteps } from '../settings.js';

export class Inspector {
  // change(path, value): the app applies a setting change.
  constructor(root, change) {
    this.root = root;
    this.change = change;
    this.rows = {};
  }

  // limits: { maxDelay } (the store limit, N - 1).
  build(settings, limits) {
    const S = settings;
    const r = this.root;
    r.textContent = '';
    this.rows = {};
    const add = (parent, row) => {
      this.rows[row.dataset.key] = row;
      parent.append(row);
      return row;
    };
    const on = (key) => (v) => this.change(key, v);

    const mode = section('Mode');
    add(mode, segmented({ key: 'mode', options: [['timemap', 'Time Map'], ['slitscan', 'Slit Scan', true]], value: S.mode, onChange: on('mode') }));
    r.append(mode);

    const map = section('Map');
    add(map, segmented({ key: 'map.type', label: 'Map', options: [['linear', 'Linear']], value: S.map.type, onChange: on('map.type') }));
    const L = S.map.linear;
    add(map, slider({ key: 'map.linear.angle', label: 'Angle', min: 0, max: 360, step: 1, value: L.angle, def: 90, unit: '°', onChange: on('map.linear.angle') }));
    add(map, slider({ key: 'map.linear.x', label: 'Position x', min: 0, max: 1, step: 0.01, value: L.x, def: 0.5, onChange: on('map.linear.x') }));
    add(map, slider({ key: 'map.linear.y', label: 'Position y', min: 0, max: 1, step: 0.01, value: L.y, def: 0.5, onChange: on('map.linear.y') }));
    add(map, slider({ key: 'map.linear.width', label: 'Width', min: 0.05, max: 4, step: 0.01, value: L.width, def: 1, onChange: on('map.linear.width') }));
    r.append(map);

    const time = section('Time');
    const T = S.timemap;
    add(time, slider({ key: 'timemap.maxDelay', label: 'Max delay', min: 0, max: limits.maxDelay, step: 1, value: Math.min(T.maxDelay, limits.maxDelay), def: Math.min(30, limits.maxDelay), unit: 'f', onChange: on('timemap.maxDelay') }));
    add(time, slider({ key: 'timemap.steps', label: 'Delay steps', min: 0, max: 64, step: 1, value: T.steps, def: 0, onChange: (v) => {
      const f = fixSteps(v, T.steps);
      this.rows['timemap.steps'].setValue(f);
      this.change('timemap.steps', f);
    } }));
    add(time, toggle({ key: 'timemap.blend', label: 'Frame blend', value: T.blend, onChange: on('timemap.blend') }));
    r.append(time);
  }

  // Show the values of the settings (after a change from outside).
  refresh(settings) {
    for (const [key, row] of Object.entries(this.rows)) {
      const v = getPath(settings, key);
      row.setValue(typeof v === 'boolean' ? String(v) : v);
    }
  }
}
