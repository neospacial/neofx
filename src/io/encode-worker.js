// Encode worker (plan §5.1, §11.2): the VideoEncoder of the export. Pattern from neomosh (the
// encodeQueueSize back-pressure is on the page side, with the 'queue' replies).
//   { cmd: 'configure', config }        -> 'configured' or 'error'
//   { cmd: 'frame', frame, key }        encode (the frame is closed here) -> 'queue' { size }
//   { cmd: 'flush' }                    -> 'flushed'
// Out: 'chunk' { data, timestamp (µs), key, description (with the first chunk) }.

let enc = null;
let failure = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'configure') {
      enc = new VideoEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const description = meta && meta.decoderConfig && meta.decoderConfig.description ? new Uint8Array(meta.decoderConfig.description.slice ? meta.decoderConfig.description.slice(0) : meta.decoderConfig.description) : null;
          self.postMessage({ cmd: 'chunk', data, timestamp: chunk.timestamp, key: chunk.type === 'key', description }, [data.buffer]);
        },
        error: (err) => {
          failure = String(err && err.message ? err.message : err);
          self.postMessage({ cmd: 'error', message: failure });
        },
      });
      enc.configure(m.config);
      self.postMessage({ cmd: 'configured' });
    } else if (m.cmd === 'frame') {
      if (failure) {
        m.frame.close();
        return;
      }
      enc.encode(m.frame, { keyFrame: !!m.key });
      m.frame.close();
      self.postMessage({ cmd: 'queue', size: enc.encodeQueueSize });
      enc.ondequeue = () => self.postMessage({ cmd: 'queue', size: enc.encodeQueueSize });
    } else if (m.cmd === 'flush') {
      await enc.flush();
      self.postMessage({ cmd: 'flushed' });
    }
  } catch (err) {
    if (m.frame) try { m.frame.close(); } catch { /* closed */ }
    self.postMessage({ cmd: 'error', message: String(err && err.message ? err.message : err) });
  }
};
