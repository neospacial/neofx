// The inspector (plan §12.4): Mode, Map (source, map grid with thumbnails, params, fit and transform,
// adjustments, animation), Time. Settings that do not apply are hidden (§12.1).

import { slider, segmented, toggle, section, select, colors } from './widgets.js';
import { BLEND_MODES, DECAYS } from '../../gpu/blend.js';
import { getPath, fixSteps } from '../settings.js';
import { MAPS } from '../../maps/builtin.js';
import { CURVE_PRESETS } from '../../maps/curve.js';

export const THUMB_W = 72;
export const THUMB_H = 40;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class Inspector {
  // app: { change(path, value), openMap(kind), info() -> { mapName, mapFrames } }
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.rows = {};
    this.tiles = {}; // map id -> canvas
  }

  // limits: { maxDelay } (the store limit, N - 1).
  build(settings, limits) {
    const S = settings;
    const r = this.root;
    const open = {};
    for (const d of r.querySelectorAll('details[data-name]')) open[d.dataset.name] = d.open;
    r.textContent = '';
    this.rows = {};
    this.tiles = {};
    const add = (parent, row) => {
      this.rows[row.dataset.key] = row;
      parent.append(row);
      return row;
    };
    const on = (key) => (v) => this.app.change(key, v);
    const sec = (name, title, def = true) => {
      const d = section(title, open[name] ?? def);
      d.dataset.name = name;
      r.append(d);
      return d;
    };
    const num = (parent, key, label, min, max, step, def, unit) => add(parent, slider({ key, label, min, max, step, value: getPath(S, key), def, unit, onChange: on(key) }));
    const bool = (parent, key, label) => add(parent, toggle({ key, label, value: getPath(S, key), onChange: on(key) }));

    const mode = sec('mode', 'Mode');
    add(mode, segmented({ key: 'mode', options: [['timemap', 'Time Map'], ['slitscan', 'Slit Scan', true]], value: S.mode, onChange: on('mode') }));

    // Map.
    const M = S.map;
    const map = sec('map', 'Map');
    add(map, segmented({ key: 'map.source', label: 'Source', options: [['builtin', 'Built-in'], ['image', 'Image'], ['video', 'Video']], value: M.source, onChange: on('map.source') }));
    if (M.source === 'builtin') {
      const grid = el('div', 'mapGrid');
      for (const m of MAPS) {
        const b = el('button', 'mapTile');
        b.type = 'button';
        b.dataset.map = m.id;
        b.title = m.needs ? `${m.name} (needs Cutout: a later version)` : m.name;
        b.disabled = !!m.needs;
        b.classList.toggle('on', m.id === M.type);
        const c = el('canvas');
        c.width = THUMB_W;
        c.height = THUMB_H;
        this.tiles[m.id] = c;
        b.append(c, el('span', null, m.name));
        b.addEventListener('click', () => this.app.change('map.type', m.id));
        grid.append(b);
      }
      map.append(grid);
      const spec = MAPS.find((m) => m.id === M.type);
      for (const [k, label, min, max, step, def, unit] of spec.params) num(map, `map.params.${M.type}.${k}`, label, min, max, step, def, unit);
      if (M.type === 'self') map.append(el('p', 'note', 'Bright = old. Use Invert (Adjust) for bright = new.'));
    } else {
      const info = this.app.info();
      const row = el('div', 'setting fileRow');
      const btn = el('button', null, M.source === 'image' ? 'Open image…' : 'Open video…');
      btn.type = 'button';
      btn.dataset.act = `open-${M.source}`;
      btn.addEventListener('click', () => this.app.openMap(M.source));
      const name = M.source === 'image' ? M.image.name : M.video.name;
      row.append(btn, el('span', 'fileName', name ? `${name}${M.source === 'video' && info.mapFrames ? ` · ${info.mapFrames} frames` : ''}` : 'No file'));
      map.append(row);
      add(map, segmented({ key: 'map.image.fit', label: 'Fit', options: [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch']], value: M.image.fit, onChange: on('map.image.fit') }));
      num(map, 'map.image.outside', 'Outside value', 0, 1, 0.01, 0);
      num(map, 'map.image.x', 'Position x', -1, 1, 0.01, 0);
      num(map, 'map.image.y', 'Position y', -1, 1, 0.01, 0);
      num(map, 'map.image.scale', 'Scale', 0.1, 8, 0.01, 1);
      num(map, 'map.image.rotation', 'Rotation', -180, 180, 1, 0, '°');
      bool(map, 'map.image.flipX', 'Flip horizontal');
      bool(map, 'map.image.flipY', 'Flip vertical');
      if (M.source === 'video') {
        num(map, 'map.video.speed', 'Speed', -4, 4, 0.05, 1, '×');
        num(map, 'map.video.offset', 'Offset', -1000, 1000, 1, 0, 'f');
        add(map, segmented({ key: 'map.video.end', label: 'End', options: [['loop', 'Loop'], ['hold', 'Hold last'], ['pingpong', 'Ping-pong']], value: M.video.end, onChange: on('map.video.end') }));
      }
    }

    const adj = sec('adjust', 'Map adjust', false);
    bool(adj, 'map.adjust.invert', 'Invert');
    num(adj, 'map.adjust.black', 'Black point', 0, 1, 0.01, 0);
    num(adj, 'map.adjust.white', 'White point', 0, 1, 0.01, 1);
    num(adj, 'map.adjust.gamma', 'Gamma', 0.1, 5, 0.01, 1);
    num(adj, 'map.adjust.contrast', 'Contrast', -1, 1, 0.01, 0);
    add(adj, segmented({ key: 'map.adjust.curve', label: 'Curve', options: Object.keys(CURVE_PRESETS).map((k) => [k, { linear: 'Linear', easeIn: 'Ease in', easeOut: 'Ease out', sCurve: 'S', step: 'Step' }[k]]), value: M.adjust.curve, onChange: on('map.adjust.curve') }));
    num(adj, 'map.adjust.posterize', 'Posterize', 0, 64, 1, 0);
    num(adj, 'map.adjust.blur', 'Blur', 0, 64, 0.5, 0, 'px');
    num(adj, 'map.adjust.tileX', 'Tile x', 1, 16, 1, 1);
    num(adj, 'map.adjust.tileY', 'Tile y', 1, 16, 1, 1);
    bool(adj, 'map.adjust.mirrorTile', 'Mirror tile');
    num(adj, 'map.adjust.offsetX', 'Offset x', -1, 1, 0.01, 0);
    num(adj, 'map.adjust.offsetY', 'Offset y', -1, 1, 0.01, 0);

    if (M.source === 'builtin') {
      const an = sec('anim', 'Map animation', false);
      num(an, 'map.anim.phaseSpeed', 'Phase speed', -0.2, 0.2, 0.001, 0, '/f');
      num(an, 'map.anim.rotSpeed', 'Rotation speed', -10, 10, 0.1, 0, '°/f');
      num(an, 'map.anim.pulseAmount', 'Pulse amount', 0, 1, 0.01, 0);
      num(an, 'map.anim.pulsePeriod', 'Pulse period', 2, 600, 1, 60, 'f');
      num(an, 'map.anim.seedEvery', 'New seed every', 0, 600, 1, 0, 'f');
    }

    const time = sec('time', 'Time');
    const T = S.timemap;
    add(time, slider({ key: 'timemap.maxDelay', label: 'Max delay', min: 0, max: limits.maxDelay, step: 1, value: Math.min(T.maxDelay, limits.maxDelay), def: Math.min(30, limits.maxDelay), unit: 'f', onChange: on('timemap.maxDelay') }));
    add(time, slider({ key: 'timemap.steps', label: 'Delay steps', min: 0, max: 64, step: 1, value: T.steps, def: 0, onChange: (v) => {
      const f = fixSteps(v, T.steps);
      this.rows['timemap.steps'].setValue(f);
      this.app.change('timemap.steps', f);
    } }));
    add(time, toggle({ key: 'timemap.blend', label: 'Frame blend', value: T.blend, onChange: on('timemap.blend') }));

    // Composite (§10): Replace shows the effect as it is; Blend puts it on the original.
    const Cp = S.composite;
    const comp = sec('composite', 'Composite');
    add(comp, segmented({ key: 'composite.mode', label: 'Effect', options: [['replace', 'Replace'], ['blend', 'Blend']], value: Cp.mode, onChange: on('composite.mode') }));
    if (Cp.mode === 'blend') {
      add(comp, select({ key: 'composite.blend', label: 'Blend mode', options: BLEND_MODES, value: Cp.blend, onChange: on('composite.blend') }));
      add(comp, slider({ key: 'composite.opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, value: Cp.opacity, def: 1, onChange: on('composite.opacity') }));
      add(comp, select({ key: 'composite.decay', label: 'Age decay', options: DECAYS, value: Cp.decay, onChange: on('composite.decay') }));
      if (Cp.decay !== 'full') {
        add(comp, slider({ key: 'composite.decayLength', label: Cp.decay === 'exp' ? 'Half-life' : 'Decay length', min: 0, max: Math.max(1, limits.maxDelay), step: 1, value: Cp.decayLength, def: 0, unit: 'f', onChange: on('composite.decayLength') }));
        comp.append(Object.assign(document.createElement('p'), { className: 'note', textContent: '0 = the Max age.' }));
      }
      if (Cp.decay === 'curve') add(comp, segmented({ key: 'composite.decayCurve', label: 'Curve', options: Object.keys(CURVE_PRESETS).map((k) => [k, { linear: 'Linear', easeIn: 'Ease in', easeOut: 'Ease out', sCurve: 'S', step: 'Step' }[k]]), value: Cp.decayCurve, onChange: on('composite.decayCurve') }));
      add(comp, toggle({ key: 'composite.linear', label: 'Linear blend', value: Cp.linear, onChange: on('composite.linear') }));
    }

    // Look: age tint, age brightness, spatial offset (Mode 1).
    const L = S.look;
    const look = sec('look', 'Look', false);
    add(look, toggle({ key: 'look.tint', label: 'Age tint', value: L.tint, onChange: on('look.tint') }));
    if (L.tint) {
      add(look, colors({ key: 'look.tintColors', label: 'New → old', value: L.tintColors, onChange: on('look.tintColors') }));
      add(look, slider({ key: 'look.tintAmount', label: 'Tint amount', min: 0, max: 1, step: 0.01, value: L.tintAmount, def: 1, onChange: on('look.tintAmount') }));
    }
    add(look, slider({ key: 'look.ageBrightness', label: 'Age brightness', min: 0, max: 2, step: 0.01, value: L.ageBrightness, def: 1, unit: '×', onChange: on('look.ageBrightness') }));
    add(look, slider({ key: 'look.offset', label: 'Spatial offset', min: 0, max: 64, step: 0.5, value: L.offset, def: 0, unit: 'px', onChange: on('look.offset') }));
    if (L.offset > 0) add(look, slider({ key: 'look.offsetAngle', label: 'Offset angle', min: 0, max: 360, step: 1, value: L.offsetAngle, def: 0, unit: '°', onChange: on('look.offsetAngle') }));
  }

  // Draw map thumbnails: images = { id: Uint8Array luma (THUMB_W x THUMB_H) }.
  drawThumbs(images) {
    for (const [id, y] of Object.entries(images)) {
      const c = this.tiles[id];
      if (!c) continue;
      const img = new ImageData(THUMB_W, THUMB_H);
      for (let i = 0; i < y.length; i++) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = y[i];
        img.data[i * 4 + 3] = 255;
      }
      c.getContext('2d').putImageData(img, 0, 0);
    }
  }

  // Show the values of the settings (after a change from outside).
  refresh(settings) {
    for (const [key, row] of Object.entries(this.rows)) {
      const v = getPath(settings, key);
      row.setValue(typeof v === 'boolean' ? String(v) : v);
    }
  }
}
