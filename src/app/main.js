// neofx app (plan Phase 2): open a file, the Original preview, seek, play, timeline. The later phases
// add the GPU work, the effects, and the inspector.

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

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';
const DECODE_WORKER = "@WORKER:io/demux.js,io/timeline.js,io/decode-worker.js";
const GPU_WORKER = "@WORKER:maps/builtin.js,maps/curve.js,gpu/store.js,gpu/gl.js,gpu/blend.js,gpu/mapgen.js,gpu/engine.js,gpu/gpu-worker.js";

let player, preview, timeline, gpu, inspector;
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
  if (slow) parts.push(`Preview ${Math.round(fps)} fps`);
  else parts.push(`${info.width}×${info.height}`);
  s.textContent = parts.join(' · ');
}

// Make the store for the working size (plan §6.4). The store is empty after this.
async function configureStore() {
  const info = player.info;
  const { width, height } = workingSize(info.width, info.height, store.short);
  const r = await gpu.call({ cmd: 'configure', width, height, rotation: info.rotation, budget: store.budget || defaultBudget(navigator.userAgent), failAlloc: store.failAlloc });
  Object.assign(store, { width, height, n: r.n, bytes: r.bytes, usedBudget: r.budget });
  player.setStore(r.n);
  preview.setSize(width, height);
  // The Max delay cannot be more than N - 1 (plan §6.4).
  if (settings.timemap.maxDelay > r.n - 1) settings.timemap.maxDelay = r.n - 1;
  inspector.build(settings, limits());
  await applySettings();
  updateThumbs();
  return r;
}

const limits = () => ({ maxDelay: Math.max(0, store.n - 1) });

// The history that the effect needs: Mode 1, the Max delay (and the frames of the Motion map).
function effectDepth() {
  if (settings.mode !== 'timemap' || settings.view === 'original') return 0;
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
  const rebuild = ['map.source', 'map.type', 'mode', 'composite.mode', 'composite.decay', 'look.tint'];
  if (rebuild.includes(path) || (path === 'look.offset' && (value > 0) !== !!document.querySelector('[data-key="look.offsetAngle"]'))) {
    inspector.build(settings, limits());
    updateThumbs();
  } else inspector.refresh(settings);
  if (path.startsWith('map.params.')) updateThumbs(path.split('.')[2]);
  else if (path.startsWith('map.adjust.') || path.startsWith('map.anim.')) updateThumbs();
  if (path === 'view') for (const b of document.querySelectorAll('#viewBar button')) b.classList.toggle('on', b.dataset.view === value);
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
  inspector = new Inspector($('inspector'), { change, openMap, info: () => mapInfo });
  inspector.build(settings, { maxDelay: 999 });
  gpu.call({ cmd: 'settings', settings: clone(settings) });
  for (const b of document.querySelectorAll('#viewBar button')) b.addEventListener('click', () => change('view', b.dataset.view));
  Object.assign(window.neofx, { player, preview, timeline, gpu, store, settings, inspector, openFile, configureStore, change, applySettings, loadMapFile, updateThumbs });
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
