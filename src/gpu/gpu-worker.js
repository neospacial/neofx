// GPU worker (plan §5.1): the engine on the OffscreenCanvas of the preview.
// In: { id, msg } with msg.cmd 'init' (msg.canvas) or an engine message. Out: { id, reply } or { id, error }.

import { Engine } from './engine.js';

let engine = null;

self.onmessage = (e) => {
  const { id, msg } = e.data;
  try {
    let reply;
    if (msg.cmd === 'init') {
      engine = new Engine(msg.canvas);
      engine.onLost = () => self.postMessage({ event: 'lost' });
      reply = { cmd: 'caps', ...engine.caps };
    } else reply = engine.handle(msg);
    if (engine && engine.lost) self.postMessage({ id, error: 'The GPU context was lost.' });
    else self.postMessage({ id, reply }, reply && reply.pixels ? [reply.pixels.buffer] : reply && reply.frame ? [reply.frame] : []);
  } catch (err) {
    if (msg.frame) try { msg.frame.close(); } catch { /* closed */ }
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
