// neofx app: open a file, the preview (GPU engine), seek, play, timeline, the inspector, Mode 1
// (Time Map) and Mode 2 (Slit Scan, with its analysis pass and line handles).

import { checkPlatform } from './platform.js';
import { Player } from './player.js';
import { GpuClient } from './gpu-client.js';
import { Preview } from './preview.js';
import { workingSize, defaultBudget, bufferText } from '../gpu/store.js';
import { Timeline } from './ui/timeline.js';
import { Inspector } from './ui/inspector.js';
import { DEFAULTS, clone, setPath } from './settings.js';
import { MAPS } from '../maps/builtin.js';
import { loadImageMap, loadVideoMap } from '../maps/mapsource.js';
import { THUMB_W, THUMB_H } from './ui/inspector.js';
import { Analysis } from './analysis.js';
import { LineHandles } from './ui/handles.js';
import { PreviewTools } from './ui/tools.js';
import { plateIndices } from '../analysis/cleanplate.js';
import { makeWorker } from './player.js';
import { usesMask } from '../maps/builtin.js';
import { Exporter } from './export.js';
import { ExportDialog } from './ui/exportdialog.js';
import { layerCount } from '../gpu/store.js';
import { History } from './history.js';
import { rng, randomizeSection } from './random.js';
import { PRESETS, applyPreset, presetFile, parsePresetFile, dataUrlBlob, merge } from './presets.js';
import { initLayout } from './ui/layout.js';
import { startDemos } from './ui/startscreen.js';

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';
const DECODE_WORKER = "@WORKER:io/demux.js,io/timeline.js,io/decode-worker.js";
const GPU_WORKER = "@WORKER:maps/builtin.js,maps/curve.js,modes/slit.js,analysis/regions.js,gpu/store.js,gpu/gl.js,gpu/blend.js,gpu/mapgen.js,gpu/slit.js,gpu/mask.js,gpu/edge.js,gpu/engine.js,gpu/gpu-worker.js";
const ANALYSIS_WORKER = "@WORKER:analysis/cleanplate.js,analysis/analysis-worker.js";
const ENCODE_WORKER = "@WORKER:io/encode-worker.js";

let player, preview, timeline, gpu, inspector, analysis, handles, tools, exportDialog, gpuCaps, platform;
let exporter = null; // the export that runs
let layout = null;
const history = new History();
const locks = new Set(); // the sections that Randomize keeps
let lastSeed = 0;
const LOCAL_KEY = 'neofx.settings';
// The state of the preview tools and the clean plate (not part of the settings).
const toolState = { tool: null, brush: { size: 40, hardness: 0.7 }, plateText: '', plateOk: false, matteVersion: 0 };
let edgeStats = null; // the Subject edge source: the measured GPU time and the Max age limit
let currentFile = null;
const settings = clone(DEFAULTS);
// The store state: { short (the preview setting), width, height, n, bytes, budget }.
const store = { short: 540, budget: 0, failAlloc: 0 };
const mapInfo = { mapFrames: 0 };

function showMessage(text) {
  const m = $('message');
  m.textContent = text || '';
  m.hidden = !text;
}

function status() {
  const info = player.info;
  const s = $('status');
  if (!info) return;
  const fps = player.stats.fps;
  const slow = player.playing && fps > 0 && fps < info.fps * 0.9 && player.stats.shown > 10;
  s.classList.toggle('warn', slow);
  const parts = [bufferText(store.n, store.width, store.height), `${info.fps.toFixed(info.fps % 1 ? 2 : 0)} fps`];
  if (analysis && analysis.running) parts.unshift(`Analysis ${Math.round(analysis.progress * 100)} %`);
  if (slow) parts.push(`Preview ${Math.round(fps)} fps`);
  else parts.push(`${info.width}×${info.height}`);
  s.textContent = parts.join(' · ');
}

// Make the store for the working size (plan §6.4). The store is empty after this.
async function configureStore() {
  const info = player.info;
  const { width, height } = workingSize(info.width, info.height, store.short);
  const r = await gpu.call({ cmd: 'configure', width, height, rotation: info.rotation, budget: store.budget || defaultBudget(navigator.userAgent), failAlloc: store.failAlloc, frames: info.times.length });
  Object.assign(store, { width, height, n: r.n, bytes: r.bytes, usedBudget: r.budget, rows: r.rows, edgeRows: r.edgeRows });
  if (settings.slitscan.maxAge > r.rows) settings.slitscan.maxAge = r.rows;
  if (r.edgeRows && settings.slitscan.maxAgeEdge > r.edgeRows) settings.slitscan.maxAgeEdge = r.edgeRows;
  edgeStats = null;
  if (analysis) analysis.doneKey = ''; // the history is new and empty
  toolState.plateOk = !!r.plate; // the engine keeps the clean plate (scaled) when the size changes
  player.setStore(r.n);
  preview.setSize(width, height);
  // The Max delay cannot be more than N - 1 (plan §6.4).
  if (settings.timemap.maxDelay > r.n - 1) settings.timemap.maxDelay = r.n - 1;
  inspector.build(settings, limits());
  await applySettings();
  updateThumbs();
  handles.update();
  scheduleAnalysis();
  ensurePlate();
  return r;
}

// The cutout needs the mask (plan §9): Cutout on, the Mask view, or a subject map.
const maskUsed = () => settings.cutout.mode !== 'off' || settings.view === 'mask' || (settings.mode === 'timemap' && usesMask(settings.map));

// Background difference needs a clean plate: make the Auto plate when the mask is used first.
function ensurePlate() {
  if (player.info && maskUsed() && settings.cutout.bgdiff.on && !toolState.plateOk && !plateJob && settings.cutout.plate === 'auto') makePlate('auto');
}

// The clean plate (plan §9.2). Auto: the median of 31 frames (decode worker + analysis worker).
let plateJob = null;
async function makePlate(kind) {
  if (!player.info) return;
  settings.cutout.plate = kind;
  if (kind === 'frame') {
    const r = await gpu.call({ cmd: 'plateFrame', index: Math.max(0, player.current) });
    Object.assign(toolState, { plateOk: r.ok, plateText: r.ok ? `Frame ${player.current}` : 'No frame' });
  } else if (kind === 'image') {
    const input = $('plateFileInput');
    input.value = '';
    input.click();
    return;
  } else {
    if (plateJob) plateJob.terminate();
    const wk = (plateJob = makeWorker(DECODE_WORKER));
    const list = plateIndices(player.frameCount);
    toolState.plateText = 'Making the clean plate…';
    inspector.build(settings, limits());
    // Each frame as the store keeps it (Y, CbCr), from the GPU.
    const frames = await new Promise((resolve, reject) => {
      const Y = [], C = [];
      wk.onmessage = async (e) => {
        const m = e.data;
        if (m.cmd === 'info') wk.postMessage({ cmd: 'list', job: 1, indices: list });
        else if (m.cmd === 'frame') {
          const r = await gpu.call({ cmd: 'plateGrab', frame: m.frame }, [m.frame]);
          wk.postMessage({ cmd: 'ack' });
          Y.push(r.Y);
          C.push(r.C);
          setProgress((0.9 * Y.length) / list.length);
          if (Y.length === list.length) resolve({ Y, C });
        } else if (m.cmd === 'error') reject(new Error(m.message));
      };
      wk.postMessage({ cmd: 'open', file: currentFile });
    }).catch((e) => {
      showMessage(e.message);
      return null;
    });
    wk.terminate();
    if (plateJob !== wk) return;
    plateJob = null;
    if (!frames) return setProgress(null);
    const aw = makeWorker(ANALYSIS_WORKER);
    const med = await new Promise((resolve) => {
      aw.onmessage = (e) => resolve(e.data);
      aw.postMessage({ cmd: 'median', Y: frames.Y, C: frames.C }, [...frames.Y, ...frames.C].map((a) => a.buffer));
    });
    aw.terminate();
    setProgress(null);
    await gpu.call({ cmd: 'plateYuv', Y: med.Y, C: med.C }, [med.Y.buffer, med.C.buffer]);
    Object.assign(toolState, { plateOk: true, plateText: `Median of ${frames.Y.length} frames` });
    scheduleAnalysis();
  }
  inspector.build(settings, limits());
}

async function plateImage(file) {
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    await gpu.call({ cmd: 'plateImage', bitmap }, [bitmap]);
    Object.assign(toolState, { plateOk: true, plateText: file.name });
  } catch {
    showMessage('This image file cannot be read (PNG, JPEG, or WebP).');
  }
  inspector.build(settings, limits());
}

// Mask import (plan §9.3): a black-and-white mask video, one frame for each source frame.
function importMask() {
  const input = $('maskFileInput');
  input.value = '';
  input.click();
}

async function loadMaskVideo(file) {
  if (!file || !player.info) return;
  const wk = makeWorker(DECODE_WORKER);
  try {
    await new Promise((resolve, reject) => {
      let count = 0, rot = 0, done = 0;
      wk.onmessage = async (e) => {
        const m = e.data;
        if (m.cmd === 'error') return reject(new Error(m.message));
        if (m.cmd === 'info') {
          count = Math.min(m.times.length, player.frameCount);
          rot = m.rotation;
          await gpu.call({ cmd: 'maskImportBegin', width: store.width, height: store.height, count });
          wk.postMessage({ cmd: 'play', job: 1, from: 0, to: count - 1 });
        } else if (m.cmd === 'frame') {
          await gpu.call({ cmd: 'maskImportFrame', i: m.index, frame: m.frame, rotation: rot }, [m.frame]);
          wk.postMessage({ cmd: 'ack' });
          setProgress(++done / count);
        } else if (m.cmd === 'done') {
          await gpu.call({ cmd: 'caps' }); // all frames are in
          resolve();
        }
      };
      wk.postMessage({ cmd: 'open', file });
    });
    settings.cutout.import = { on: true, name: file.name };
  } catch (e) {
    showMessage(e.message);
  }
  wk.terminate();
  setProgress(null);
  inspector.build(settings, limits());
  await applySettings();
}

async function removeMask() {
  settings.cutout.import = { on: false, name: '' };
  await gpu.call({ cmd: 'maskImportClear' });
  inspector.build(settings, limits());
  await applySettings();
}

function setTool(tool) {
  tools.setTool(tool);
}

async function pick(u, v) {
  const r = await gpu.call({ cmd: 'pick', index: Math.max(0, player.current), u, v });
  const hex = `#${r.rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  settings.cutout.chroma.on = true;
  change('cutout.chroma.key', hex);
  tools.setTool(null);
}

const limits = () => ({ maxDelay: Math.max(0, store.n - 1), maxAge: Math.max(1, store.rows || 1), maxAgeEdge: Math.max(1, store.edgeRows || 1) });

// Mode 2 with the Subject edge source (or Scan object).
const edgeMode = () => settings.mode === 'slitscan' && (settings.slitscan.source === 'edge' || settings.cutout.mode === 'scan');

// The GPU time of the trail and the Max age limit (plan §8.4), shown in the inspector.
let edgeTimer = 0;
function refreshEdgeStats() {
  clearTimeout(edgeTimer);
  edgeTimer = setTimeout(async () => {
    if (!edgeMode() || !player.info) return;
    const r = await gpu.call({ cmd: 'slitStatus' });
    edgeStats = r.edge;
    const note = document.querySelector('#inspector .edgeLimit');
    if (note && edgeStats) note.textContent = `Limit: ${edgeStats.limit} frames (GPU ${edgeStats.ms.toFixed(1)} ms for ${edgeStats.maxAge} frames; target 20 ms)`;
  }, 200);
}

// Mode 2: the analysis pass fills the slit history for the line (plan §8.3). It runs again when the
// line, the slit width, the working size, or the file changes (300 ms after the last change).
const slitKey = () => {
  const sl = settings.slitscan;
  if (edgeMode()) {
    // The emitters need the mask: its settings, the clean plate, the matte, the imported mask.
    return JSON.stringify(['edge', currentFile && currentFile.name, sl.edgeAngle, sl.flip, settings.cutout, toolState.plateText, toolState.matteVersion, store.width, store.height]);
  }
  return JSON.stringify([currentFile && currentFile.name, sl.x, sl.y, sl.angle, sl.flip, sl.width, store.width, store.height]);
};
let analysisTimer = 0;
function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  if (settings.mode !== 'slitscan' || !player.info || !currentFile) return;
  // The edge source with background difference: wait for the clean plate (it schedules again).
  const C = settings.cutout;
  if (edgeMode() && C.bgdiff.on && !C.import.on && !toolState.plateOk) return;
  const key = slitKey();
  if (key === analysis.doneKey || key === analysis.key) return;
  analysisTimer = setTimeout(() => {
    if (settings.mode === 'slitscan' && slitKey() === key) analysis.start(currentFile, player.frameCount, key);
  }, 300);
}

// The history that the effect needs: Mode 1, the Max delay (and the frames of the Motion map).
function effectDepth() {
  if (settings.mode !== 'timemap' || settings.view === 'original') return 0; // Mode 2 uses the slit history
  const m = settings.map;
  const motion = m.source === 'builtin' && m.type === 'motion' ? m.params.motion.frames + 1 : 0;
  return Math.max(settings.timemap.maxDelay, motion);
}

// The map thumbnails (plan §12.4): each built-in map with its params, at the current frame.
let thumbTimer = 0;
function updateThumbs(only) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    if (!player.info || settings.map.source !== 'builtin') return;
    const ids = only ? [only] : MAPS.filter((m) => !m.needs).map((m) => m.id);
    const maps = ids.map((id) => ({ ...clone(settings.map), source: 'builtin', type: id, anim: { ...settings.map.anim }, adjust: settings.map.adjust }));
    const r = await gpu.call({ cmd: 'thumbs', maps, t: Math.max(0, player.current), width: THUMB_W, height: THUMB_H });
    inspector.drawThumbs(Object.fromEntries(ids.map((id, i) => [id, r.images[i]])));
  }, only ? 120 : 30);
}

// Open a custom map file (plan §7.4).
function openMap(kind) {
  const input = $('mapFileInput');
  // video/*: the iOS picker closes when a video is touched (a list of types gives a picker without
  // a Done button on iPad). The app checks the file itself (MP4 / MOV).
  input.accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/*';
  input.dataset.kind = kind;
  input.value = '';
  input.click();
}

async function loadMapFile(file, kind) {
  if (!file) return;
  showMessage('');
  try {
    if (kind === 'image') {
      await loadImageMap(file, gpu);
      settings.map.image.name = file.name;
      // Kept for a preset file (a data URL, read here: no network).
      mapInfo.imageDataUrl = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(file);
      });
    } else {
      const caps = await gpu.call({ cmd: 'caps' });
      const r = await loadVideoMap(file, gpu, { workerSrc: DECODE_WORKER, short: Math.min(store.height || 540, 540), maxLayers: caps.maxLayers, onProgress: setProgress });
      settings.map.video.name = file.name;
      mapInfo.mapFrames = r.count;
      setProgress(null);
    }
    settings.map.source = kind;
  } catch (e) {
    setProgress(null);
    showMessage(e.message);
    return;
  }
  inspector.build(settings, limits());
  await applySettings();
}

// Send the settings to the engine. When the effect needs more history, a seek decodes it.
async function applySettings() {
  const r = gpu.call({ cmd: 'settings', settings: clone(settings) });
  const depth = effectDepth();
  const more = depth > player.depth;
  player.depth = depth;
  if (more && player.info && !player.playing && player.current >= 0) await player.seek(player.current);
  await r;
}

// A setting changed in the UI. final: the end of a drag (the next change is a new undo step).
// The view (and the split divider) is not a look: no undo step.
function change(path, value, final) {
  if (path !== 'view' && path !== 'splitPos' && JSON.stringify(getPathSafe(path)) !== JSON.stringify(value)) {
    history.record(JSON.stringify(settings), path);
    if (final) history.cut();
  }
  setPath(settings, path, value);
  // The Subject edge source needs the cutout (plan §8.5); Scan object is Mode 2 only.
  if (path === 'slitscan.source' && value === 'edge' && settings.cutout.mode === 'off') settings.cutout.mode = 'overlay';
  if (path === 'cutout.mode' && value === 'off' && settings.slitscan.source === 'edge') settings.slitscan.source = 'line';
  if (path === 'mode' && value === 'timemap' && settings.cutout.mode === 'scan') settings.cutout.mode = 'overlay';
  const rebuild = ['map.source', 'map.type', 'mode', 'composite.mode', 'composite.decay', 'look.tint', 'slitscan.time', 'slitscan.rateType',
    'cutout.mode', 'cutout.bgdiff.on', 'cutout.chroma.on', 'cutout.luma.on', 'cutout.hysteresis', 'subject.outline', 'slitscan.source'];
  if (rebuild.includes(path) || (path === 'look.offset' && (value > 0) !== !!document.querySelector('[data-key="look.offsetAngle"]'))) {
    inspector.build(settings, limits());
    updateThumbs();
  } else inspector.refresh(settings);
  if (path.startsWith('map.params.')) updateThumbs(path.split('.')[2]);
  else if (path.startsWith('map.adjust.') || path.startsWith('map.anim.')) updateThumbs();
  if (path === 'view') viewChanged();
  handles.update();
  saveLocal();
  undoButtons();
  if (path === 'mode' || path.startsWith('slitscan.') || (edgeMode() && path.startsWith('cutout.'))) scheduleAnalysis();
  refreshEdgeStats();
  if (path === 'view' || path.startsWith('cutout.') || path.startsWith('map.')) ensurePlate();
  applySettings();
}

function setProgress(f) {
  const p = $('progress');
  p.hidden = f === null || f === undefined;
  if (!p.hidden) p.style.width = `${Math.round(f * 100)}%`;
}

// The loading indicator (a file opens; it can take some seconds for a large file).
function setLoading(text) {
  const el = $('loading');
  el.hidden = !text;
  $('loadingText').textContent = text || '';
  document.body.classList.toggle('loading', !!text);
}

async function openFile(file) {
  if (!file) return;
  // The name or the type says video; the reader checks the file (MP4 / MOV only).
  if (!/\.(mp4|mov|m4v)$/i.test(file.name) && !/^video\//.test(file.type)) {
    showMessage('Only MP4 and MOV files are supported.');
    return;
  }
  showMessage('');
  setLoading(`Opening ${file.name}…`);
  try {
    timeline.reset();
    if (analysis) analysis.stop();
    if (plateJob) plateJob.terminate();
    plateJob = null;
    Object.assign(toolState, { plateOk: false, plateText: '' });
    settings.cutout.import = { on: false, name: '' };
    currentFile = file;
    let info;
    try {
      info = await player.open(file);
    } catch (e) {
      document.body.dataset.state = 'start';
      $('view').hidden = true;
      showMessage(e.message);
      return;
    }
    setLoading(`Preparing ${file.name}…`);
    document.body.dataset.state = 'open';
    $('view').hidden = false;
    $('exportBtn').disabled = !platform.encoder;
    $('exportBtn').title = platform.encoder ? '' : 'This browser has no video encoder.';
    handles.update();
    try {
      await configureStore();
    } catch (e) {
      showMessage(e.message);
      return;
    }
    await player.seek(0);
    status();
  } finally {
    setLoading(null);
  }
}

// Export (plan §11): the engine is made again at the export size, then at the preview size after.
async function exportVideo(opts, onProgress = () => {}) {
  if (!player.info || exporter) throw new Error('Nothing to export.');
  player.pause();
  analysis.stop();
  clearTimeout(analysisTimer);
  const view = settings.view;
  settings.view = 'result'; // the export is the result, whatever the preview shows
  let an = null, rejectAnalysis = null;
  exporter = new Exporter({
    gpu, decodeSrc: DECODE_WORKER, encodeSrc: ENCODE_WORKER, settings,
    file: () => currentFile,
    info: () => player.info,
    configure: async (w, h) => {
      await gpu.call({ cmd: 'settings', settings: clone(settings) });
      const r = await gpu.call({ cmd: 'configure', width: w, height: h, rotation: player.info.rotation, budget: store.usedBudget || store.budget || defaultBudget(navigator.userAgent), frames: player.frameCount });
      await gpu.call({ cmd: 'settings', settings: clone(settings) });
      return r;
    },
    analyse: (onP) => new Promise((resolve, reject) => {
      rejectAnalysis = reject;
      an = new Analysis(DECODE_WORKER, gpu, { onProgress: (f) => f !== null && onP(f), onRows() {}, onDone: resolve });
      an.start(currentFile, player.frameCount, 'export');
    }),
    depth: () => effectDepth(),
  });
  const ex = exporter;
  const cancel = ex.cancel.bind(ex);
  ex.cancel = () => {
    cancel();
    if (an) an.stop();
    if (rejectAnalysis) rejectAnalysis(new Error('Export cancelled'));
  };
  try {
    return await ex.run(opts, onProgress);
  } finally {
    settings.view = view;
    exporter = null;
    // The preview again.
    await configureStore();
    await player.seek(Math.max(0, player.current));
    status();
  }
}

// The export dialog: a warning when the Max delay does not fit the buffer at that size (plan §6.4).
function exportCheck(w, h) {
  if (settings.mode !== 'timemap') return '';
  const n = layerCount(store.usedBudget || defaultBudget(navigator.userAgent), gpuCaps.maxLayers, w, h);
  const depth = settings.timemap.maxDelay;
  return depth > n - 1 ? `The Max delay (${depth} frames) is more than the buffer at ${Math.min(w, h)}p (${n} frames). Choose a lower resolution, or a smaller Max delay.` : '';
}

function keys(e) {
  if (!player.info || e.target.closest('input, select, textarea')) return;
  const P = player;
  const k = e.key;
  if (k === ' ') {
    // Space toggles playback when it comes up (Space + drag pans the preview, plan §12.2).
    if (!e.repeat) stopReverse();
  }
  else if (k === 'ArrowLeft') P.step(e.shiftKey ? -10 : -1);
  else if (k === 'ArrowRight') P.step(e.shiftKey ? 10 : 1);
  else if (k === 'Home') P.seek(0);
  else if (k === 'End') P.seek(P.frameCount - 1);
  else if (k === 'i' || k === 'I') timeline.setIn();
  else if (k === 'o' || k === 'O') timeline.setOut();
  else if (k === 'm' || k === 'M') change('view', settings.view === 'mask' ? 'result' : 'mask');
  else if ((k === 'e' || k === 'E') && (e.ctrlKey || e.metaKey)) exportDialog.open();
  else if ((k === 'z' || k === 'Z') && (e.ctrlKey || e.metaKey)) (e.shiftKey ? redo() : undo());
  else if ((k === 'y' || k === 'Y') && (e.ctrlKey || e.metaKey)) redo();
  else if (k === 'j' || k === 'J') playReverse();
  else if (k === 'k' || k === 'K') stopAll();
  else if (k === 'l' || k === 'L') {
    stopReverse();
    if (!P.playing) P.play();
  } else if (k === '\\') {
    // Hold: the original (plan §12.7).
    if (!e.repeat && holdView === null) {
      holdView = settings.view;
      setView('original');
    }
  } else return;
  e.preventDefault();
}

// J: play backward (a step back at the frame rate, from the frames in the store when they are there).
let reverse = 0;
function playReverse() {
  if (!player.info) return;
  player.pause();
  stopReverse();
  const step = async () => {
    if (!reverse) return;
    if (player.current <= 0) return stopReverse();
    const t0 = performance.now();
    await player.step(-1);
    if (reverse) reverse = setTimeout(step, Math.max(0, 1000 / player.info.fps - (performance.now() - t0)));
  };
  reverse = setTimeout(step, 0);
  document.body.dataset.reverse = '1';
}
function stopReverse() {
  clearTimeout(reverse);
  reverse = 0;
  delete document.body.dataset.reverse;
}
function stopAll() {
  stopReverse();
  player.pause();
}

let holdView = null;
function keysUp(e) {
  if (e.key === ' ' && player.info && !e.target.closest('input, select, textarea')) {
    e.preventDefault();
    if (!preview.spacePanned) player.toggle();
    preview.spacePanned = false;
    return;
  }
  if (e.key === '\\' && holdView !== null) {
    const v = holdView;
    holdView = null;
    setView(v);
  }
}

// The view without a change of the settings history.
function setView(v) {
  settings.view = v;
  viewChanged();
  handles.update();
  applySettings();
}

function viewChanged() {
  for (const b of document.querySelectorAll('#viewBar button[data-view]')) b.classList.toggle('on', b.dataset.view === settings.view);
  layout.placeSplit(settings.view === 'split' && player.info ? settings.splitPos : null);
}

const getPathSafe = (path) => {
  try {
    return path.split('.').reduce((x, k) => x[k], settings);
  } catch {
    return undefined;
  }
};

// Put a whole settings object in place (undo, redo, a preset, randomize, the saved settings).
function replaceSettings(next) {
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, clone(next));
  inspector.build(settings, limits());
  viewChanged();
  handles.update();
  updateThumbs();
  if (player.info) {
    scheduleAnalysis();
    ensurePlate();
  }
  saveLocal();
  undoButtons();
  return applySettings();
}

function undo() {
  const prev = history.undo(JSON.stringify(settings));
  if (prev) return replaceSettings({ ...JSON.parse(prev), view: settings.view, splitPos: settings.splitPos });
}

function redo() {
  const next = history.redo(JSON.stringify(settings));
  if (next) return replaceSettings({ ...JSON.parse(next), view: settings.view, splitPos: settings.splitPos });
}

function undoButtons() {
  $('undoBtn').disabled = !history.canUndo;
  $('redoBtn').disabled = !history.canRedo;
  for (const b of document.querySelectorAll('#menu button[data-act="undo"]')) b.disabled = !history.canUndo;
  for (const b of document.querySelectorAll('#menu button[data-act="redo"]')) b.disabled = !history.canRedo;
}

// The last settings stay in the browser (plan §12.5), with try / catch (private windows, no storage).
let saveTimer = 0;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(settings));
    } catch { /* no storage */ }
  }, 250);
}

function loadLocal() {
  try {
    const t = localStorage.getItem(LOCAL_KEY);
    if (!t) return null;
    const s = merge(DEFAULTS, JSON.parse(t));
    // The files of custom maps and mask videos are not stored: back to the built-in map, no import.
    if (s.map.source !== 'builtin') s.map.source = 'builtin';
    s.cutout.import = { on: false, name: '' };
    if (s.view === 'split' || s.view === 'mask') s.view = 'result';
    return s;
  } catch {
    return null;
  }
}

// Randomize (plan §12.5): the sections of the mode that are not locked (or the given ones), with a
// seed (the same seed gives the same look). One undo step.
const MODE_SECTIONS = { timemap: ['map', 'adjust', 'anim', 'time', 'composite', 'look'], slitscan: ['source', 'time2', 'composite', 'look'] };
function randomize(sections, seed) {
  lastSeed = seed ?? Math.floor(Math.random() * 1e6);
  const list = (sections || MODE_SECTIONS[settings.mode]).filter((sec) => sections || !locks.has(sec));
  history.record(JSON.stringify(settings), 'randomize');
  history.cut();
  const next = clone(settings);
  const r = rng(lastSeed);
  for (const sec of list) randomizeSection(next, sec, r, limits());
  return replaceSettings(next);
}

function toggleLock(name) {
  if (locks.has(name)) locks.delete(name);
  else locks.add(name);
  inspector.build(settings, limits());
}

// Presets (plan §12.5): the gallery, Save, Load.
function openPresets() {
  const grid = $('presetGrid');
  grid.textContent = '';
  for (const p of PRESETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'presetCard';
    card.dataset.preset = p.id;
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    card.append(c, Object.assign(document.createElement('span'), { textContent: p.name }));
    card.addEventListener('click', () => {
      history.record(JSON.stringify(settings), 'preset');
      history.cut();
      replaceSettings(applyPreset(settings, p));
      $('presetDialog').close();
    });
    grid.append(card);
    presetThumb(p, c);
  }
  $('presetDialog').showModal();
}

// A preset thumbnail: the map of a Mode 1 preset (GPU), a line and an arrow for Mode 2.
async function presetThumb(p, c) {
  const s = applyPreset(settings, p);
  const ctx = c.getContext('2d');
  // Maps of the frames or of the mask (Motion, Video luminance, Subject) have no picture without
  // them: an icon (a disc and its trail) for those.
  const iconMap = ['motion', 'self', 'subject', 'subjectdist'].includes(s.map.type);
  if (s.mode === 'timemap' && s.map.source === 'builtin' && !iconMap) {
    try {
      const r = await gpu.call({ cmd: 'thumbs', maps: [s.map], t: Math.max(0, player.current), width: 160, height: 90 });
      const y = r.images[0];
      const img = ctx.createImageData(160, 90);
      for (let i = 0; i < y.length; i++) img.data.set([y[i], y[i], y[i], 255], i * 4);
      ctx.putImageData(img, 0, 0);
    } catch { /* no thumbnail */ }
    return;
  }
  const g = ctx.createLinearGradient(0, 0, 160, 0);
  g.addColorStop(0, '#222');
  g.addColorStop(1, '#4fd1c5');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 160, 90);
  if (s.mode === 'timemap') {
    for (let i = 5; i >= 0; i--) {
      ctx.fillStyle = `rgba(255,255,255,${1 - i / 6})`;
      ctx.beginPath();
      ctx.arc(110 - i * 12, 45, 14, 0, 2 * Math.PI);
      ctx.fill();
    }
    return;
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  const sl = s.slitscan;
  const a = ((sl.source === 'edge' || s.cutout.mode === 'scan' ? sl.edgeAngle : sl.angle - 90) * Math.PI) / 180;
  ctx.beginPath();
  ctx.moveTo(80, 45);
  ctx.lineTo(80 + Math.cos(a) * 50, 45 + Math.sin(a) * 30);
  ctx.stroke();
  if (sl.source === 'edge' || s.cutout.mode === 'scan') {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(80, 45, 12, 0, 2 * Math.PI);
    ctx.fill();
  }
}

async function savePreset() {
  const assets = {};
  if (settings.map.source === 'image' && mapInfo.imageDataUrl) assets.mapImage = mapInfo.imageDataUrl;
  if (player.info) {
    const m = await gpu.call({ cmd: 'matteGet' });
    if (!m.empty) {
      const c = document.createElement('canvas');
      c.width = m.width;
      c.height = m.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.pixels.buffer), m.width, m.height), 0, 0);
      assets.matte = c.toDataURL('image/png');
    }
  }
  const file = presetFile(settings, VERSION, assets);
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'neofx')}.neofx.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return file;
}

async function loadPreset(file) {
  if (!file) return;
  let p;
  try {
    p = parsePresetFile(await file.text());
  } catch (e) {
    showMessage(e.message);
    return;
  }
  history.record(JSON.stringify(settings), 'preset');
  history.cut();
  const s = { ...p.settings, view: settings.view, splitPos: settings.splitPos };
  const notes = [];
  // A video map (and a mask video) is stored by its name: ask for the file.
  const video = s.map.source === 'video' ? s.map.video.name : null;
  if (video) s.map.source = 'builtin';
  if (s.cutout.import.on) {
    notes.push(`Open the mask video "${s.cutout.import.name}" in Cutout.`);
    s.cutout.import = { on: false, name: '' };
  }
  if (s.map.source === 'image' && !p.assets.mapImage) s.map.source = 'builtin';
  await replaceSettings(s);
  if (p.assets.mapImage && settings.map.source === 'image') {
    try {
      await loadImageMap(dataUrlBlob(p.assets.mapImage), gpu);
      mapInfo.imageDataUrl = p.assets.mapImage;
      await applySettings();
    } catch {
      notes.push('The image map of the preset cannot be read.');
    }
  }
  if (p.assets.matte && player.info) {
    const m = await gpu.call({ cmd: 'matteGet' });
    const bitmap = await createImageBitmap(dataUrlBlob(p.assets.matte), { resizeWidth: m.width, resizeHeight: m.height, colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    await gpu.call({ cmd: 'matteSet', bitmap }, [bitmap]);
    toolState.matteVersion++;
  }
  if (video) {
    notes.unshift(`This preset uses the video map "${video}": open it.`);
    openMap('video');
  }
  showMessage(notes.join(' '));
  $('presetDialog').close();
}

async function start() {
  document.title = `neofx ${VERSION}`;
  const p = (platform = await checkPlatform());
  window.neofx = { version: VERSION, platform: p };
  if (!p.ok) {
    document.body.dataset.state = 'unsupported';
    showMessage(p.fatal);
    return;
  }
  if (p.notes.length) showMessage(p.notes.join(' '));
  preview = new Preview($('view'), $('preview'));
  const forceMain = /[?&]gpu=main\b/.test(location.search);
  gpu = new GpuClient($('view'), GPU_WORKER, p.offscreen && !forceMain);
  try {
    gpuCaps = await gpu.ready;
  } catch (e) {
    showMessage(e.message);
    return;
  }
  player = new Player(DECODE_WORKER, {
    consume: (index, frame, show) => gpu.call({ cmd: 'upload', index, frame, show }, [frame]),
    render: (index) => gpu.call({ cmd: 'render', index }),
    onState: () => {
      timeline.update();
      status();
    },
    onThumb: (i, index, bitmap) => timeline.addThumb(i, index, bitmap),
    onError: (msg) => showMessage(msg),
    onProgress: setProgress,
  });
  timeline = new Timeline($('transport'), player);
  handles = new LineHandles($('preview'), $('view'), { change, settings, tools: toolState, edgeMode: () => edgeMode() });
  analysis = new Analysis(DECODE_WORKER, gpu, {
    onProgress: (f) => {
      setProgress(f);
      status();
    },
    // New rows: show them on a paused preview.
    onRows: () => {
      if (!player.playing && !player.busy && player.current >= 0) gpu.call({ cmd: 'render', index: player.current });
    },
    onDone: () => {
      status();
      refreshEdgeStats();
    },
  });
  tools = new PreviewTools($('preview'), $('view'), {
    pick,
    stroke: (points, mode) => {
      toolState.matteVersion++;
      scheduleAnalysis();
      return gpu.call({ cmd: 'matteStroke', points, size: toolState.brush.size, hardness: toolState.brush.hardness, mode });
    },
    brush: toolState.brush,
    onTool: (t) => {
      toolState.tool = t;
      for (const b of document.querySelectorAll('#inspector .toolRow button[data-act]')) b.classList.toggle('on', b.dataset.act === t);
      handles.update();
    },
  });
  inspector = new Inspector($('inspector'), {
    change, openMap, info: () => mapInfo, tools: toolState, setTool, plate: makePlate, importMask, removeMask,
    clearMatte: () => {
      toolState.matteVersion++;
      scheduleAnalysis();
      return gpu.call({ cmd: 'matteClear' });
    },
    edgeStats: () => edgeStats,
    locks,
    toggleLock,
    randomize: (list) => randomize(list),
    lastSeed: () => lastSeed,
  });
  const saved = loadLocal();
  if (saved) {
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, saved);
  }
  inspector.build(settings, { maxDelay: 999, maxAge: 600, maxAgeEdge: 512 });
  gpu.call({ cmd: 'settings', settings: clone(settings) });
  for (const b of document.querySelectorAll('#viewBar button[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
  for (const b of document.querySelectorAll('#viewBar button[data-zoom]')) {
    b.addEventListener('click', () => {
      preview.setZoom(b.dataset.zoom === 'fit' ? 'fit' : 1);
      for (const x of document.querySelectorAll('#viewBar button[data-zoom]')) x.classList.toggle('on', x === b);
    });
  }
  layout = initLayout({
    menu: { presets: openPresets, undo, redo },
    split: (pos) => {
      if (pos === null) return;
      settings.splitPos = pos;
      layout.placeSplit(pos);
      applySettings();
    },
    onResize: () => preview.fit(),
  });
  preview.onChange = () => {
    handles.update();
    viewChanged();
  };
  $('presetsBtn').addEventListener('click', openPresets);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('presetClose').addEventListener('click', () => $('presetDialog').close());
  $('presetSave').addEventListener('click', savePreset);
  $('presetLoad').addEventListener('click', () => {
    $('presetFileInput').value = '';
    $('presetFileInput').click();
  });
  $('presetFileInput').addEventListener('change', (e) => loadPreset(e.target.files[0]));
  document.addEventListener('keyup', keysUp);
  startDemos($('demoTime'), $('demoSlit'));
  undoButtons();
    exportDialog = new ExportDialog($('exportDialog'), {
    info: () => player.info,
    file: () => currentFile,
    range: () => (player.inPoint !== null || player.outPoint !== null ? player.range() : null),
    hasAudio: () => !!(player.info && player.info.audio),
    check: exportCheck,
    run: exportVideo,
    cancel: () => exporter && exporter.cancel(),
  });
  $('exportBtn').addEventListener('click', () => exportDialog.open());
  Object.assign(window.neofx, { undo, redo, history, randomize, locks, toggleLock, openPresets, savePreset, loadPreset, PRESETS, setView, playReverse, stopAll, exportVideo, exportDialog, cancelExport: () => exporter && exporter.cancel(), refreshEdgeStats, edgeMode, player, preview, timeline, gpu, store, settings, inspector, openFile, configureStore, change, applySettings, loadMapFile, updateThumbs, analysis, handles, slitKey, tools, toolState, makePlate, loadMaskVideo, removeMask });
  $('plateFileInput').addEventListener('change', (e) => plateImage(e.target.files[0]));
  $('maskFileInput').addEventListener('change', (e) => loadMaskVideo(e.target.files[0]));
  $('mapFileInput').addEventListener('change', (e) => loadMapFile(e.target.files[0], e.target.dataset.kind));
  $('resSelect').addEventListener('change', async (e) => {
    store.short = Number(e.target.value);
    if (!player.info) return;
    player.pause();
    const t = Math.max(0, player.current);
    await configureStore();
    await player.seek(t);
    status();
  });
  $('openBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
  document.addEventListener('keydown', keys);
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('drag');
  });
  document.addEventListener('dragleave', () => document.body.classList.remove('drag'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('drag');
    openFile(e.dataTransfer.files[0]);
  });
}

start();
