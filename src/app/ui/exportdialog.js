// The export dialog (plan §11.1, §11.2): settings, progress, cancel, then Download (or Share).

import { exportSizes, exportName, QUALITY } from '../../io/encoder-config.js';

const el = (tag, attrs = {}, text) => {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ExportDialog {
  // app: { info(), file(), range() -> [a, b] | null, hasAudio(), check(width, height) -> warning text or '',
  //        run(opts, onProgress) -> result, cancel() }
  constructor(dialog, app) {
    this.d = dialog;
    this.app = app;
    this.result = null;
  }

  open() {
    const info = this.app.info();
    if (!info) return;
    const d = this.d;
    d.textContent = '';
    this.result = null;
    const form = el('form', { method: 'dialog', className: 'exportForm' });
    form.append(el('h2', {}, 'Export'));
    const row = (label, input) => {
      const r = el('label', { className: 'exportRow' });
      r.append(el('span', {}, label), input);
      form.append(r);
      return input;
    };
    const sel = (name, options, value) => {
      const s = el('select', { name });
      for (const [v, t] of options) s.append(el('option', { value: v }, t));
      s.value = value;
      return s;
    };
    const sizes = exportSizes(info.width, info.height);
    const res = row('Resolution', sel('resolution', sizes.map((s) => [s.id, s.label]), 'source'));
    const quality = row('Quality', sel('quality', [...Object.keys(QUALITY).map((k) => [k, { low: 'Low', medium: 'Medium', high: 'High', veryhigh: 'Very high' }[k]]), ['custom', 'Bitrate (Mbit/s)']], 'high'));
    const mbps = row('Bitrate', el('input', { type: 'number', name: 'mbps', min: 0.5, max: 200, step: 0.5, value: 8 }));
    mbps.parentElement.hidden = true;
    quality.addEventListener('change', () => (mbps.parentElement.hidden = quality.value !== 'custom'));
    const keyint = row('Keyframe interval (s)', el('input', { type: 'number', name: 'keyint', min: 1, max: 10, step: 1, value: 2 }));
    const range = this.app.range();
    const rangeSel = row('Range', sel('range', [['full', 'Full'], ...(range ? [['inout', `In – Out (frames ${range[0]} – ${range[1]})`]] : [])], 'full'));
    const audio = row('Audio', sel('audio', this.app.hasAudio() ? [['copy', 'Copy original'], ['none', 'None']] : [['none', 'None (the file has no audio)']], this.app.hasAudio() ? 'copy' : 'none'));
    const hw = row('Encoder', sel('hardware', [['hardware', 'Prefer hardware'], ['software', 'Prefer software']], 'hardware'));
    const name = row('File name', el('input', { type: 'text', name: 'name', value: exportName(this.app.file().name) }));
    const warn = el('p', { className: 'exportWarn' });
    form.append(warn);
    const size = () => sizes.find((s) => s.id === res.value);
    const check = () => {
      const s = size();
      warn.textContent = this.app.check(s.width, s.height);
      go.disabled = !!warn.textContent;
    };
    const prog = el('div', { className: 'exportProgress', hidden: true });
    const bar = el('div', { className: 'bar' });
    const text = el('p', { className: 'exportText' });
    prog.append(el('div', { className: 'track' }), text);
    prog.firstChild.append(bar);
    form.append(prog);
    const buttons = el('div', { className: 'exportButtons' });
    const go = el('button', { type: 'button', className: 'primary', id: 'exportGo' }, 'Export');
    const cancel = el('button', { type: 'button', id: 'exportCancel' }, 'Cancel');
    buttons.append(cancel, go);
    form.append(buttons);
    d.append(form);
    res.addEventListener('change', check);
    check();
    let running = false;
    cancel.addEventListener('click', () => {
      if (running) this.app.cancel();
      else d.close();
    });
    go.addEventListener('click', async () => {
      running = true;
      go.disabled = true;
      for (const i of form.querySelectorAll('select, input')) i.disabled = true;
      prog.hidden = false;
      const s = size();
      const opts = {
        width: s.width, height: s.height, quality: quality.value, mbps: Number(mbps.value), keyint: Number(keyint.value),
        range: rangeSel.value === 'inout' && range ? range : [0, info.times.length - 1],
        audio: audio.value === 'copy', hardware: hw.value, name: name.value || exportName(this.app.file().name),
      };
      try {
        const r = await this.app.run(opts, (p) => {
          if (p.phase === 'analysis') {
            bar.style.width = `${Math.round((p.analysis || 0) * 100)}%`;
            text.textContent = `Analysis ${Math.round((p.analysis || 0) * 100)} %`;
          } else if (p.phase === 'mux') text.textContent = 'Writing the file…';
          else {
            bar.style.width = `${Math.round((100 * p.done) / p.total)}%`;
            text.textContent = `${p.done} / ${p.total} frames · ${p.fps.toFixed(1)} fps · ${Math.ceil(p.eta)} s left`;
          }
        });
        this.result = r;
        bar.style.width = '100%';
        text.textContent = `Done: ${r.width}×${r.height}, ${r.frames} frames, ${(r.size / 1048576).toFixed(1)} MB${r.audio ? ', with audio' : ''}.`;
        this.showResult(buttons, r);
      } catch (e) {
        text.textContent = e.message;
        cancel.textContent = 'Close';
      } finally {
        running = false;
      }
    });
    d.showModal();
  }

  showResult(buttons, r) {
    buttons.textContent = '';
    const url = URL.createObjectURL(r.blob);
    const dl = el('a', { href: url, download: r.name, className: 'button primary', id: 'exportDownload' }, 'Download');
    buttons.append(dl);
    // Share (iOS-like environments, plan §11.2 step 7).
    if (navigator.canShare && navigator.canShare({ files: [r.blob] })) {
      const sh = el('button', { type: 'button', id: 'exportShare' }, 'Share');
      sh.addEventListener('click', () => navigator.share({ files: [r.blob], title: r.name }).catch(() => {}));
      buttons.prepend(sh);
    }
    const close = el('button', { type: 'button' }, 'Close');
    close.addEventListener('click', () => this.d.close());
    buttons.prepend(close);
  }
}
