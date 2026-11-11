// The GPU engine (plan §5.1, §6.3, §6.4). It owns the WebGL2 context of the preview canvas and the
// frame store. It runs in the GPU worker (OffscreenCanvas), or on the main thread as the fallback.
//
// handle(msg) -> a reply object (or null). Messages:
//   { cmd: 'configure', width, height, rotation, budget, failAlloc } -> { cmd: 'configured', n, budget, bytes }
//   { cmd: 'upload', index, frame, show }  put the frame into the store; show: render it  -> { cmd: 'uploaded', index }
//   { cmd: 'render', index, delay }        render frame index - delay from the store      -> { cmd: 'rendered', index }
//   { cmd: 'read' }                        render again and read the canvas (tests)         -> { cmd: 'pixels', width, height, pixels }
//   { cmd: 'caps' }                                                                         -> { cmd: 'caps', ... }

import { createContext, program, texParams, drawQuad } from './gl.js';
import { layerCount, frameBytes } from './store.js';

const QUAD_VERT = "@GLSL:gpu/glsl/quad.vert";
const UPLOAD_FRAG = "@GLSL:gpu/glsl/upload.frag";
const STORE_GLSL = "@GLSL:gpu/glsl/store.glsl";
const SHOW_FRAG = "@GLSL:gpu/glsl/show.frag";

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = createContext(canvas));
    this.caps = {
      maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
    };
    this.upload = program(gl, QUAD_VERT, UPLOAD_FRAG);
    this.show = program(gl, QUAD_VERT, `#version 300 es\nprecision highp float;\n${STORE_GLSL}\n${SHOW_FRAG}`);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.src = gl.createTexture();
    this.fb = gl.createFramebuffer();
    this.storeY = this.storeC = null;
    this.n = 0;
    this.layerFrame = null; // the frame index in each layer, -1 = empty
    this.last = { index: -1, delay: 0 };
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  handle(m) {
    if (m.cmd === 'caps') return { cmd: 'caps', ...this.caps };
    if (m.cmd === 'configure') return this.configure(m);
    if (m.cmd === 'upload') {
      this.put(m.index, m.frame);
      if (m.show) this.render(m.index, 0);
      return { cmd: 'uploaded', index: m.index };
    }
    if (m.cmd === 'render') {
      this.render(m.index, m.delay || 0);
      return { cmd: 'rendered', index: m.index };
    }
    if (m.cmd === 'read') return this.read();
    return null;
  }

  // Make the store for the working size. The budget halves until the allocation works (plan §6.4).
  configure(m) {
    const gl = this.gl;
    const { width: w, height: h } = m;
    this.w = w;
    this.h = h;
    this.rot = m.rotation || 0;
    this.canvas.width = w;
    this.canvas.height = h;
    let budget = m.budget;
    let fails = m.failAlloc || 0; // tests: act as if the first allocations ran out of memory
    for (;;) {
      this.free();
      const n = layerCount(budget, this.caps.maxLayers, w, h);
      while (gl.getError() !== gl.NO_ERROR) { /* clear old errors */ }
      this.storeY = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.storeY);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, n);
      texParams(gl, gl.TEXTURE_2D_ARRAY);
      this.storeC = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.storeC);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, w / 2, h / 2, n);
      texParams(gl, gl.TEXTURE_2D_ARRAY);
      // Touch the last layer, so that the driver must commit the memory now.
      this.n = n;
      this.clearLayer(n - 1);
      const err = gl.getError();
      const failed = fails > 0 || err === gl.OUT_OF_MEMORY || gl.isContextLost();
      if (!failed) break;
      fails--;
      if (n === 1 || gl.isContextLost()) {
        if (gl.isContextLost()) throw new Error('The GPU context was lost.');
        break;
      }
      budget = Math.floor(budget / 2);
    }
    this.layerFrame = new Int32Array(this.n).fill(-1);
    this.last = { index: -1, delay: 0 };
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { cmd: 'configured', n: this.n, budget, bytes: this.n * frameBytes(w, h) };
  }

  free() {
    const gl = this.gl;
    if (this.storeY) gl.deleteTexture(this.storeY);
    if (this.storeC) gl.deleteTexture(this.storeC);
    this.storeY = this.storeC = null;
  }

  target(tex, layer, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, layer);
    gl.viewport(0, 0, w, h);
  }

  clearLayer(layer) {
    const gl = this.gl;
    this.target(this.storeY, layer, this.w, this.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.target(this.storeC, layer, this.w / 2, this.h / 2);
    gl.clearColor(0.5, 0.5, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Upload a VideoFrame into layer index mod N (plan §6.3), then close it.
  put(index, frame) {
    const gl = this.gl;
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      // A large source: mipmaps, so the scale down does not alias.
      const turned = this.rot % 180 !== 0;
      const sw = turned ? frame.displayHeight : frame.displayWidth;
      const mip = sw > 2 * this.w;
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      texParams(gl, gl.TEXTURE_2D, gl.LINEAR, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    } finally {
      frame.close();
    }
    const layer = index % this.n;
    gl.useProgram(this.upload.prog);
    gl.uniform1i(this.upload.u.u_src, 0);
    gl.uniform1i(this.upload.u.u_rot, this.rot);
    gl.uniform1i(this.upload.u.u_mode, 0);
    this.target(this.storeY, layer, this.w, this.h);
    drawQuad(gl);
    gl.uniform1i(this.upload.u.u_mode, 1);
    this.target(this.storeC, layer, this.w / 2, this.h / 2);
    drawQuad(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.layerFrame[layer] = index;
  }

  // The layer of frame t, or -1 when it is not in the store (or t < 0).
  layerOf(t) {
    if (t < 0 || !this.n) return -1;
    const l = t % this.n;
    return this.layerFrame[l] === t ? l : -1;
  }

  render(index, delay) {
    const gl = this.gl;
    this.last = { index, delay };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.show.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.storeY);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.storeC);
    gl.uniform1i(this.show.u.u_storeY, 1);
    gl.uniform1i(this.show.u.u_storeC, 2);
    gl.uniform1f(this.show.u.u_layer, this.layerOf(index - delay));
    drawQuad(gl);
  }

  read() {
    const gl = this.gl;
    this.render(this.last.index, this.last.delay);
    const pixels = new Uint8Array(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { cmd: 'pixels', width: this.w, height: this.h, pixels };
  }
}
