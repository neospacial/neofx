// Mode 2, Slit Scan, in the engine (plan §8.1 – §8.3): the slit history (one row of line pixels for
// each frame, row = frame mod H), the staging layer of the analysis pass, and the render.

import { program, texParams, drawQuad } from './gl.js';
import { lineGeometry, distanceTable, historyRows } from '../modes/slit.js';

const QUAD_VERT = "@GLSL:gpu/glsl/quad.vert";
const STORE_GLSL = "@GLSL:gpu/glsl/store.glsl";
const COMPOSITE_GLSL = "@GLSL:gpu/glsl/composite.glsl";
const AGE_GLSL = "@GLSL:gpu/glsl/age.glsl";
const ROW_FRAG = "@GLSL:gpu/glsl/slitrow.frag";
const SCAN_FRAG = "@GLSL:gpu/glsl/slitscan.frag";
const SUBJECT_GLSL = "@GLSL:gpu/glsl/subject.glsl";
const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
const VIEWS = { result: 0, original: 1, map: 2 };

export class Slit {
  constructor(engine) {
    this.e = engine;
    const gl = (this.gl = engine.gl);
    this.rowProg = program(gl, QUAD_VERT, `#version 300 es\n${ROW_FRAG}`);
    this.scan = program(gl, QUAD_VERT, `${HEAD}${STORE_GLSL}\n${COMPOSITE_GLSL}\n${SUBJECT_GLSL}\n${AGE_GLSL}\n${SCAN_FRAG}`);
    this.hist = this.rowsTex = this.Stex = this.stY = this.stC = null;
    this.H = 0;
    this.rowFrame = null;
    this.key = '';
    this.sKey = '';
    this.geo = null;
    this.M = 1;
  }

  // For a working size and a frame count. The history is empty after this.
  configure(w, h, frames) {
    const gl = this.gl;
    for (const t of [this.hist, this.rowsTex, this.Stex, this.stY, this.stC]) if (t) gl.deleteTexture(t);
    const maxTex = this.e.caps.maxTexture;
    this.H = historyRows(frames, maxTex);
    this.len = lineGeometry({ x: 0.5, y: 0.5, angle: 90 }, w, h, maxTex).len;
    this.hist = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.hist);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.len, this.H);
    texParams(gl, gl.TEXTURE_2D);
    this.rowFrame = new Int32Array(this.H).fill(-1);
    this.rowsTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.rowsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, this.H, 1, 0, gl.RED_INTEGER, gl.INT, this.rowFrame);
    texParams(gl, gl.TEXTURE_2D, gl.NEAREST);
    this.Stex = gl.createTexture();
    // The staging layer (YUV, 1 layer) for the frames of the analysis pass.
    this.stY = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.stY);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, 1);
    texParams(gl, gl.TEXTURE_2D_ARRAY);
    this.stC = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.stC);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, w / 2, h / 2, 1);
    texParams(gl, gl.TEXTURE_2D_ARRAY);
    this.key = '';
    this.sKey = '';
    return { rows: this.H };
  }

  active() {
    return !!(this.e.settings && this.e.settings.mode === 'slitscan' && this.hist);
  }

  // A change of the line (or the slit width): the history is not valid; rebuild it from the frames
  // in the store at once (the analysis pass of the page does the rest).
  update() {
    if (!this.active()) return;
    const sl = this.e.settings.slitscan;
    const e = this.e;
    const key = JSON.stringify([sl.x, sl.y, sl.angle, sl.flip, sl.width, e.w, e.h]);
    if (key !== this.key) {
      this.key = key;
      this.geo = lineGeometry(sl, e.w, e.h, e.caps.maxTexture);
      this.rowFrame.fill(-1);
      const order = [];
      for (let l = 0; l < e.n; l++) if (e.layerFrame[l] >= 0) order.push([e.layerFrame[l], l]);
      order.sort((a, b) => a[0] - b[0]);
      for (const [t, l] of order) this.writeRow(t, e.storeY, e.storeC, l, false);
      this.uploadRows();
    }
    const sk = JSON.stringify([sl.rateType, sl.rate, sl.rateEnd, sl.curve, sl.maxAge, this.H]);
    if (sk !== this.sKey) {
      this.sKey = sk;
      const S = distanceTable({ ...sl, maxAge: Math.min(sl.maxAge, this.H) });
      this.M = S.length - 1;
      const rows = Math.ceil(S.length / 1024);
      const data = new Float32Array(rows * 1024);
      data.set(S);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.Stex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1024, rows, 0, gl.RED, gl.FLOAT, data);
      texParams(gl, gl.TEXTURE_2D, gl.NEAREST);
    }
  }

  uploadRows() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.rowsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.H, 1, gl.RED_INTEGER, gl.INT, this.rowFrame);
  }

  // Write the history row of frame index from a YUV array layer.
  writeRow(index, Y, C, layer, upload = true) {
    const gl = this.gl;
    const e = this.e;
    const g = this.geo;
    const row = index % this.H;
    const p = this.rowProg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, e.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hist, 0);
    gl.viewport(0, row, this.len, 1);
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, Y);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, C);
    gl.uniform1i(p.u.u_Y, 1);
    gl.uniform1i(p.u.u_C, 2);
    gl.uniform1f(p.u.u_layer, layer);
    gl.uniform2f(p.u.u_res, e.w, e.h);
    gl.uniform2f(p.u.u_L, g.L[0], g.L[1]);
    gl.uniform2f(p.u.u_d, g.d[0], g.d[1]);
    gl.uniform2f(p.u.u_e, g.e[0], g.e[1]);
    gl.uniform1f(p.u.u_c, g.c);
    gl.uniform1i(p.u.u_width, Math.max(1, Math.min(16, Math.round(e.settings.slitscan.width))));
    drawQuad(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.rowFrame[row] = index;
    if (upload) {
      gl.bindTexture(gl.TEXTURE_2D, this.rowsTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, row, 0, 1, 1, gl.RED_INTEGER, gl.INT, new Int32Array([index]));
    }
  }

  // A frame of the analysis pass: into the staging layer, then its history row (not the store).
  analysisFrame(index, frame) {
    this.update();
    const e = this.e;
    e.putYuv(frame, this.stY, this.stC, 0);
    if (this.active()) this.writeRow(index, this.stY, this.stC, 0);
  }

  // The count of history rows that hold a frame (for tests and the status).
  filled() {
    let n = 0;
    for (const f of this.rowFrame || []) if (f >= 0) n++;
    return n;
  }

  render(index) {
    const gl = this.gl;
    const e = this.e;
    const s = e.settings;
    const sl = s.slitscan;
    this.update();
    const g = this.geo;
    const p = this.scan;
    gl.useProgram(p.prog);
    e.bindStore(p);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, e.layersTex);
    gl.uniform1i(p.u.u_layers, 4);
    gl.uniform1i(p.u.u_n, e.n);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.hist);
    gl.uniform1i(p.u.u_hist, 3);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.rowsTex);
    gl.uniform1i(p.u.u_rows, 5);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.Stex);
    gl.uniform1i(p.u.u_S, 7);
    gl.uniform2f(p.u.u_res, e.w, e.h);
    gl.uniform1i(p.u.u_t, index);
    gl.uniform2f(p.u.u_L, g.L[0], g.L[1]);
    gl.uniform2f(p.u.u_d, g.d[0], g.d[1]);
    gl.uniform2f(p.u.u_e, g.e[0], g.e[1]);
    gl.uniform1f(p.u.u_c, g.c);
    gl.uniform1f(p.u.u_len, this.len);
    gl.uniform1i(p.u.u_H, this.H);
    gl.uniform1i(p.u.u_M, this.M);
    gl.uniform1i(p.u.u_timeOn, sl.time ? 1 : 0);
    gl.uniform1i(p.u.u_sharp, sl.sampling === 'blend' ? 0 : 1);
    gl.uniform1i(p.u.u_view, VIEWS[s.view] ?? 0);
    e.compositeUniforms(p, s, this.M);
    e.mask.subjectUniforms(p, s.cutout.mode === 'overlay');
    drawQuad(gl);
  }
}
