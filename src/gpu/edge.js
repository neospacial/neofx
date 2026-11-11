// Mode 2, Subject edge source (plan §8.4): the emitter history and the trail render.
// The rotated space is a square of D x D px about the frame centre; rows go along the scan direction.
// Emitter history: R32F positions and RGBA8 colours, D x (H K) (slot = frame mod H, K = 4 emitters
// for each row), and the frame of each slot. The trail: instanced quads into a D x D texture with a
// depth buffer (depth = age: the youngest pixel wins). The draw time is measured (gl.finish) and
// limits the Max age (target 20 ms at the preview resolution).

import { program, texParams } from './gl.js';
import { distanceTable } from '../modes/slit.js';

const EMIT_FRAG = "@GLSL:gpu/glsl/emit.frag";
const TRAIL_VERT = "@GLSL:gpu/glsl/trail.vert";
const TRAIL_FRAG = "@GLSL:gpu/glsl/trail.frag";
const QUAD_VERT = "@GLSL:gpu/glsl/quad.vert";
export const EDGE_K = 4;
export const EDGE_HISTORY = 512;
export const EDGE_TARGET_MS = 20;

export class Edge {
  constructor(engine) {
    this.e = engine;
    const gl = (this.gl = engine.gl);
    this.ok = engine.caps.floatTargets; // the positions need float render targets
    if (this.ok) {
      this.emit = program(gl, QUAD_VERT, `#version 300 es\n${EMIT_FRAG}`);
      this.trail = program(gl, TRAIL_VERT, `#version 300 es\n${TRAIL_FRAG}`);
    }
    this.fb = gl.createFramebuffer();
    this.tex = null;
    this.key = '';
    this.sKey = '';
    this.M = 1;
    this.stats = { ms: 0, msPerAge: 0, limit: EDGE_HISTORY, renders: 0 };
    this.forceMsPerAge = 0; // tests: act as if each age cost this time
  }

  configure(w, h, frames) {
    const gl = this.gl;
    if (this.tex) for (const t of Object.values(this.tex)) (t instanceof WebGLRenderbuffer ? gl.deleteRenderbuffer(t) : gl.deleteTexture(t));
    this.tex = null;
    if (!this.ok) return;
    this.D = Math.min(this.e.caps.maxTexture, Math.ceil(Math.hypot(w, h)) + 2);
    this.H = Math.max(1, Math.min(EDGE_HISTORY, frames));
    const mk = (fmt, w2, h2, filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w2, h2);
      texParams(gl, gl.TEXTURE_2D, filter ?? gl.NEAREST);
      return t;
    };
    const rows = Math.min(this.e.caps.maxTexture, this.H * EDGE_K);
    this.H = Math.floor(rows / EDGE_K);
    this.tex = {
      pos: mk(gl.R32F, this.D, this.H * EDGE_K),
      col: mk(gl.RGBA8, this.D, this.H * EDGE_K),
      trail: mk(gl.RGBA8, this.D, this.D),
      S: gl.createTexture(),
      frames: gl.createTexture(),
      depth: gl.createRenderbuffer(),
    };
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.tex.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.D, this.D);
    this.slotFrame = new Int32Array(this.H).fill(-1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.frames);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, this.H, 1, 0, gl.RED_INTEGER, gl.INT, this.slotFrame);
    texParams(gl, gl.TEXTURE_2D, gl.NEAREST);
    this.key = '';
    this.sKey = '';
  }

  // The scan direction d and the row direction e (the edge direction; Flip turns it 180°).
  dirs() {
    const sl = this.e.settings.slitscan;
    const a = (sl.edgeAngle * Math.PI) / 180;
    let d = [Math.cos(a), Math.sin(a)];
    if (sl.flip) d = [-d[0], -d[1]];
    return { d, e: [-d[1], d[0]] };
  }

  // A change of the direction or of the mask settings: the history is not valid. Rebuild the
  // emitters of the frames in the store near the last frame (the analysis pass does the rest).
  update() {
    if (!this.tex) return;
    const e = this.e;
    const s = e.settings;
    const sl = s.slitscan;
    const key = JSON.stringify([sl.edgeAngle, sl.flip, s.cutout, e.mask.version, e.w, e.h]);
    if (key !== this.key) {
      this.key = key;
      this.slotFrame.fill(-1);
      this.uploadFrames();
      const t = e.last.index;
      if (t >= 0) {
        const from = Math.max(0, t - Math.min(this.H, sl.maxAgeEdge) - 1);
        for (let f = from; f <= t; f++) {
          const l = e.layerOf(f);
          if (l >= 0) this.addFrame(f, { Y: e.storeY, C: e.storeC, layer: l }, true);
        }
      }
    }
    const M = this.maxAge();
    const sk = JSON.stringify([sl.rateType, sl.rate, sl.rateEnd, sl.curve, M]);
    if (sk !== this.sKey) {
      this.sKey = sk;
      const S = distanceTable({ ...sl, maxAge: M });
      this.M = S.length - 1;
      const rows = Math.ceil((S.length + 1) / 1024);
      const data = new Float32Array(rows * 1024);
      data.set(S);
      data[S.length] = S[S.length - 1] + Math.max(1e-4, sl.rate); // S(M + 1) for the last join
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex.S);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1024, rows, 0, gl.RED, gl.FLOAT, data);
      texParams(gl, gl.TEXTURE_2D, gl.NEAREST);
    }
  }

  // The Max age in use: the setting, the history length, and the GPU time limit.
  maxAge() {
    const sl = this.e.settings.slitscan;
    return Math.max(1, Math.min(sl.maxAgeEdge, this.H, this.stats.limit));
  }

  uploadFrames() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.frames);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.H, 1, gl.RED_INTEGER, gl.INT, this.slotFrame);
  }

  // The emitters of frame f: its mask (from src: { Y, C, layer }), then the emit pass.
  addFrame(f, src, batch = false) {
    if (!this.tex) return;
    const gl = this.gl;
    const e = this.e;
    const store = src.Y === e.storeY;
    e.mask.update(f, store ? undefined : src);
    const { d, e: ev } = this.dirs();
    const slot = f % this.H;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex.pos, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.tex.col, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, slot * EDGE_K, this.D, EDGE_K);
    const p = this.emit;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, e.mask.tex.out);
    gl.uniform1i(p.u.u_mask, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, src.Y);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, src.C);
    gl.uniform1i(p.u.u_Y, 1);
    gl.uniform1i(p.u.u_C, 2);
    gl.uniform1f(p.u.u_layer, src.layer);
    gl.uniform2f(p.u.u_res, e.w, e.h);
    gl.uniform2f(p.u.u_d, ...d);
    gl.uniform2f(p.u.u_e, ...ev);
    gl.uniform1f(p.u.u_D, this.D);
    gl.uniform1i(p.u.u_K, EDGE_K);
    gl.uniform1i(p.u.u_slot, slot);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.slotFrame[slot] = f;
    if (!batch) this.uploadFrames();
    else if (f % 16 === 0) this.uploadFrames();
  }

  // The count of history slots that hold a frame.
  filled() {
    let n = 0;
    for (const f of this.slotFrame || []) if (f >= 0) n++;
    return n;
  }

  // Draw the trail of frame t into the trail texture; measure the time.
  drawTrail(t) {
    const gl = this.gl;
    const sl = this.e.settings.slitscan;
    this.uploadFrames();
    const M = this.M;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex.trail, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.tex.depth);
    gl.viewport(0, 0, this.D, this.D);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (sl.time) {
      const p = this.trail;
      gl.useProgram(p.prog);
      const bind = (unit, tex, name) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(p.u[name], unit);
      };
      bind(0, this.tex.pos, 'u_pos');
      bind(1, this.tex.col, 'u_col');
      bind(2, this.tex.frames, 'u_frames');
      bind(3, this.tex.S, 'u_S');
      gl.uniform1i(p.u.u_t, t);
      gl.uniform1i(p.u.u_H, this.H);
      gl.uniform1i(p.u.u_K, EDGE_K);
      gl.uniform1i(p.u.u_M, M);
      gl.uniform1f(p.u.u_D, this.D);
      gl.uniform1f(p.u.u_join, sl.joinLimit);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      const t0 = performance.now();
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.D * EDGE_K * M);
      gl.finish();
      const ms = performance.now() - t0;
      gl.disable(gl.DEPTH_TEST);
      // The time for each age; the Max age that keeps the draw under the target.
      const per = this.forceMsPerAge || ms / M;
      const st = this.stats;
      st.msPerAge = st.renders ? 0.7 * st.msPerAge + 0.3 * per : per;
      st.ms = this.forceMsPerAge ? per * M : ms;
      st.renders++;
      st.limit = Math.max(8, Math.min(this.H, Math.floor(EDGE_TARGET_MS / Math.max(st.msPerAge, 1e-4))));
    }
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // The uniforms of the edge part of slitscan.frag.
  uniforms(p) {
    const gl = this.gl;
    const { d, e } = this.dirs();
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(p.u[name], unit);
    };
    bind(10, this.tex.trail, 'u_trail');
    bind(11, this.tex.pos, 'u_epos');
    bind(12, this.tex.col, 'u_ecol');
    bind(13, this.tex.frames, 'u_eframes');
    gl.uniform1i(p.u.u_eH, this.H);
    gl.uniform1i(p.u.u_eK, EDGE_K);
    gl.uniform1f(p.u.u_eD, this.D);
    gl.uniform2f(p.u.u_ed, ...d);
    gl.uniform2f(p.u.u_ee, ...e);
  }
}
