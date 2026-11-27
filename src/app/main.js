// neofx app: open a file, the preview (GPU engine), seek, play, timeline, the inspector, Mode 1
// (Time Map) and Mode 2 (Slit Scan, with its analysis pass and line handles).

import { checkPlatform } from './platform.js';
import { Player } from './player.js';
import { GpuClient } from './gpu-client.js';
import { Preview } from './preview.js';
import { workingSize, defaultBudget, bufferText, isIOS } from '../gpu/store.js';
import { Timeline } from './ui/timeline.js';
import { Inspector } from './ui/inspector.js';
import { DEFAULTS, clone, setPath, migrateSettings } from './settings.js';
import { MAPS } from '../maps/builtin.js';
import { loadImageMap, loadVideoMap, maskVideoSize } from '../maps/mapsource.js';
import { THUMB_W, THUMB_H } from './ui/inspector.js';
import { Analysis } from './analysis.js';
import { LineHandles } from './ui/handles.js';
import { PreviewTools } from './ui/tools.js';
import { plateIndices } from '../analysis/cleanplate.js';
import { makeWorker } from './player.js';
import { usesMask } from '../maps/builtin.js';
import { Exporter, cleanExportStorage } from './export.js';
import { ExportDialog } from './ui/exportdialog.js';
import { layerCount } from '../gpu/store.js';
import { History } from './history.js';
import { rng, randomizeSection } from './random.js';
import { PRESETS, PRESET_GROUPS, applyPreset, presetFile, parsePresetFile, dataUrlBlob, merge } from './presets.js';
import { initLayout } from './ui/layout.js';
import { startDemos } from './ui/startscreen.js';
import { runBench } from './bench.js';
import { Mosh, MOSH_LOOK } from './mosh.js';
import { PreviewAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';
const DECODE_WORKER = "@WORKER:io/demux.js,io/timeline.js,io/decode-worker.js";
const GPU_WORKER = "@WORKER:maps/builtin.js,maps/curve.js,modes/slit.js,analysis/regions.js,gpu/store.js,gpu/gl.js,gpu/blend.js,gpu/mapgen.js,gpu/slit.js,gpu/mask.js,gpu/edge.js,gpu/engine.js,gpu/gpu-worker.js";
const ANALYSIS_WORKER = "@WORKER:analysis/cleanplate.js,analysis/analysis-worker.js";
const ENCODE_WORKER = "@WORKER:io/encode-worker.js";
// Mode 3, Datamosh: the neomosh codec (with its WebAssembly kernels), the muxer, the recorder.
const MOSH_WORKER = "@WORKER:mosh/codec/bitio.js,mosh/codec/tables.js,mosh/codec/transform.js,mosh/codec/inter.js,mosh/codec/mvpred.js,mosh/codec/cavlc.js,mosh/codec/intra.js,mosh/codec/headers.js,mosh/codec/color.js,mosh/codec/wasm-bytes.js,mosh/codec/wasm.js,mosh/codec/decoder.js,mosh/codec/encoder.js,mosh/mux/mp4.js,mosh/mux/remux.js,mosh/capture.js,io/demux.js,mosh/mosh-worker.js";

let player, preview, timeline, gpu, inspector, analysis, handles, tools, exportDialog, gpuCaps, platform;
let exporter = null; // the export that runs
let mosh = null; // Mode 3, Datamosh
const sound = new PreviewAudio(); // the sound of the preview playback
const MUTE_KEY = 'neofx.muted';
let layout = null;
const history = new History();
const locks = new Set(); // the sections that Randomize keeps
let lastSeed = 0;
const LOCAL_KEY = 'neofx.settings';
// The state of the preview tools and the clean plate (not part of the settings).
const toolState = { tool: null, brush: { size: 40, hardness: 0.7 }, plateText: '', plateOk: false, matteVersion: 0, overlay: false, undoCount: 0 };
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

// A call whose failure needs no message here (a GPU restart reports itself).
const quiet = (p) => {
  if (p && p.catch) p.catch(() => {});
  return p;
};

// The 'open' message for a decode worker. For the video that is open, the clean sync samples are
// known from the player's worker, so the new worker does not scan the file again.
const fileKeys = (file) => (file === currentFile && player && player.info ? player.info.cleanKeys : undefined);
const openMsg = (file) => ({ cmd: 'open', file, keys: fileKeys(file) });

// The mute button: on / off, and why there is no sound (no audio track, no decoder).
function muteButton() {
  const b = $('muteBtn');
  const has = sound.available;
  b.disabled = !has;
  const off = sound.muted || !has;
  b.setAttribute('aria-pressed', String(off));
  b.setAttribute('aria-label', has ? (sound.muted ? 'Unmute' : 'Mute') : 'No sound');
  b.title = has ? (sound.muted ? 'Sound off (touch to turn it on)' : 'Sound on (touch to mute)') : sound.reason || 'No sound';
}

function setMuted(m) {
  sound.setMuted(m);
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch { /* no storage */ }
  // Unmuted while the video plays: the sound starts at the playhead.
  if (!m && player && player.playing && player.clock) {
    const now = performance.now();
    sound.start(player.clock.us + (now - player.clock.wall) * 1000, now);
  }
  muteButton();
}

// The state of the page ('start', 'open', 'unsupported'). The example animations of the start
// screen run only there.
let demos = null;
function setState(state) {
  document.body.dataset.state = state;
  if (demos) (state === 'start' ? demos.start : demos.stop)();
}

// The mode on the page: the Datamosh record bar, the view buttons, the Export button (the Datamosh
// export needs no encoder of the browser).
function modeChanged() {
  document.body.dataset.mode = settings.mode;
  const dm = settings.mode === 'datamosh';
  const ok = !!player && !!player.info && (dm || platform.encoder);
  $('exportBtn').disabled = !ok;
  $('exportBtn').title = ok || !player || !player.info ? '' : 'This browser has no video encoder.';
  if (mosh) {
    if (!dm && mosh.busy) {
      mosh.pause();
      mosh.stopPlay();
    }
    mosh.show();
  }
}

// The frame of the open video at a file time (the last frame that starts at or before it).
function frameAtUs(us) {
  const T = player.info.times;
  let lo = 0, hi = T.length - 1, r = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (T[m] <= us + 1) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
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
  const text = parts.join(' · ');
  if (s.textContent !== text) s.textContent = text; // (each shown frame: no layout when the same)
}

// Make the store for the working size (plan §6.4). The store is empty after this.
async function configureStore() {
  const info = player.info;
  const { width, height } = workingSize(info.width, info.height, store.short);
  const r = await gpu.call({ cmd: 'configure', width, height, rotation: info.rotation, budget: store.budget || defaultBudget(navigator.userAgent, navigator.maxTouchPoints), failAlloc: store.failAlloc, frames: info.times.length });
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
let platePromise = null; // the Auto plate that is being made
function makePlate(kind) {
  const p = makePlateNow(kind);
  if (kind !== 'frame' && kind !== 'image') {
    platePromise = p;
    const clear = () => {
      if (platePromise === p) platePromise = null;
    };
    p.then(clear, clear);
  }
  return p;
}

async function makePlateNow(kind) {
  if (!player.info) return;
  settings.cutout.plate = kind;
  if (kind === 'frame') {
    const r = await gpu.call({ cmd: 'plateFrame', index: Math.max(0, player.vcur) });
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
    // The working size of the plate. When the engine gets another size while the frames come (the
    // Preview setting, an export), the plate is made again.
    const w0 = store.width, h0 = store.height;
    let resized = false;
    // Each frame as the store keeps it (Y, CbCr), from the GPU.
    const frames = await new Promise((resolve, reject) => {
      const Y = [], C = [];
      // 'done' can come while the last frames are at the GPU: the end waits for them.
      let pending = 0, ended = false;
      const finish = () => {
        if (!ended || pending) return;
        // (A damaged file can give fewer frames: the median of the ones that came.)
        if (Y.length) resolve({ Y, C });
        else reject(new Error('The clean plate cannot be made: no frames.'));
      };
      wk.onerror = (e) => reject(new Error(e.message || 'Decode worker failed.'));
      wk.onmessage = async (e) => {
        const m = e.data;
        try {
          if (m.cmd === 'info') wk.postMessage({ cmd: 'list', job: 1, indices: list });
          else if (m.cmd === 'frame') {
            pending++;
            const r = await gpu.call({ cmd: 'plateGrab', frame: m.frame }, [m.frame]);
            pending--;
            if (r.Y.length !== w0 * h0) {
              resized = true;
              return resolve(null);
            }
            wk.postMessage({ cmd: 'ack' });
            Y.push(r.Y);
            C.push(r.C);
            setProgress((0.9 * Y.length) / list.length);
            if (Y.length === list.length) resolve({ Y, C });
            else finish();
          } else if (m.cmd === 'done') {
            ended = true;
            finish();
          } else if (m.cmd === 'error') reject(new Error(m.message));
        } catch (err) {
          reject(err); // the GPU call failed (a GPU restart makes the plate again)
        }
      };
      wk.postMessage(openMsg(currentFile));
    }).catch((e) => {
      if (plateJob === wk && !restarting) showMessage(e.message);
      return null;
    });
    wk.terminate();
    if (plateJob !== wk) return;
    plateJob = null;
    if (!frames) {
      setProgress(null);
      toolState.plateText = '';
      if (resized) ensurePlate();
      else inspector.build(settings, limits());
      return;
    }
    const aw = makeWorker(ANALYSIS_WORKER);
    const med = await new Promise((resolve) => {
      aw.onmessage = (e) => resolve(e.data);
      aw.onerror = () => resolve(null);
      aw.postMessage({ cmd: 'median', Y: frames.Y, C: frames.C }, [...frames.Y, ...frames.C].map((a) => a.buffer));
    });
    aw.terminate();
    setProgress(null);
    if (!med || store.width !== w0 || store.height !== h0) {
      toolState.plateText = '';
      if (med) ensurePlate();
      else {
        showMessage('The clean plate cannot be made (not enough memory).');
        inspector.build(settings, limits());
      }
      return;
    }
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
    gpuState.plateFile = file;
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
  showMessage('');
  try {
    const note = await new Promise((resolve, reject) => {
      let count = 0, rot = 0, done = 0, short = 0;
      wk.onerror = (e) => reject(new Error(e.message || 'Decode worker failed.'));
      wk.onmessage = async (e) => {
        const m = e.data;
        try {
          if (m.cmd === 'error') return reject(new Error(m.message));
          if (m.cmd === 'info') {
            const want = Math.min(m.times.length, player.frameCount);
            // The mask frames stay on the GPU: all of them in a memory budget (a long video gets a
            // smaller mask), and in the layer limit of the GPU.
            const budget = Math.min(256 * 1048576, defaultBudget(navigator.userAgent, navigator.maxTouchPoints) / 2);
            const size = maskVideoSize(store.width, store.height, want, gpuCaps.maxLayers, budget);
            count = size.count;
            short = want - count;
            rot = m.rotation;
            await gpu.call({ cmd: 'maskImportBegin', width: size.width, height: size.height, count });
            wk.postMessage({ cmd: 'play', job: 1, from: 0, to: count - 1 });
          } else if (m.cmd === 'frame') {
            await gpu.call({ cmd: 'maskImportFrame', i: m.index, frame: m.frame, rotation: rot }, [m.frame]);
            wk.postMessage({ cmd: 'ack' });
            setProgress(++done / count);
          } else if (m.cmd === 'done') {
            await gpu.call({ cmd: 'caps' }); // all frames are in
            resolve(short > 0 ? `The mask video is longer than the GPU can hold: the frames after frame ${count - 1} use its mask.` : '');
          }
        } catch (err) {
          reject(err);
        }
      };
      wk.postMessage(openMsg(file));
    });
    settings.cutout.import = { on: true, name: file.name };
    gpuState.maskFile = file;
    if (note) showMessage(note);
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

// The cutout overlay on the preview: while a brush is the tool, or with Show cutout.
const BRUSHES = ['always', 'never', 'erase'];
let overlaySent = false;
function syncOverlay() {
  const on = toolState.overlay || BRUSHES.includes(toolState.tool);
  if (on === overlaySent) return;
  overlaySent = on;
  quiet(gpu.call({ cmd: 'refine', on }));
}

function toggleOverlay() {
  toolState.overlay = !toolState.overlay;
  syncOverlay();
  inspector.build(settings, limits());
}

// Undo for the matte (the last strokes, a Clear): the matte before each one, read from the GPU.
const MATTE_UNDO = 8;
const matteUndo = []; // promises of { pixels, width, height }
function matteCheckpoint() {
  matteUndo.push(gpu.call({ cmd: 'matteGet' }).catch(() => null));
  if (matteUndo.length > MATTE_UNDO) matteUndo.shift();
  if (toolState.undoCount !== matteUndo.length) {
    toolState.undoCount = matteUndo.length;
    const b = document.querySelector('#inspector button[data-act="undoStroke"]');
    if (b) b.disabled = false;
  }
}

async function undoStroke() {
  const p = matteUndo.pop();
  toolState.undoCount = matteUndo.length;
  const m = p && (await p);
  if (m) {
    const r = await gpu.call({ cmd: 'matteSetPixels', pixels: m.pixels, width: m.width, height: m.height }, [m.pixels.buffer]).catch(() => null);
    if (r && r.ok) {
      toolState.matteVersion++;
      scheduleAnalysis();
      snapMatte();
    }
  }
  inspector.build(settings, limits());
}

// [ and ]: the brush size.
function brushSize(k) {
  const b = toolState.brush;
  b.size = Math.round(Math.min(400, Math.max(2, b.size * k + (k > 1 ? 1 : -1))));
  const row = inspector.rows['tools.brushSize'];
  if (row) row.setValue(b.size);
}

async function pick(u, v) {
  const r = await gpu.call({ cmd: 'pick', index: Math.max(0, player.vcur), u, v });
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
    // (Overlay and Scan object make the same mask: the cutout mode is not in the key.)
    return JSON.stringify(['edge', currentFile && currentFile.name, sl.edgeAngle, sl.flip, { ...settings.cutout, mode: undefined }, toolState.plateText, toolState.matteVersion, store.width, store.height]);
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
  analysisTimer = setTimeout(async () => {
    if (settings.mode !== 'slitscan' || slitKey() !== key) return;
    // Each video is decoded for the history once: when the frame store holds every frame (or the
    // history of this line is in the cache), the engine makes it without a decode.
    if (await historyWithoutDecode(key)) return;
    if (settings.mode !== 'slitscan' || slitKey() !== key || key === analysis.key) return;
    // The pass also fills the frame store when it can hold the full video: then this is the last one.
    const keep = !player.wrap && store.n >= player.frameCount;
    analysis.start(currentFile, player.frameCount, key, fileKeys(currentFile), keep);
  }, 300);
}

// The history of the slit (or edge) settings with key, from the frames in the store or the cache of
// the engine. Returns true when it is complete (no analysis pass). The edge history is made in parts.
async function historyWithoutDecode(key) {
  try {
    let r;
    do {
      r = await gpu.call({ cmd: 'slitRebuild' });
      if (slitKey() !== key || settings.mode !== 'slitscan') return true; // a newer key schedules itself
      if (!r.done) setProgress(r.edge ? r.edge.filled / Math.max(1, Math.min(player.frameCount, r.edge.rows)) : 0.5);
    } while (!r.done);
    setProgress(null);
    if (!r.complete) return false;
    if (analysis.running) analysis.stop();
    analysis.doneKey = key;
    if (!player.playing && !player.busy && player.vcur >= 0) quiet(gpu.call({ cmd: 'render', index: player.vcur }));
    status();
    refreshEdgeStats();
    return true;
  } catch {
    setProgress(null);
    return false; // (the GPU restarts: it schedules again)
  }
}

// The frames that the analysis pass put into the frame store (the mirror of the player).
function analysisStored(index) {
  if (player.n >= player.frameCount && !player.wrap) player.have[index % player.n] = index;
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
    const r = await gpu.call({ cmd: 'thumbs', maps, t: Math.max(0, player.vcur), width: THUMB_W, height: THUMB_H });
    inspector.drawThumbs(Object.fromEntries(ids.map((id, i) => [id, r.images[i]])));
  }, only ? 120 : 30);
}

// Open a custom map file (plan §7.4).
function openMap(kind) {
  const input = $('mapFileInput');
  // video/*: the iOS picker closes when a video is touched (a list of types gives a picker without
  // a Done button on iPad). The app checks the file itself (MP4 / MOV).
  input.accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/*';
  input.multiple = kind === 'video';
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
      // Kept for a preset file and a GPU restart (the file itself: a data URL of it would stay in
      // memory, a third larger; it is made when a preset is saved).
      mapInfo.imageBlob = file;
    } else {
      const caps = await gpu.call({ cmd: 'caps' });
      const r = await loadVideoMap(file, gpu, { workerSrc: DECODE_WORKER, short: Math.min(store.height || 540, 540), maxLayers: caps.maxLayers, onProgress: setProgress });
      settings.map.video.name = file.name;
      gpuState.mapVideoFile = file;
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
  const r = gpu.setSettings(clone(settings));
  quiet(r); // (awaited below; a failure before that is not an unhandled one)
  await syncWrap();
  const depth = effectDepth();
  const more = depth > player.depth;
  player.depth = depth;
  if (more && player.info && !player.playing && player.current >= 0) await player.seek(player.current);
  await r;
}

// Loop pixels. Time Map: the frames before the start of the loop come from its end. On a change
// (on / off, the loop range), the store indices change meaning: the engine forgets the store, and
// the frame on the preview is loaded again. Slit Scan: the slit history holds every frame by its real
// index, so the shader wraps the source frame into the loop ([a, a + L − 1]); nothing is loaded
// again. force: send the state again (after the export).
const wrapOn = () => settings.mode === 'timemap' && !!settings.loopPixels;
const slitLoopOn = () => settings.mode === 'slitscan' && !!settings.loopPixels;
let sentLoop = '';
async function syncWrap(force = false) {
  if (!player || !player.info) return;
  const changed = player.setWrap(wrapOn());
  let loop = null;
  if (slitLoopOn()) {
    const [a, b] = player.range();
    loop = [a, b - a + 1];
  }
  const loopKey = JSON.stringify(loop);
  if (!changed && !force && loopKey === sentLoop) return;
  sentLoop = loopKey;
  await gpu.call({ cmd: 'wrap', cap: player.wrap ? player.wrap.L - 1 : null, forget: changed, loop });
  if (changed && player.current >= 0) await player.seek(player.current);
}

// A setting changed in the UI. final: the end of a drag (the next change is a new undo step).
// The view (and the split divider) is not a look: no undo step.
function change(path, value, final) {
  if (path !== 'view' && path !== 'splitPos' && JSON.stringify(getPathSafe(path)) !== JSON.stringify(value)) {
    history.record(JSON.stringify(settings), path);
    if (final) history.cut();
  }
  setPath(settings, path, value);
  if (path === 'mode') modeChanged();
  if (path.startsWith('mosh.') && mosh) mosh.settingsChanged();
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
  quiet(applySettings());
}

function setProgress(f) {
  const p = $('progress');
  p.hidden = f === null || f === undefined;
  if (!p.hidden) p.style.width = `${Math.round(f * 100)}%`;
}

// The loading indicator (a file opens; it can take some seconds for a large file).
// onCancel: a Cancel button (the wait for the iOS picker).
function setLoading(text, onCancel = null) {
  const el = $('loading');
  el.hidden = !text;
  $('loadingText').textContent = text || '';
  document.body.classList.toggle('loading', !!text);
  const c = $('loadingCancel');
  c.hidden = !onCancel;
  c.onclick = onCancel;
}

// The video pickers. multiple: the iOS photo picker then has an Add button (with one file it has
// none on iPad: the user taps outside). After the pick, iOS copies (and can convert) the video
// before the page gets it, often for many seconds: on a touch device, the loading indicator shows
// from the moment the picker opens, until the file comes (change), the picker is closed without
// a file (cancel), or Cancel is touched.
let pickerWait = null;
function watchPicker(input) {
  input.addEventListener('click', () => {
    if (!(navigator.maxTouchPoints > 0)) return;
    if (input === $('mapFileInput') && input.dataset.kind !== 'video') return;
    const job = (pickerWait = {});
    setLoading('Waiting for the video… (iOS prepares a video from Photos before the page gets it: a long video takes a while.)', () => {
      if (pickerWait === job) pickerWait = null;
      setLoading(null);
    });
  });
  const end = () => {
    if (!pickerWait) return;
    pickerWait = null;
    setLoading(null);
  };
  input.addEventListener('cancel', end);
  // Before the handlers that open the file (they show their own text).
  input.addEventListener('change', end); // (several files: the first one is used)
}

async function openFile(file) {
  if (!file) return;
  // The name or the type says video; the reader checks the file (MP4 / MOV only).
  if (!/\.(mp4|mov|m4v)$/i.test(file.name) && !/^video\//.test(file.type)) {
    showMessage('Only MP4 and MOV files are supported.');
    return;
  }
  showMessage('');
  // Datamosh: a clip that is recorded ends first (the session stays: the next clip is from this file).
  if (mosh && mosh.busy) {
    mosh.stopPlay();
    await mosh.pause();
  }
  setLoading(`Opening ${file.name}…`);
  try {
    timeline.reset();
    if (analysis) analysis.stop();
    if (plateJob) plateJob.terminate();
    plateJob = null;
    Object.assign(toolState, { plateOk: false, plateText: '', undoCount: 0 });
    matteUndo.length = 0;
    settings.cutout.import = { on: false, name: '' };
    gpuState.maskFile = gpuState.plateFile = null;
    currentFile = file;
    let info;
    sound.close();
    muteButton();
    try {
      info = await player.open(file);
    } catch (e) {
      setState('start');
      $('view').hidden = true;
      showMessage(e.message);
      return;
    }
    setLoading(`Preparing ${file.name}…`);
    // The sound: its track is read in the background (the picture does not wait for it).
    sound.open(file).then(() => file === currentFile && muteButton());
    setState('open');
    $('view').hidden = false;
    modeChanged();
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
  stopReverse();
  analysis.stop();
  clearTimeout(analysisTimer);
  // An Auto clean plate that is being made: the export waits for it (the mask needs it).
  if (platePromise) await platePromise.catch(() => {});
  if (exporter) throw new Error('Nothing to export.');
  const view = settings.view;
  settings.view = 'result'; // the export is the result, whatever the preview shows
  let an = null, rejectAnalysis = null;
  exporter = new Exporter({
    gpu, decodeSrc: DECODE_WORKER, encodeSrc: ENCODE_WORKER, settings,
    file: () => currentFile,
    info: () => player.info,
    configure: async (w, h) => {
      await gpu.call({ cmd: 'settings', settings: clone(settings) });
      const r = await gpu.call({ cmd: 'configure', width: w, height: h, rotation: player.info.rotation, budget: store.usedBudget || store.budget || defaultBudget(navigator.userAgent, navigator.maxTouchPoints), frames: player.frameCount });
      await gpu.call({ cmd: 'settings', settings: clone(settings) });
      return r;
    },
    analyse: (onP) => new Promise((resolve, reject) => {
      rejectAnalysis = reject;
      an = new Analysis(DECODE_WORKER, gpu, { onProgress: (f) => f !== null && onP(f), onRows() {}, onDone: resolve, onError: (msg) => reject(new Error(msg || 'The analysis failed.')) });
      an.start(currentFile, player.frameCount, 'export', fileKeys(currentFile));
    }),
    depth: () => effectDepth(),
    wrap: wrapOn,
    slitLoop: slitLoopOn,
    keys: () => fileKeys(currentFile),
  });
  const ex = exporter;
  const cancel = ex.cancel.bind(ex);
  ex.cancel = () => {
    cancel();
    if (an) an.stop();
    if (rejectAnalysis) rejectAnalysis(new Error('Export cancelled'));
  };
  exportLost = false;
  try {
    return await ex.run(opts, onProgress);
  } catch (e) {
    if (exportLost) throw new Error('The browser reset the GPU during the export (most often: not enough memory). Try again, at a lower resolution.');
    throw e;
  } finally {
    settings.view = view;
    exporter = null;
    // The preview again (the engine store is new; the delay cap of the preview loop). After a GPU
    // reset, the restart does it.
    if (!exportLost) {
      await configureStore();
      await syncWrap(true);
      await player.seek(Math.max(0, player.current));
      status();
    }
  }
}

// The export dialog: a warning when the Max delay does not fit the buffer at that size (plan §6.4).
function exportCheck(w, h) {
  if (settings.mode !== 'timemap') return '';
  const n = layerCount(store.usedBudget || defaultBudget(navigator.userAgent, navigator.maxTouchPoints), gpuCaps.maxLayers, w, h);
  const depth = settings.timemap.maxDelay;
  return depth > n - 1 ? `The Max delay (${depth} frames) is more than the buffer at ${Math.min(w, h)}p (${n} frames). Choose a lower resolution, or a smaller Max delay.` : '';
}

// The keyboard is off while an export runs or a dialog is open (a seek or playback would put frames
// into the frame store of the export).
const keysOff = () => !!exporter || !!document.querySelector('dialog[open]') || !!(mosh && (mosh.busy || mosh.exporting));

function keys(e) {
  // Datamosh: R records / pauses, B (held) blooms; also while a clip is recorded.
  if (player.info && mosh && !exporter && !document.querySelector('dialog[open]') && !e.target.closest('input, select, textarea') && mosh.key(e, true)) return e.preventDefault();
  if (!player.info || keysOff() || e.target.closest('input, select, textarea')) return;
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
  else if (k === 'i' || k === 'I') {
    timeline.setIn();
    syncWrap();
  } else if (k === 'o' || k === 'O') {
    timeline.setOut();
    syncWrap();
  }
  else if (k === 'm' || k === 'M') change('view', settings.view === 'mask' ? 'result' : 'mask');
  else if ((k === 'e' || k === 'E') && (e.ctrlKey || e.metaKey)) openExport();
  else if ((k === 'z' || k === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && BRUSHES.includes(toolState.tool) && matteUndo.length) undoStroke(); // while painting: the last stroke
  else if ((k === 'z' || k === 'Z') && (e.ctrlKey || e.metaKey)) (e.shiftKey ? redo() : undo());
  else if ((k === 'y' || k === 'Y') && (e.ctrlKey || e.metaKey)) redo();
  else if (k === '[' && BRUSHES.includes(toolState.tool)) brushSize(0.8);
  else if (k === ']' && BRUSHES.includes(toolState.tool)) brushSize(1.25);
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
function openExport() {
  if (settings.mode === 'datamosh') mosh.openExport();
  else exportDialog.open();
}

function keysUp(e) {
  if (mosh && player.info && mosh.key(e, false)) return;
  if (e.key === ' ' && player.info && !keysOff() && !e.target.closest('input, select, textarea')) {
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
  quiet(applySettings());
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
  modeChanged();
  if (mosh) mosh.settingsChanged();
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
    const s = merge(DEFAULTS, migrateSettings(JSON.parse(t)));
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
const MODE_SECTIONS = { timemap: ['map', 'adjust', 'anim', 'time', 'composite', 'look'], slitscan: ['source', 'time2', 'composite', 'look'], datamosh: [] };
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

// Reset all the settings to the defaults (one undo step). The view, the Split divider and an
// imported mask video stay (they belong to the footage and the screen, not to the look).
function resetSettings() {
  history.record(JSON.stringify(settings), 'reset');
  history.cut();
  const s = clone(DEFAULTS);
  s.view = settings.view;
  s.splitPos = settings.splitPos;
  s.cutout.import = clone(settings.cutout.import);
  s.map.image = clone(settings.map.image);
  s.map.video = clone(settings.map.video);
  return replaceSettings(s);
}

function pickPreset(p) {
  history.record(JSON.stringify(settings), 'preset');
  history.cut();
  return replaceSettings(applyPreset(settings, p));
}

// Presets (plan §12.5): the Presets section of the inspector (its own tab on a phone): Randomize
// all, Reset to defaults, the looks, Save and Load. The thumbnails are made once (cache).
const presetThumbs = new Map(); // preset id -> ImageData
const presetCanvases = new Map(); // preset id -> the canvas of the card now
let presetQueue = null;
function presetPanel(sec) {
  const btn = (text, cls, fn) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  };
  const acts = document.createElement('div');
  acts.className = 'presetActions randomBar';
  const rand = btn('🎲 Randomize all', 'primary', () => randomize());
  rand.id = 'randomizeBtn';
  rand.title = 'A new look for the sections that are not locked';
  const reset = btn('Reset to defaults', '', () => resetSettings());
  reset.id = 'resetBtn';
  const seed = Object.assign(document.createElement('span'), { className: 'seed', textContent: lastSeed ? `Look #${lastSeed}` : '' });
  acts.append(rand, reset, seed);
  presetCanvases.clear();
  // One group for each mode, the group of the mode in use first.
  const groups = [...PRESET_GROUPS].sort((a, b) => (b[0] === settings.mode) - (a[0] === settings.mode));
  const grids = [];
  for (const [mode, title] of groups) {
    const list = PRESETS.filter((p) => p.s.mode === mode);
    if (!list.length) continue;
    const head = Object.assign(document.createElement('div'), { className: 'presetGroup', textContent: `${title} · ${list.length}` });
    head.dataset.group = mode;
    const grid = document.createElement('div');
    grid.className = 'presetGrid';
    grid.dataset.group = mode;
    for (const p of list) addCard(grid, p);
    grids.push(head, grid);
  }
  function addCard(grid, p) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'presetCard';
    card.dataset.preset = p.id;
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    card.append(c, Object.assign(document.createElement('span'), { textContent: p.name }));
    card.addEventListener('click', () => pickPreset(p));
    grid.append(card);
    presetCanvases.set(p.id, c);
    if (presetThumbs.has(p.id)) c.getContext('2d').putImageData(presetThumbs.get(p.id), 0, 0);
  }
  const files = document.createElement('div');
  files.className = 'presetFiles';
  const save = btn('Save preset…', '', savePreset);
  save.id = 'presetSave';
  const load = btn('Load preset…', '', () => {
    $('presetFileInput').value = '';
    $('presetFileInput').click();
  });
  load.id = 'presetLoad';
  files.append(save, load);
  sec.append(acts, ...grids, files);
  // The thumbnails are made when the section is open (the GPU work of 57 cards competed with the
  // playback when it ran at each build of the inspector).
  if (sec.open) makePresetThumbs();
  else sec.addEventListener('toggle', () => sec.open && makePresetThumbs());
}

// The missing thumbnails, one after the other (the GPU makes the map pictures).
function makePresetThumbs() {
  if (presetQueue) return presetQueue;
  presetQueue = (async () => {
    for (const p of PRESETS) {
      if (presetThumbs.has(p.id)) continue;
      // Not while the video plays (or a seek or an export runs): the preview comes first.
      while (player && (player.playing || player.busy || exporter || (mosh && mosh.busy))) await sleep(250);
      const img = await presetThumb(p);
      if (!img) continue;
      presetThumbs.set(p.id, img);
      const c = presetCanvases.get(p.id);
      if (c) c.getContext('2d').putImageData(img, 0, 0);
    }
  })().finally(() => (presetQueue = null));
  return presetQueue;
}

function openPresets() {
  inspector.showPresets();
}

// A preset thumbnail (ImageData 160 x 90, or null): the map of a Mode 1 preset (GPU), a line and an
// arrow for Mode 2.
async function presetThumb(p) {
  const s = applyPreset(settings, p);
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 90;
  const ctx = c.getContext('2d');
  // Maps of the frames or of the mask (Motion, Video luminance, Subject) have no picture without
  // them: an icon (a disc and its trail) for those.
  const iconMap = ['motion', 'self', 'subject', 'subjectdist'].includes(s.map.type);
  if (s.mode === 'timemap' && s.map.source === 'builtin' && !iconMap) {
    try {
      const r = await gpu.call({ cmd: 'thumbs', maps: [s.map], t: Math.max(0, player.vcur), width: 160, height: 90 });
      const y = r.images[0];
      const img = ctx.createImageData(160, 90);
      const px = new Uint32Array(img.data.buffer); // little-endian RGBA: grey, alpha 255
      for (let i = 0; i < y.length; i++) px[i] = 0xff000000 | (y[i] * 0x010101);
      return img;
    } catch {
      return null; // no thumbnail (yet): made again at the next build
    }
  }
  const g = ctx.createLinearGradient(0, 0, 160, 0);
  g.addColorStop(0, '#1a1b1e');
  g.addColorStop(1, '#5c5700');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 160, 90);
  if (s.mode === 'datamosh') return moshThumb(ctx, s.mosh);
  if (s.mode === 'timemap') {
    for (let i = 5; i >= 0; i--) {
      ctx.fillStyle = `rgba(255,255,255,${1 - i / 6})`;
      ctx.beginPath();
      ctx.arc(110 - i * 12, 45, 14, 0, 2 * Math.PI);
      ctx.fill();
    }
    return ctx.getImageData(0, 0, 160, 90);
  }
  return slitThumb(ctx, s);
}

// A Slit Scan preset: the trail as lines of equal age (new: bright, old: faint, in the tint colours),
// bent by the rate and the trail shape (twist, drift, spread, wave) as the shader bends it.
function slitThumb(ctx, s) {
  const W = 160, H = 90;
  ctx.fillStyle = '#121316';
  ctx.fillRect(0, 0, W, H);
  const sl = s.slitscan, wp = sl.warp || {};
  const edge = sl.source === 'edge' || s.cutout.mode === 'scan';
  // The source point and the scan direction d (the line is along e).
  const L = edge ? [W / 2, H / 2] : [sl.x * W, sl.y * H];
  const a = ((edge ? sl.edgeAngle : sl.angle - 90) * Math.PI) / 180;
  let d = [Math.cos(a), Math.sin(a)];
  if (sl.flip && !edge) d = [-d[0], -d[1]];
  const e = [-d[1], d[0]];
  const colors = s.look.tint && s.look.tintColors && s.look.tintColors.length >= 2 ? s.look.tintColors : ['#ffffff', '#eee100'];
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ramp = (u) => {
    const k = Math.min(colors.length - 1.001, u * (colors.length - 1));
    const i = Math.floor(k), f = k - i;
    const c0 = rgb(colors[i]), c1 = rgb(colors[i + 1]);
    return c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
  };
  const diag = Math.hypot(W, H);
  // The rate: the distance between the lines of equal age.
  const S = [0];
  const M = 24;
  for (let i = 1; i <= M; i++) {
    const u = i / M;
    const r0 = sl.rate, r1 = sl.rateEnd;
    const r = sl.rateType === 'accelerate' ? r0 + (r1 - r0) * u * u : sl.rateType === 'decelerate' ? r0 + (r1 - r0) * (1 - (1 - u) * (1 - u)) : sl.rateType === 'exponential' ? r0 * (r1 / r0) ** u : sl.rateType === 'curve' ? (r0 + r1) / 2 : r0;
    S.push(S[i - 1] + Math.max(0.1, r));
  }
  const scale = 75 / S[M];
  const at = (dist, v) => {
    // The inverse of the shader warp: the place of the sample v (along the line) at distance dist.
    const sp = Math.max(1 + (wp.spread || 0) * (dist / diag), 0.05);
    const u = v * sp + (wp.drift || 0) * dist + (wp.wave || 0) * 0.35 * Math.sin((2 * Math.PI * dist) / Math.max(8, (wp.waveLength || 120) * 0.35));
    let q = [d[0] * dist + e[0] * u, d[1] * dist + e[1] * u];
    const th = ((wp.twist || 0) * Math.PI / 180) * (Math.hypot(q[0], q[1]) / diag);
    q = [Math.cos(th) * q[0] - Math.sin(th) * q[1], Math.sin(th) * q[0] + Math.cos(th) * q[1]];
    return [L[0] + q[0], L[1] + q[1]];
  };
  // The lines of equal age (faint), then the path of each source sample along the trail (the
  // streaks: drift slants them, the wave bends them, twist turns them, spread fans them out).
  const span = edge ? 14 : 100;
  const steps = sl.time ? M : 10;
  const distOf = (i) => (sl.time ? S[i] * scale : i * 7.5);
  ctx.lineWidth = 1;
  for (let i = steps; i >= 1; i--) {
    const c = ramp(sl.time ? i / steps : 0);
    ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.18)`;
    ctx.beginPath();
    for (let v = -span; v <= span; v += 4) {
      const [x, y] = at(distOf(i), v);
      if (v === -span) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  for (let v = -span; v <= span; v += edge ? 5 : 9) {
    for (let i = 0; i < steps * 2; i++) {
      const u0 = i / (steps * 2), u1 = (i + 1) / (steps * 2);
      const d0 = sl.time ? distOf(Math.floor(u0 * steps)) + (distOf(Math.min(steps, Math.floor(u0 * steps) + 1)) - distOf(Math.floor(u0 * steps))) * ((u0 * steps) % 1) : u0 * 75;
      const d1 = sl.time ? distOf(Math.floor(u1 * steps)) + (distOf(Math.min(steps, Math.floor(u1 * steps) + 1)) - distOf(Math.floor(u1 * steps))) * ((u1 * steps) % 1) : u1 * 75;
      const c = ramp(sl.time ? u0 : 0);
      ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${sl.time ? 1 - 0.8 * u0 : 0.85})`;
      ctx.beginPath();
      ctx.moveTo(...at(d0, v));
      ctx.lineTo(...at(d1, v));
      ctx.stroke();
    }
  }
  if (edge) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(L[0], L[1], 12, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L[0] - e[0] * 120, L[1] - e[1] * 120);
    ctx.lineTo(L[0] + e[0] * 120, L[1] + e[1] * 120);
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, W, H);
}

// A Datamosh preset: blocks of an old picture pulled along by the motion. The block size comes from
// the motion precision, the smear length from the search range and the skip bias, the coarseness
// from the QP; the same look always gives the same picture.
function moshThumb(ctx, m) {
  const block = { full: 16, half: 10, quarter: 6 }[m.precision] || 8;
  const len = 6 + (m.searchRange / 64) * 40 + (m.skipBias / 100) * 30;
  const coarse = (m.qp - 16) / 28; // 0 .. 1
  let seed = (m.qp * 7919 + m.searchRange * 31 + m.skipBias * 17 + block) >>> 0;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const colors = ['#ff2d55', '#eee100', '#00e5ff', '#5b2bff', '#ffffff', '#3dff7a'];
  // The old picture: bands of colour.
  for (let x = 0; x < 160; x += 20) {
    ctx.fillStyle = colors[(x / 20) % colors.length];
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x, 0, 20, 90);
  }
  ctx.globalAlpha = 1;
  // The smears: blocks copied along a direction.
  for (let k = 0; k < 18; k++) {
    const x = Math.floor(r() * 10) * 16, y = Math.floor(r() * 6) * 16;
    const dx = (r() - 0.3) * 2, dy = (r() - 0.5) * 0.6;
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    for (let i = 0; i < len; i += block / 2) {
      ctx.globalAlpha = 0.25 + 0.5 * coarse;
      ctx.fillRect(Math.round(x + dx * i), Math.round(y + dy * i), block, block);
    }
  }
  ctx.globalAlpha = 1;
  if (m.heal !== 'off') {
    // Heal: some clean blocks.
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    for (let k = 0; k < (m.heal === 'high' ? 10 : 5); k++) ctx.fillRect(Math.floor(r() * 10) * 16, Math.floor(r() * 6) * 16, 16, 16);
  }
  return ctx.getImageData(0, 0, 160, 90);
}

async function savePreset() {
  const assets = {};
  if (settings.map.source === 'image' && mapInfo.imageBlob) {
    const url = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(mapInfo.imageBlob);
    });
    if (url) assets.mapImage = url;
  }
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
      const blob = dataUrlBlob(p.assets.mapImage);
      await loadImageMap(blob, gpu);
      mapInfo.imageBlob = blob;
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
    snapMatte();
  }
  if (video) {
    notes.unshift(`This preset uses the video map "${video}": open it.`);
    openMap('video');
  }
  showMessage(notes.join(' '));
}

// ---- The GPU engine, and its restart (the browser can reset the GPU: out of memory, a tab in the
// background on iOS). The engine runs in the GPU worker (OffscreenCanvas) where the browser has it,
// but on iOS on the main thread (WebKit's OffscreenCanvas WebGL in a worker is newer, and the page
// flashed there). ?gpu=main forces the main thread.
function makeGpu(canvas) {
  const forceMain = /[?&]gpu=main\b/.test(location.search) || isIOS(navigator.userAgent, navigator.maxTouchPoints);
  const g = new GpuClient(canvas, GPU_WORKER, platform.offscreen && !forceMain);
  g.onLost = () => restartGpu();
  return g;
}

// What the engine holds that is not in the settings: kept here, so a restart can put it back.
const gpuState = { matte: null, mapVideoFile: null, maskFile: null, plateFile: null };
const gpuLosses = [];
let restarting = null;
let exportLost = false;

// The garbage matte, read back (after the strokes end), so a GPU restart keeps it.
let matteTimer = 0;
function snapMatte() {
  clearTimeout(matteTimer);
  matteTimer = setTimeout(async () => {
    try {
      const m = await gpu.call({ cmd: 'matteGet' });
      gpuState.matte = m.empty ? null : m;
    } catch { /* the GPU restarts */ }
  }, 400);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = () => new Promise((r) => {
  if (!document.hidden) return r();
  const f = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', f);
    r();
  };
  document.addEventListener('visibilitychange', f);
});

// A new canvas, a new context, a new engine; then the store, the settings, the custom map, the
// mask video, the clean plate, the matte, and the frame on the preview, as they were. The store
// budget halves (most resets are out of memory).
function restartGpu() {
  if (restarting) return restarting;
  restarting = (async () => {
    const t = Math.max(0, player ? player.current : 0);
    if (player) player.pause();
    stopReverse();
    if (analysis) analysis.stop();
    if (exporter) {
      exportLost = true;
      exporter.cancel();
    }
    const now = Date.now();
    gpuLosses.push(now);
    while (gpuLosses.length && now - gpuLosses[0] > 120000) gpuLosses.shift();
    if (store.usedBudget) store.budget = Math.max(48 * 1048576, Math.floor(store.usedBudget / 2));
    setLoading('The browser reset the GPU. Restoring the preview…');
    try {
      await visible();
      await sleep(300);
      while (exporter) await sleep(100); // the export stops first
      gpu.dispose();
      const old = $('view');
      const c = old.cloneNode(false);
      old.replaceWith(c);
      preview.canvas = c;
      handles.canvas = c;
      tools.bind(c);
      gpu = makeGpu(c);
      gpuCaps = await gpu.ready;
      analysis.gpu = gpu;
      window.neofx.gpu = gpu;
      overlaySent = false;
      matteUndo.length = 0; // (the matte of the new engine can have another size)
      toolState.undoCount = 0;
      syncOverlay();
      if (player.info) {
        await configureStore();
        player.setWrap(false);
        await syncWrap(true);
        if (settings.map.source === 'image' && mapInfo.imageBlob) await loadImageMap(mapInfo.imageBlob, gpu).catch(() => {});
        if (settings.map.source === 'video' && gpuState.mapVideoFile) await loadMapFile(gpuState.mapVideoFile, 'video');
        if (settings.cutout.import.on && gpuState.maskFile) await loadMaskVideo(gpuState.maskFile);
        if (settings.cutout.plate === 'image' && gpuState.plateFile) await plateImage(gpuState.plateFile);
        else if (settings.cutout.plate === 'frame') toolState.plateOk = false;
        if (gpuState.matte) {
          const m = await gpu.call({ cmd: 'matteGet' });
          const src = gpuState.matte;
          const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(src.pixels.buffer.slice(0)), src.width, src.height), { resizeWidth: m.width, resizeHeight: m.height, colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
          await gpu.call({ cmd: 'matteSet', bitmap }, [bitmap]);
          toolState.matteVersion++;
        }
        await applySettings();
        ensurePlate();
        scheduleAnalysis();
        await player.seek(t);
        status();
      } else await gpu.call({ cmd: 'settings', settings: clone(settings) });
      showMessage(gpuLosses.length >= 3
        ? 'The browser has reset the GPU several times (most often: not enough memory). Choose a lower Preview resolution or a shorter Max delay.'
        : 'The browser reset the GPU; the preview was restored.');
    } catch (e) {
      showMessage(`The GPU cannot be restored (${e.message}). Reload the page.`);
    } finally {
      setLoading(null);
      restarting = null;
    }
  })();
  return restarting;
}

// A tab in the background: playback stops (no frames to a GPU that the system can take back).
// Back: the engine is checked (a lost context restarts it), and the frame is drawn again.
function onVisibility() {
  if (document.hidden) {
    if (player) player.pause();
    stopReverse();
    if (mosh && mosh.busy) {
      mosh.stopPlay();
      mosh.pause(); // (timers are slow in the background: the clip ends here)
    }
    return;
  }
  setTimeout(async () => {
    if (!gpu || restarting || document.hidden) return;
    let lost = false;
    try {
      lost = (await gpu.call({ cmd: 'alive' })).lost;
    } catch {
      lost = true;
    }
    if (lost) restartGpu();
    else if (player && player.info && player.vcur >= 0 && !player.busy) gpu.call({ cmd: 'render', index: player.vcur }).catch(() => {});
  }, 250);
}

// The performance test (phase 12, plan §13.4).
async function benchmark(opts) {
  return runBench({
    player, store, version: VERSION, gpuMode: gpu.mode, gpuName: platform.gl && platform.gl.renderer,
    info: () => player.info,
    settings: () => clone(settings),
    look: (patch) => replaceSettings(merge(settings, patch)),
    restore: (saved) => replaceSettings(saved),
    setShort: async (short) => {
      store.short = short;
      $('resSelect').value = String(short);
      await configureStore();
      await player.seek(0);
      status();
    },
    bufferAt: (w, h) => layerCount(store.usedBudget || defaultBudget(navigator.userAgent, navigator.maxTouchPoints), gpuCaps.maxLayers, w, h),
    exportVideo,
    onStep: (t) => ($('benchStep').textContent = t),
  }, opts);
}

function openBench() {
  const d = $('benchDialog');
  $('benchStep').textContent = player.info ? '' : 'Open a video first.';
  $('benchRun').disabled = !player.info;
  d.showModal();
}

async function start() {
  document.title = `neofx ${VERSION}`;
  const p = (platform = await checkPlatform());
  window.neofx = { version: VERSION, platform: p };
  if (!p.ok) {
    setState('unsupported');
    showMessage(p.fatal);
    return;
  }
  if (p.notes.length) showMessage(p.notes.join(' '));
  preview = new Preview($('view'), $('preview'));
  gpu = makeGpu($('view'));
  document.addEventListener('visibilitychange', onVisibility);
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
    onPlay: (us) => sound.prepare(us),
    onClock: (c) => sound.start(c.us, c.wall),
    onStop: () => sound.stop(),
  });
  timeline = new Timeline($('transport'), player);
  mosh = new Mosh({
    workerSrc: MOSH_WORKER, canvas: $('moshView'), bar: $('moshBar'), dialog: $('moshDialog'), settings, player,
    file: () => currentFile,
    info: () => player.info,
    message: showMessage,
    changed: () => {
      if (inspector && settings.mode === 'datamosh') inspector.build(settings, limits());
    },
    // While a clip is recorded: the playhead of the timeline follows the file time.
    playhead: (us) => {
      if (!player.info) return;
      player.current = frameAtUs(us);
      timeline.update();
    },
    // After a clip: the source at the next frame (the next clip continues there).
    seekSource: (us, ended) => {
      if (!player.info) return;
      quiet(player.seek(Math.min(player.frameCount - 1, frameAtUs(us) + (ended ? 0 : 1))));
    },
  });
  handles = new LineHandles($('preview'), $('view'), { change, settings, tools: toolState, edgeMode: () => edgeMode() });
  analysis = new Analysis(DECODE_WORKER, gpu, {
    onProgress: (f) => {
      setProgress(f);
      status();
    },
    // New rows: show them on a paused preview.
    onRows: () => {
      if (!player.playing && !player.busy && player.vcur >= 0) quiet(gpu.call({ cmd: 'render', index: player.vcur }));
    },
    onError: (msg) => {
      if (!restarting) showMessage(`The analysis stopped: ${msg}`);
    },
    onStored: analysisStored,
    onDone: () => {
      status();
      refreshEdgeStats();
    },
  });
  tools = new PreviewTools($('preview'), $('view'), {
    pick,
    strokeStart: matteCheckpoint,
    stroke: (points, mode) => {
      toolState.matteVersion++;
      scheduleAnalysis();
      snapMatte();
      return quiet(gpu.call({ cmd: 'matteStroke', points, size: toolState.brush.size, hardness: toolState.brush.hardness, mode }));
    },
    brush: toolState.brush,
    onTool: (t) => {
      toolState.tool = t;
      syncOverlay();
      for (const b of document.querySelectorAll('#inspector .toolRow button[data-act]')) b.classList.toggle('on', b.dataset.act === t || (b.dataset.act === 'overlay' && toolState.overlay));
      handles.update();
    },
  });
  inspector = new Inspector($('inspector'), {
    change, openMap, info: () => mapInfo, tools: toolState, setTool, plate: makePlate, importMask, removeMask,
    toggleOverlay,
    undoStroke,
    clearMatte: () => {
      matteCheckpoint();
      toolState.matteVersion++;
      clearTimeout(matteTimer);
      gpuState.matte = null;
      scheduleAnalysis();
      return gpu.call({ cmd: 'matteClear' });
    },
    edgeStats: () => edgeStats,
    mosh: () => mosh,
    moshDefault: () => {
      // One undo step: the encoder look back to the neomosh defaults.
      history.record(JSON.stringify(settings), 'moshDefault');
      history.cut();
      return replaceSettings({ ...settings, mosh: { ...settings.mosh, ...MOSH_LOOK } });
    },
    locks,
    toggleLock,
    randomize: (list) => randomize(list),
    presetPanel,
  });
  const saved = loadLocal();
  if (saved) {
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, saved);
  }
  inspector.build(settings, { maxDelay: 999, maxAge: 600, maxAgeEdge: 512 });
  quiet(gpu.setSettings(clone(settings)));
  for (const b of document.querySelectorAll('#viewBar button[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
  for (const b of document.querySelectorAll('#viewBar button[data-zoom]')) {
    b.addEventListener('click', () => {
      preview.setZoom(b.dataset.zoom === 'fit' ? 'fit' : 1);
      for (const x of document.querySelectorAll('#viewBar button[data-zoom]')) x.classList.toggle('on', x === b);
    });
  }
  layout = initLayout({
    menu: { presets: openPresets, undo, redo, bench: openBench },
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
    mosh.place(preview.canvas);
  };
  $('presetsBtn').addEventListener('click', openPresets);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('presetFileInput').addEventListener('change', (e) => loadPreset(e.target.files[0]));
  document.addEventListener('keyup', keysUp);
  demos = startDemos($('demoTime'), $('demoSlit'));
  if (document.body.dataset.state !== 'start') demos.stop();
  cleanExportStorage(); // a large export of an earlier visit that stayed in the browser storage
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
  $('exportBtn').addEventListener('click', openExport);
  try {
    sound.setMuted(localStorage.getItem(MUTE_KEY) === '1');
  } catch { /* no storage */ }
  $('muteBtn').addEventListener('click', () => setMuted(!sound.muted));
  // The audio context starts in a user gesture (iOS Safari plays no sound from one made later).
  const unlock = () => {
    if (sound.available && !sound.muted) sound.ensureContext();
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  muteButton();
  modeChanged();
  $('benchClose').addEventListener('click', () => $('benchDialog').close());
  $('benchCopy').addEventListener('click', () => {
    const t = $('benchOut');
    t.select();
    if (navigator.clipboard) navigator.clipboard.writeText(t.value).catch(() => document.execCommand('copy'));
    else document.execCommand('copy');
  });
  $('benchRun').addEventListener('click', async () => {
    $('benchRun').disabled = true;
    $('benchClose').disabled = true;
    try {
      const r = await benchmark();
      $('benchOut').value = r.text;
      $('benchOut').hidden = false;
      $('benchCopy').hidden = false;
      $('benchStep').textContent = 'Done. Copy the result into the README (device results).';
      window.neofx.lastBench = r;
    } catch (e) {
      $('benchStep').textContent = e.message;
    } finally {
      $('benchRun').disabled = false;
      $('benchClose').disabled = false;
    }
  });
  Object.assign(window.neofx, { sound, setMuted, mosh, toggleOverlay, undoStroke, cleanExportStorage, restartGpu, snapMatte, benchmark, undo, redo, history, randomize, resetSettings, pickPreset, locks, toggleLock, openPresets, savePreset, loadPreset, PRESETS, setView, playReverse, stopAll, exportVideo, exportDialog, cancelExport: () => exporter && exporter.cancel(), refreshEdgeStats, edgeMode, player, preview, timeline, gpu, store, settings, inspector, openFile, configureStore, change, applySettings, loadMapFile, updateThumbs, analysis, handles, slitKey, tools, toolState, makePlate, loadMaskVideo, removeMask });
  for (const id of ['fileInput', 'maskFileInput', 'mapFileInput']) watchPicker($(id));
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
