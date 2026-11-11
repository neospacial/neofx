// neofx app (plan Phase 2): open a file, the Original preview, seek, play, timeline. The later phases
// add the GPU work, the effects, and the inspector.

import { checkPlatform } from './platform.js';
import { Player } from './player.js';
import { GpuClient } from './gpu-client.js';
import { Preview } from './preview.js';
import { workingSize, defaultBudget, bufferText } from '../gpu/store.js';
import { Timeline } from './ui/timeline.js';

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';
const DECODE_WORKER = "@WORKER:io/demux.js,io/timeline.js,io/decode-worker.js";
const GPU_WORKER = "@WORKER:gpu/store.js,gpu/gl.js,gpu/engine.js,gpu/gpu-worker.js";

let player, preview, timeline, gpu;
// The store state: { short (the preview setting), width, height, n, bytes, budget }.
const store = { short: 540, budget: 0, failAlloc: 0 };

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
  return r;
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
    render: (index) => gpu.call({ cmd: 'render', index, delay: 0 }),
    onState: () => {
      timeline.update();
      status();
    },
    onThumb: (i, index, bitmap) => timeline.addThumb(i, index, bitmap),
    onError: (msg) => showMessage(msg),
    onProgress: setProgress,
  });
  timeline = new Timeline($('transport'), player);
  Object.assign(window.neofx, { player, preview, timeline, gpu, store, openFile, configureStore });
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
