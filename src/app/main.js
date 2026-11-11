// neofx app (plan Phase 2): open a file, the Original preview, seek, play, timeline. The later phases
// add the GPU work, the effects, and the inspector.

import { checkPlatform } from './platform.js';
import { Player } from './player.js';
import { Preview } from './preview.js';
import { Timeline } from './ui/timeline.js';

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';
const DECODE_WORKER = "@WORKER:io/demux.js,io/timeline.js,io/decode-worker.js";

let player, preview, timeline;

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
  s.textContent = slow
    ? `Preview ${Math.round(fps)} fps`
    : `${info.width}×${info.height} · ${info.fps.toFixed(info.fps % 1 ? 2 : 0)} fps · ${info.times.length} frames · preview ${preview.canvas.width}×${preview.canvas.height}`;
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
  preview.setSource(info);
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
  player = new Player(DECODE_WORKER, {
    present: (index, frame) => preview.draw(frame),
    onState: () => {
      timeline.update();
      status();
    },
    onThumb: (i, index, bitmap) => timeline.addThumb(i, index, bitmap),
    onError: (msg) => showMessage(msg),
  });
  timeline = new Timeline($('transport'), player);
  window.neofx.player = player;
  window.neofx.timeline = timeline;
  window.neofx.preview = preview;
  window.neofx.openFile = openFile;
  $('resSelect').addEventListener('change', (e) => {
    preview.setShortSide(Number(e.target.value));
    if (player.info && !player.playing) player.seek(player.current);
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
