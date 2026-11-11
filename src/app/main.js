// neofx app shell (plan Phase 1). The later phases add the decode, GPU, and UI parts.

import { checkPlatform } from './platform.js';

const $ = (id) => document.getElementById(id);
const VERSION = '@VERSION@';

function showMessage(text) {
  const m = $('message');
  m.textContent = text;
  m.hidden = !text;
}

function openFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4v)$/i.test(file.name) && !/^video\/(mp4|quicktime)$/.test(file.type)) {
    showMessage('Only MP4 and MOV files are supported.');
    return;
  }
  showMessage(`${file.name}: video loading comes in a later version.`);
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
  if (p.gl) $('status').textContent = `WebGL2 · max layers ${p.gl.maxLayers} · v${VERSION}`;
  if (p.notes.length) showMessage(p.notes.join(' '));
  $('openBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
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
