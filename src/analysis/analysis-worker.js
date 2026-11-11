// Analysis worker (plan §5.1): CPU work. { cmd: 'median', Y: [...], C: [...] } -> { cmd: 'median', Y, C }.

import { medianBytes } from './cleanplate.js';

self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'median') {
    const Y = medianBytes(m.Y), C = medianBytes(m.C);
    self.postMessage({ cmd: 'median', Y, C }, [Y.buffer, C.buffer]);
  }
};
