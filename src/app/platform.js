// Platform checks at startup (plan §4). Each check gives { ok, fatal, message }.

export async function checkPlatform() {
  const out = { ok: true, fatal: null, notes: [], gl: null };
  let gl = null;
  try {
    gl = document.createElement('canvas').getContext('webgl2');
  } catch {
    gl = null;
  }
  if (!gl) {
    out.ok = false;
    out.fatal = 'This browser has no WebGL2.';
    return out;
  }
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
  if (!floatTargets) out.notes.push('No float render targets: some modes lose precision.');
  out.gl = {
    floatTargets,
    maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  if (typeof VideoDecoder === 'undefined') {
    out.ok = false;
    out.fatal = 'This browser cannot decode video (no WebCodecs VideoDecoder).';
    return out;
  }
  out.encoder = typeof VideoEncoder !== 'undefined';
  if (!out.encoder) out.notes.push('No H.264 encoder: export is disabled.');
  out.offscreen = typeof OffscreenCanvas !== 'undefined' && (() => {
    try {
      return !!new OffscreenCanvas(1, 1).getContext('webgl2');
    } catch {
      return false;
    }
  })();
  return out;
}
