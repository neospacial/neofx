// The inspector (plan §12.4): Mode, Map (source, map grid with thumbnails, params, fit and transform,
// adjustments, animation), Time. Settings that do not apply are hidden (§12.1).

import { slider, segmented, toggle, section, select, colors } from './widgets.js';
import { BLEND_MODES, DECAYS } from '../../gpu/blend.js';
import { RATE_TYPES } from '../../modes/slit.js';
import { getPath, fixSteps } from '../settings.js';
import { MAPS } from '../../maps/builtin.js';
import { curveEditor } from './curve.js';
import { RANDOM_SECTIONS } from '../random.js';

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
    this.thumbCache = {}; // map id -> the last thumbnail (luma), drawn again after a rebuild
  }

  // limits: { maxDelay (the store limit, N - 1), maxAge (the slit history rows), maxAgeEdge }.
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
    // The tab of each section in the narrow layout (plan §12.3).
    const TABS = { mode: 'mode', map: 'map', adjust: 'map', anim: 'map', source: 'map', time: 'time', time2: 'time', cutout: 'cutout', subject: 'cutout', composite: 'mix', look: 'look' };
    const sec = (name, title, def = true) => {
      const d = section(title, open[name] ?? def);
      d.dataset.name = name;
      d.dataset.tab = TABS[name] || 'mode';
      // Randomize (plan §12.5): a lock keeps the section; the dice changes only it.
      if (RANDOM_SECTIONS.includes(name)) {
        const tools = document.createElement('span');
        tools.className = 'secTools';
        const locked = this.app.locks && this.app.locks.has(name);
        const lock = Object.assign(document.createElement('button'), { type: 'button', className: `lock${locked ? ' on' : ''}`, textContent: locked ? '🔒' : '🔓' });
        lock.title = 'Lock: Randomize keeps this section';
        lock.dataset.lock = name;
        lock.setAttribute('aria-pressed', String(!!locked));
        lock.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.toggleLock(name);
        });
        const dice = Object.assign(document.createElement('button'), { type: 'button', className: 'dice', textContent: '🎲' });
        dice.title = 'Randomize this section';
        dice.dataset.dice = name;
        dice.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.randomize([name]);
        });
        tools.append(dice, lock);
        d.querySelector('summary').append(tools);
      }
      r.append(d);
      return d;
    };
    const num = (parent, key, label, min, max, step, def, unit) => add(parent, slider({ key, label, min, max, step, value: getPath(S, key), def, unit, onChange: on(key) }));
    const bool = (parent, key, label) => add(parent, toggle({ key, label, value: getPath(S, key), onChange: on(key) }));

    const mode = sec('mode', 'Mode');
    add(mode, segmented({ key: 'mode', options: [['timemap', 'Time Map'], ['slitscan', 'Slit Scan']], value: S.mode, onChange: on('mode') }));

    if (S.mode === 'timemap') {
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
      this.drawThumbs({ ...this.thumbCache });
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
      add(adj, curveEditor({ key: 'map.adjust.curve', label: 'Curve', value: M.adjust.curve, onChange: (v, final) => this.app.change('map.adjust.curve', v, final) }));
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
    } else {
      // Mode 2, Slit Scan (§8.5).
      const SL = S.slitscan;
      const src = sec('source', 'Source');
      const edge = SL.source === 'edge' || S.cutout.mode === 'scan';
      add(src, segmented({ key: 'slitscan.source', label: 'Source', options: [['line', 'Line', S.cutout.mode === 'scan', 'Scan object uses the subject edge'], ['edge', 'Subject edge']], value: edge ? 'edge' : 'line', onChange: on('slitscan.source') }));
      if (!edge) {
        num(src, 'slitscan.x', 'Line x', 0, 1, 0.001, 0.5);
        num(src, 'slitscan.y', 'Line y', 0, 1, 0.001, 0.5);
        num(src, 'slitscan.angle', 'Line angle', 0, 360, 0.1, 90, '°');
      } else num(src, 'slitscan.edgeAngle', 'Edge direction', 0, 360, 0.1, 0, '°');
      bool(src, 'slitscan.flip', 'Flip direction');
      if (!edge) num(src, 'slitscan.width', 'Slit width', 1, 16, 1, 1, 'px');
      else num(src, 'slitscan.joinLimit', 'Join limit', 1, 64, 1, 8, 'px');
      src.append(Object.assign(document.createElement('p'), { className: 'note', textContent: edge
        ? 'All the edge pixels of the subject (Cutout) are the source. Drag the round handle to set the direction.'
        : 'Drag the line on the preview. The round handle turns it (Shift: 15° steps). The arrow flips the direction.' }));
      const time = sec('time2', 'Time');
      bool(time, 'slitscan.time', 'Time');
      if (SL.time) {
        add(time, select({ key: 'slitscan.rateType', label: 'Rate type', options: RATE_TYPES, value: SL.rateType, onChange: on('slitscan.rateType') }));
        num(time, 'slitscan.rate', SL.rateType === 'constant' ? 'Rate' : 'Rate (start)', 0.05, 32, 0.05, 1, 'px/f');
        if (SL.rateType !== 'constant') num(time, 'slitscan.rateEnd', 'Rate at Max age', 0.05, 32, 0.05, 4, 'px/f');
        if (SL.rateType === 'curve') add(time, curveEditor({ key: 'slitscan.curve', label: 'Rate curve', value: SL.curve, onChange: (v, final) => this.app.change('slitscan.curve', v, final) }));
        if (edge) {
          num(time, 'slitscan.maxAgeEdge', 'Max age', 1, Math.max(1, limits.maxAgeEdge), 1, Math.min(120, limits.maxAgeEdge), 'f');
          const st = this.app.edgeStats ? this.app.edgeStats() : null;
          const note = Object.assign(document.createElement('p'), { className: 'note edgeLimit' });
          note.textContent = st ? `Limit: ${st.limit} frames (GPU ${st.ms.toFixed(1)} ms for ${st.maxAge} frames; target 20 ms)` : 'Limit: the history length.';
          time.append(note);
        } else {
          num(time, 'slitscan.maxAge', 'Max age', 1, limits.maxAge, 1, Math.min(600, limits.maxAge), 'f');
          add(time, segmented({ key: 'slitscan.sampling', label: 'Sampling', options: [['sharp', 'Sharp'], ['blend', 'Blend']], value: SL.sampling, onChange: on('slitscan.sampling') }));
        }
      }
    }

    // Cutout (§9): the subject mask, and the subject layer on top (Overlay).
    const Cu = S.cutout;
    const cut = sec('cutout', 'Cutout', false);
    add(cut, segmented({ key: 'cutout.mode', label: 'Cutout', options: [['off', 'Off'], ['overlay', 'Overlay'], ['scan', 'Scan object', S.mode !== 'slitscan', 'Slit Scan only']], value: Cu.mode, onChange: on('cutout.mode') }));
    const sub = (text) => cut.append(Object.assign(document.createElement('div'), { className: 'subhead', textContent: text }));
    const btn = (row, text, act, fn, isOn) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
      b.dataset.act = act;
      b.classList.toggle('on', !!isOn);
      b.addEventListener('click', fn);
      row.append(b);
      return b;
    };
    const tools = this.app.tools || {};
    sub('Background difference');
    bool(cut, 'cutout.bgdiff.on', 'Use');
    if (Cu.bgdiff.on) {
      add(cut, segmented({ key: 'cutout.plate', label: 'Clean plate', options: [['auto', 'Auto'], ['frame', 'This frame'], ['image', 'Image']], value: Cu.plate, onChange: (v) => this.app.plate(v) }));
      const pr = Object.assign(document.createElement('div'), { className: 'toolRow' });
      btn(pr, Cu.plate === 'auto' ? 'Make again' : Cu.plate === 'frame' ? 'Use this frame' : 'Open image…', 'plate', () => this.app.plate(Cu.plate));
      pr.append(Object.assign(document.createElement('span'), { className: 'fileName', textContent: tools.plateText || 'No clean plate' }));
      cut.append(pr);
      num(cut, 'cutout.bgdiff.threshold', 'Threshold', 0, 1, 0.005, 0.12);
      num(cut, 'cutout.bgdiff.softness', 'Softness', 0, 0.5, 0.005, 0.06);
      num(cut, 'cutout.bgdiff.lightTol', 'Light tolerance', 0, 1, 0.01, 0.5);
      num(cut, 'cutout.bgdiff.shadow', 'Shadow', 0, 1, 0.01, 0);
    }
    sub('Chroma key');
    bool(cut, 'cutout.chroma.on', 'Use');
    if (Cu.chroma.on) {
      const row = document.createElement('div');
      row.className = 'setting color';
      row.dataset.key = 'cutout.chroma.key';
      const lab = Object.assign(document.createElement('label'), { textContent: 'Key colour' });
      const inp = Object.assign(document.createElement('input'), { type: 'color', value: Cu.chroma.key });
      inp.addEventListener('input', () => this.app.change('cutout.chroma.key', inp.value));
      row.setValue = (v) => (inp.value = v);
      const tr = Object.assign(document.createElement('div'), { className: 'toolRow' });
      btn(tr, 'Pick', 'pick', () => this.app.setTool('pick'), tools.tool === 'pick');
      row.append(lab, inp, tr);
      add(cut, row);
      num(cut, 'cutout.chroma.tolerance', 'Tolerance', 0, 0.5, 0.005, 0.08);
      num(cut, 'cutout.chroma.softness', 'Softness', 0, 0.5, 0.005, 0.05);
      num(cut, 'cutout.chroma.spill', 'Spill', 0, 1, 0.01, 0.5);
    }
    sub('Luma key');
    bool(cut, 'cutout.luma.on', 'Use');
    if (Cu.luma.on) {
      num(cut, 'cutout.luma.low', 'Low', 0, 1, 0.005, 0.7);
      num(cut, 'cutout.luma.high', 'High', 0, 1, 0.005, 1);
      num(cut, 'cutout.luma.softness', 'Softness', 0, 0.5, 0.005, 0.05);
      bool(cut, 'cutout.luma.invert', 'Invert');
    }
    add(cut, segmented({ key: 'cutout.combine', label: 'Combine', options: [['union', 'Union'], ['intersect', 'Intersect']], value: Cu.combine, onChange: on('cutout.combine') }));
    sub('Garbage matte');
    const mr = Object.assign(document.createElement('div'), { className: 'toolRow' });
    btn(mr, 'Always subject', 'always', () => this.app.setTool('always'), tools.tool === 'always');
    btn(mr, 'Never subject', 'never', () => this.app.setTool('never'), tools.tool === 'never');
    btn(mr, 'Erase', 'erase', () => this.app.setTool('erase'), tools.tool === 'erase');
    btn(mr, 'Clear', 'clearMatte', () => this.app.clearMatte());
    cut.append(mr);
    add(cut, slider({ key: 'tools.brushSize', label: 'Brush size', min: 2, max: 400, step: 1, value: tools.brush ? tools.brush.size : 40, def: 40, unit: 'px', onChange: (v) => (tools.brush.size = v) }));
    add(cut, slider({ key: 'tools.brushHardness', label: 'Hardness', min: 0, max: 1, step: 0.01, value: tools.brush ? tools.brush.hardness : 0.7, def: 0.7, onChange: (v) => (tools.brush.hardness = v) }));
    sub('Clean up');
    num(cut, 'cutout.open', 'Open', 0, 16, 1, 0, 'px');
    num(cut, 'cutout.close', 'Close', 0, 16, 1, 0, 'px');
    num(cut, 'cutout.fillHoles', 'Fill holes', 0, 20, 0.1, 0, '%');
    bool(cut, 'cutout.keepLargest', 'Keep largest');
    num(cut, 'cutout.grow', 'Grow / shrink', -32, 32, 1, 0, 'px');
    num(cut, 'cutout.smooth', 'Temporal smooth', 0, 0.95, 0.01, 0);
    bool(cut, 'cutout.hysteresis', 'Hysteresis');
    if (Cu.hysteresis) {
      num(cut, 'cutout.tLow', 'Off below', 0, 1, 0.01, 0.35);
      num(cut, 'cutout.tHigh', 'On above', 0, 1, 0.01, 0.65);
    }
    num(cut, 'cutout.feather', 'Feather', 0, 32, 0.5, 0, 'px');
    sub('Mask import');
    const ir = Object.assign(document.createElement('div'), { className: 'toolRow' });
    btn(ir, 'Open mask video…', 'importMask', () => this.app.importMask());
    if (Cu.import.name) btn(ir, 'Remove', 'removeMask', () => this.app.removeMask());
    ir.append(Object.assign(document.createElement('span'), { className: 'fileName', textContent: Cu.import.name || 'No mask video' }));
    cut.append(ir);
    if (Cu.mode === 'overlay' || Cu.mode === 'scan') {
      const Sb = S.subject;
      const sl = sec('subject', 'Subject layer');
      add(sl, select({ key: 'subject.blend', label: 'Blend mode', options: BLEND_MODES, value: Sb.blend, onChange: on('subject.blend') }));
      add(sl, slider({ key: 'subject.opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, value: Sb.opacity, def: 1, onChange: on('subject.opacity') }));
      num(sl, 'subject.grow', 'Grow / shrink', -32, 32, 1, 0, 'px');
      num(sl, 'subject.feather', 'Feather', 0, 32, 0.5, 0, 'px');
      num(sl, 'subject.outline', 'Outline', 0, 32, 1, 0, 'px');
      if (Sb.outline > 0) {
        const row = document.createElement('div');
        row.className = 'setting color';
        row.dataset.key = 'subject.outlineColor';
        const inp = Object.assign(document.createElement('input'), { type: 'color', value: Sb.outlineColor });
        inp.addEventListener('input', () => this.app.change('subject.outlineColor', inp.value));
        row.setValue = (v) => (inp.value = v);
        row.append(Object.assign(document.createElement('label'), { textContent: 'Outline colour' }), inp);
        add(sl, row);
      }
    }

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
      if (Cp.decay === 'curve') add(comp, curveEditor({ key: 'composite.decayCurve', label: 'Decay curve', value: Cp.decayCurve, onChange: (v, final) => this.app.change('composite.decayCurve', v, final) }));
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
    if (S.mode === 'timemap') add(look, slider({ key: 'look.offset', label: 'Spatial offset', min: 0, max: 64, step: 0.5, value: L.offset, def: 0, unit: 'px', onChange: on('look.offset') }));
    if (S.mode === 'timemap' && L.offset > 0) add(look, slider({ key: 'look.offsetAngle', label: 'Offset angle', min: 0, max: 360, step: 1, value: L.offsetAngle, def: 0, unit: '°', onChange: on('look.offsetAngle') }));

    // The narrow layout: tabs for the sections (plan §12.3).
    const tabs = document.createElement('div');
    tabs.className = 'tabBar';
    tabs.setAttribute('role', 'tablist');
    for (const [id, text] of [['mode', 'Mode'], ['map', S.mode === 'timemap' ? 'Map' : 'Source'], ['time', 'Time'], ['cutout', 'Cutout'], ['mix', 'Mix'], ['look', 'Look']]) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
      b.dataset.tab = id;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.setTab(id));
      tabs.append(b);
    }
    r.prepend(tabs);
    this.setTab(this.tab || 'mode');

    // Randomize (plan §12.5): the sections that are not locked; the seed is shown (and makes the same look).
    const rb = document.createElement('div');
    rb.className = 'randomBar';
    const randBtn = Object.assign(document.createElement('button'), { type: 'button', id: 'randomizeBtn', textContent: '🎲 Randomize' });
    randBtn.addEventListener('click', () => this.app.randomize());
    const seed = Object.assign(document.createElement('span'), { className: 'seed', textContent: this.app.lastSeed && this.app.lastSeed() ? `Look #${this.app.lastSeed()}` : '' });
    rb.append(randBtn, seed);
    r.append(rb);
  }

  // The narrow layout shows the sections of one tab.
  setTab(id) {
    this.tab = id;
    this.root.dataset.tab = id;
    for (const b of this.root.querySelectorAll('.tabBar button')) {
      b.classList.toggle('on', b.dataset.tab === id);
      b.setAttribute('aria-selected', String(b.dataset.tab === id));
    }
    // In a tab, the sections are open.
    if (window.matchMedia && window.matchMedia('(max-width: 999px)').matches) {
      for (const d of this.root.querySelectorAll(`details[data-tab="${id}"]`)) d.open = true;
    }
  }

  // Draw map thumbnails: images = { id: Uint8Array luma (THUMB_W x THUMB_H) }.
  drawThumbs(images) {
    Object.assign(this.thumbCache, images);
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
      if (key.startsWith('tools.')) continue;
      const v = getPath(settings, key);
      if (row.classList.contains('curve')) {
        row.setValue(v);
        continue;
      }
      row.setValue(typeof v === 'boolean' ? String(v) : v);
    }
  }
}
