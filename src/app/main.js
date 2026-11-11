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

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';
const DECODE_WORKER = "@WORKER:io/demux.js,io/timeline.js,io/decode-worker.js";
const GPU_WORKER = "@WORKER:maps/builtin.js,maps/curve.js,modes/slit.js,analysis/regions.js,gpu/store.js,gpu/gl.js,gpu/blend.js,gpu/mapgen.js,gpu/slit.js,gpu/mask.js,gpu/edge.js,gpu/engine.js,gpu/gpu-worker.js";
const ANALYSIS_WORKER = "@WORKER:analysis/cleanplate.js,analysis/analysis-worker.js";

let player, preview, timeline, gpu, inspector, analysis, handles, tools;
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
  toolState.plateOk = false; // the clean plate and the mask textures are new
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
  input.accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/mp4,video/quicktime,.mp4,.mov,.m4v';
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

// A setting changed in the UI.
function change(path, value) {
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
  if (path === 'view') for (const b of document.querySelectorAll('#viewBar button')) b.classList.toggle('on', b.dataset.view === value);
  handles.update();
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

async function openFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4v)$/i.test(file.name) && !/^video\/(mp4|quicktime)$/.test(file.type)) {
    showMessage('Only MP4 and MOV files are supported.');
    return;
  }
  showMessage('');
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
  document.body.dataset.state = 'open';
  $('view').hidden = false;
  handles.update();
  try {
    await configureStore();
  } catch (e) {
    showMessage(e.message);
    return;
  }
  await player.seek(0);
  status();
}

function keys(e) {
  if (!player.info || e.target.closest('input, select, textarea')) return;
  const P = player;
  const k = e.key;
  if (k === ' ') P.toggle();
  else if (k === 'ArrowLeft') P.step(e.shiftKey ? -10 : -1);
  else if (k === 'ArrowRight') P.step(e.shiftKey ? 10 : 1);
  else if (k === 'Home') P.seek(0);
  else if (k === 'End') P.seek(P.frameCount - 1);
  else if (k === 'i' || k === 'I') timeline.setIn();
  else if (k === 'o' || k === 'O') timeline.setOut();
  else if (k === 'm' || k === 'M') change('view', settings.view === 'mask' ? 'result' : 'mask');
  else return;
  e.preventDefault();
}

async function start() {
  document.title = `neofx ${VERSION}`;
  const p = await checkPlatform();
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
    await gpu.ready;
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
  });
  inspector.build(settings, { maxDelay: 999 });
  gpu.call({ cmd: 'settings', settings: clone(settings) });
  for (const b of document.querySelectorAll('#viewBar button')) b.addEventListener('click', () => change('view', b.dataset.view));
  Object.assign(window.neofx, { refreshEdgeStats, edgeMode, player, preview, timeline, gpu, store, settings, inspector, openFile, configureStore, change, applySettings, loadMapFile, updateThumbs, analysis, handles, slitKey, tools, toolState, makePlate, loadMaskVideo, removeMask });
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
