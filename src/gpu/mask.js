// The cutout in the engine (plan §9): the mask pipeline for each frame, the clean plate, the garbage
// matte, the imported mask, the subject layer masks (own grow / feather, outline), and the jump flood
// distance (Subject distance map).

import { program, texParams, drawQuad } from './gl.js';
import { cleanRegions } from '../analysis/regions.js';
import { hexRgb, BLEND_INDEX } from './blend.js';

const QUAD_VERT = "@GLSL:gpu/glsl/quad.vert";
const STORE_GLSL = "@GLSL:gpu/glsl/store.glsl";
const METHODS_FRAG = "@GLSL:gpu/glsl/maskmethods.frag";
const MORPH_FRAG = "@GLSL:gpu/glsl/morph.frag";
const POST_FRAG = "@GLSL:gpu/glsl/maskpost.frag";
const BLUR_FRAG = "@GLSL:gpu/glsl/mapblur.frag";
const BRUSH_FRAG = "@GLSL:gpu/glsl/brush.frag";
const JFA_FRAG = "@GLSL:gpu/glsl/jfa.frag";
const SHOW_FRAG = "@GLSL:gpu/glsl/maskshow.frag";
const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
const FIX_SIZE = 256; // the long side of the small copy for Fill holes / Keep largest
const MATTE_SIZE = 1024; // the long side of the garbage matte

const ycc = (rgb) => {
  const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [y, (rgb[2] - y) / 1.8556 + 0.5, (rgb[0] - y) / 1.5748 + 0.5];
};

export class Mask {
  constructor(engine) {
    this.e = engine;
    const gl = (this.gl = engine.gl);
    this.methods = program(gl, QUAD_VERT, `${HEAD}${STORE_GLSL}\n${METHODS_FRAG}`);
    this.morph = program(gl, QUAD_VERT, `#version 300 es\n${MORPH_FRAG}`);
    this.post = program(gl, QUAD_VERT, `#version 300 es\n${POST_FRAG}`);
    this.blur = program(gl, QUAD_VERT, `#version 300 es\n${BLUR_FRAG}`);
    this.brush = program(gl, QUAD_VERT, `#version 300 es\n${BRUSH_FRAG}`);
    this.jfa = program(gl, QUAD_VERT, `#version 300 es\n${JFA_FRAG}`);
    this.show = program(gl, QUAD_VERT, `#version 300 es\n${SHOW_FRAG}`);
    this.tex = null;
    this.key = '';
    this.version = 0; // clean plate, matte, import changes
    this.prev = { t: -2, key: '' };
    this.plateY = this.plateC = null; // the clean plate, YUV 4:2:0 as the store (1 layer)
    this.hasPlate = false;
    this.imp = null; // { tex, w, h, count }
    this.emptyArray = (() => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, 1, 1, 1);
      return t;
    })();
    this.fixTex = this.tex2(1, 1, gl.RG8);
  }

  tex2(w, h, fmt, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    texParams(gl, gl.TEXTURE_2D, filter ?? gl.LINEAR);
    return t;
  }

  // The work textures at the working size; the matte keeps its own size (the aspect of the picture).
  configure(w, h) {
    const gl = this.gl;
    if (this.tex) for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    const R8 = gl.R8;
    this.tex = { a: this.tex2(w, h, R8), b: this.tex2(w, h, R8), c: this.tex2(w, h, R8), out: this.tex2(w, h, R8), sub: this.tex2(w, h, R8), outline: this.tex2(w, h, R8), prev: this.tex2(w, h, R8) };
    if (this.e.caps.floatTargets) {
      this.tex.j1 = this.tex2(w, h, gl.RG32F, gl.NEAREST);
      this.tex.j2 = this.tex2(w, h, gl.RG32F, gl.NEAREST);
    }
    for (const t of [this.plateY, this.plateC]) if (t) gl.deleteTexture(t);
    this.plateY = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.plateY);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, 1);
    texParams(gl, gl.TEXTURE_2D_ARRAY);
    this.plateC = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.plateC);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, w / 2, h / 2, 1);
    texParams(gl, gl.TEXTURE_2D_ARRAY);
    this.hasPlate = false;
    const s = MATTE_SIZE / Math.max(w, h);
    const mw = Math.round(w * s), mh = Math.round(h * s);
    if (!this.matte || this.matteSize[0] !== mw || this.matteSize[1] !== mh) {
      if (this.matte) for (const t of this.matte) gl.deleteTexture(t);
      this.matte = [this.tex2(mw, mh, gl.RGBA8), this.tex2(mw, mh, gl.RGBA8)];
      this.matteSize = [mw, mh];
      this.clearMatte();
    }
    this.key = '';
    this.prev = { t: -2, key: '' };
    this.distT = -1;
  }

  into(tex, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.e.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
  }

  clearMatte() {
    const gl = this.gl;
    for (const t of this.matte) {
      this.into(t, ...this.matteSize);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.version++;
  }

  // A brush stroke (plan §9.1 step 3). points: [[u, v], ...] in 0..1 of the picture; size: the brush
  // diameter in working pixels; mode: 'always' | 'never' | 'erase'.
  stroke(points, size, hardness, mode) {
    const gl = this.gl;
    const [mw, mh] = this.matteSize;
    const scale = mw / this.e.w;
    const p = this.brush;
    for (let i = 0; i < points.length; i += 63) {
      const part = points.slice(i, i + 64);
      const flat = new Float32Array(128);
      part.forEach(([u, v], k) => flat.set([u * mw, v * mh], k * 2));
      this.into(this.matte[1], mw, mh);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.matte[0]);
      gl.uniform1i(p.u.u_in, 0);
      gl.uniform2fv(p.u['u_pts[0]'], flat);
      gl.uniform1i(p.u.u_np, part.length);
      gl.uniform1f(p.u.u_radius, Math.max(0.5, (size * scale) / 2));
      gl.uniform1f(p.u.u_hardness, Math.min(0.99, Math.max(0, hardness)));
      gl.uniform1i(p.u.u_mode, { always: 0, never: 1, erase: 2 }[mode] ?? 2);
      drawQuad(gl);
      this.matte.reverse();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.version++;
  }

  // The clean plate (plan §9.2). It goes through the same YUV 4:2:0 conversion as the frames of the
  // store, so that the background difference compares like with like. upload(): put the picture
  // (already turned) into the bound TEXTURE_2D.
  setPlate(upload) {
    const gl = this.gl;
    const e = this.e;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, e.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    upload();
    gl.generateMipmap(gl.TEXTURE_2D);
    texParams(gl, gl.TEXTURE_2D, gl.LINEAR, gl.LINEAR_MIPMAP_LINEAR);
    gl.useProgram(e.upload.prog);
    gl.uniform1i(e.upload.u.u_src, 0);
    gl.uniform1i(e.upload.u.u_rot, 0);
    gl.uniform1i(e.upload.u.u_mode, 0);
    e.target(this.plateY, 0, e.w, e.h);
    drawQuad(gl);
    gl.uniform1i(e.upload.u.u_mode, 1);
    e.target(this.plateC, 0, e.w / 2, e.h / 2);
    drawQuad(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.hasPlate = true;
    this.version++;
    return true;
  }

  // A frame converted as the store does it (into a staging layer), read back: { Y, C } bytes.
  grabYuv(frame) {
    const gl = this.gl;
    const e = this.e;
    const st = e.slit;
    e.putYuv(frame, st.stY, st.stC, 0);
    const read = (tex, w, h, ch) => {
      e.target(tex, 0, w, h);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const out = new Uint8Array(w * h * ch);
      for (let i = 0; i < w * h; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = px[i * 4 + c];
      return out;
    };
    const Y = read(st.stY, e.w, e.h, 1), C = read(st.stC, e.w / 2, e.h / 2, 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { cmd: 'yuv', Y, C };
  }

  // The clean plate from Y and CbCr bytes (the median of grabYuv frames).
  setPlateYuv(Y, C) {
    const gl = this.gl;
    const e = this.e;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.plateY);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, e.w, e.h, 1, gl.RED, gl.UNSIGNED_BYTE, Y);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.plateC);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, e.w / 2, e.h / 2, 1, gl.RG, gl.UNSIGNED_BYTE, C);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.hasPlate = true;
    this.version++;
    return true;
  }

  setPlateImage(bitmap) {
    const gl = this.gl;
    try {
      return this.setPlate(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap));
    } finally {
      bitmap.close();
    }
  }

  // The stored frame t: render it (RGB) into a texture, copy that into the source texture.
  setPlateFrame(t) {
    const gl = this.gl;
    const e = this.e;
    if (e.layerOf(t) < 0) return false;
    const tmp = this.tex2(e.w, e.h, gl.RGBA8);
    this.into(tmp, e.w, e.h);
    gl.useProgram(e.show.prog);
    e.bindStore(e.show);
    gl.uniform1f(e.show.u.u_layer, e.layerOf(t));
    gl.uniform1i(e.show.u.u_noFlip, 1);
    drawQuad(gl);
    gl.uniform1i(e.show.u.u_noFlip, 0); // the uniform stays with the program
    const ok = this.setPlate(() => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, e.fb);
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 0, 0, e.w, e.h, 0);
    });
    gl.deleteTexture(tmp);
    return ok;
  }

  // The imported mask (plan §9.3): an R8 array, one layer for each frame of the mask video.
  beginImport(w, h, count) {
    const gl = this.gl;
    this.clearImport();
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, count);
    texParams(gl, gl.TEXTURE_2D_ARRAY);
    this.imp = { tex: t, w, h, layers: count, count: 0 };
    this.version++;
  }

  importFrame(i, frame, rotation) {
    this.e.lumaInto(this.imp.tex, i, this.imp.w, this.imp.h, frame, rotation);
    this.imp.count = Math.max(this.imp.count, i + 1);
    this.version++;
  }

  clearImport() {
    if (this.imp) this.gl.deleteTexture(this.imp.tex);
    this.imp = null;
    this.version++;
  }

  // One pass: prog with the input texture on unit 0, into out.
  pass(prog, input, out, set) {
    const gl = this.gl;
    const e = this.e;
    this.into(out, e.w, e.h);
    gl.useProgram(prog.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(prog.u.u_in, 0);
    if (set) set(prog.u);
    drawQuad(gl);
  }

  // Erode (r < 0) or dilate (r > 0) src by |r| px (two passes); the result is in dst.
  morphOp(src, tmp, dst, r) {
    const gl = this.gl;
    if (!r) return src;
    const set = (dir) => (u) => {
      gl.uniform2f(u.u_dir, ...dir);
      gl.uniform1i(u.u_r, Math.min(64, Math.abs(Math.round(r))));
      gl.uniform1i(u.u_max, r > 0 ? 1 : 0);
    };
    this.pass(this.morph, src, tmp, set([1, 0]));
    this.pass(this.morph, tmp, dst, set([0, 1]));
    return dst;
  }

  blurOp(src, tmp, dst, radius) {
    const gl = this.gl;
    if (!(radius > 0)) return src;
    const set = (dir) => (u) => {
      gl.uniform2f(u.u_dir, ...dir);
      gl.uniform1f(u.u_radius, Math.min(64, radius));
    };
    this.pass(this.blur, src, tmp, set([1, 0]));
    this.pass(this.blur, tmp, dst, set([0, 1]));
    return dst;
  }

  // Copy src into dst (a pass of the post shader without work).
  copy(src, dst) {
    const gl = this.gl;
    this.pass(this.post, src, dst, (u) => {
      gl.uniform1i(u.u_doFix, 0);
      gl.uniform1i(u.u_doTemporal, 0);
    });
  }

  // The mask of frame t (plan §9.1). Returns false when it is the same as before. src (optional):
  // { Y, C, layer } arrays to read the frame from (the analysis staging), in place of the store.
  update(t, src) {
    const s = this.e.settings;
    const C = s.cutout, Sb = s.subject;
    const base = JSON.stringify([C, Sb, this.version, this.e.w, this.e.h]);
    const key = `${base}@${t}${src ? 'A' : ''}`;
    if (key === this.key) return false;
    const gl = this.gl;
    const e = this.e;
    const T = this.tex;
    // 1–3. Methods, or the imported mask; the garbage matte.
    const m = this.methods;
    this.into(T.a, e.w, e.h);
    gl.useProgram(m.prog);
    e.bindStore(m);
    if (src) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, src.Y);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, src.C);
    }
    gl.uniform1i(m.u.u_override, src ? src.layer : -1);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, e.layersTex);
    gl.uniform1i(m.u.u_layers, 4);
    gl.uniform1i(m.u.u_n, e.n);
    gl.uniform1i(m.u.u_t, t);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.plateY);
    gl.uniform1i(m.u.u_plateY, 3);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.plateC);
    gl.uniform1i(m.u.u_plateC, 7);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.matte[0]);
    gl.uniform1i(m.u.u_matte, 5);
    gl.activeTexture(gl.TEXTURE6);
    const imp = C.import.on && this.imp && this.imp.count;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, imp ? this.imp.tex : this.emptyArray);
    gl.uniform1i(m.u.u_impTex, 6);
    gl.uniform1i(m.u.u_imp, imp ? 1 : 0);
    gl.uniform1f(m.u.u_impLayer, imp ? Math.min(t, this.imp.count - 1) : 0);
    gl.uniform1i(m.u.u_bgOn, C.bgdiff.on && this.hasPlate ? 1 : 0);
    gl.uniform1f(m.u.u_lightTol, C.bgdiff.lightTol);
    gl.uniform1f(m.u.u_thr, C.bgdiff.threshold);
    gl.uniform1f(m.u.u_soft, C.bgdiff.softness);
    gl.uniform1f(m.u.u_shadow, C.bgdiff.shadow);
    gl.uniform1i(m.u.u_ckOn, C.chroma.on ? 1 : 0);
    const k = ycc(hexRgb(C.chroma.key));
    gl.uniform2f(m.u.u_keyC, k[1], k[2]);
    gl.uniform1f(m.u.u_ckTol, C.chroma.tolerance);
    gl.uniform1f(m.u.u_ckSoft, C.chroma.softness);
    gl.uniform1i(m.u.u_lkOn, C.luma.on ? 1 : 0);
    gl.uniform1f(m.u.u_low, C.luma.low);
    gl.uniform1f(m.u.u_high, C.luma.high);
    gl.uniform1f(m.u.u_lkSoft, C.luma.softness);
    gl.uniform1i(m.u.u_lkInvert, C.luma.invert ? 1 : 0);
    gl.uniform1i(m.u.u_union, C.combine === 'intersect' ? 0 : 1);
    drawQuad(gl);
    // 4. Open (erode, dilate), Close (dilate, erode).
    let cur = T.a;
    const other = (x) => (x === T.a ? T.b : T.a);
    if (C.open > 0) {
      cur = this.morphOp(cur, T.c, other(cur), -C.open);
      cur = this.morphOp(cur, T.c, other(cur), C.open);
    }
    if (C.close > 0) {
      cur = this.morphOp(cur, T.c, other(cur), C.close);
      cur = this.morphOp(cur, T.c, other(cur), -C.close);
    }
    // 4. Fill holes, Keep largest region: on a small copy (CPU).
    if (C.fillHoles > 0 || C.keepLargest) {
      this.fix(cur, C.fillHoles, C.keepLargest);
      const dst = other(cur);
      this.pass(this.post, cur, dst, (u) => {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.fixTex);
        gl.uniform1i(u.u_fix, 1);
        gl.uniform1i(u.u_doFix, 1);
        gl.uniform1i(u.u_doTemporal, 0);
      });
      cur = dst;
    }
    // 5. Grow / shrink.
    if (C.grow) cur = this.morphOp(cur, T.c, other(cur), C.grow);
    // 6. Temporal smooth and hysteresis (with the mask of frame t − 1, when it was the last one).
    if (C.smooth > 0 || C.hysteresis) {
      const usePrev = this.prev.t === t - 1 && this.prev.key === base;
      const dst = other(cur);
      this.pass(this.post, cur, dst, (u) => {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, T.prev);
        gl.uniform1i(u.u_prev, 1);
        gl.uniform1i(u.u_doFix, 0);
        gl.uniform1i(u.u_doTemporal, 1);
        gl.uniform1i(u.u_usePrev, usePrev ? 1 : 0);
        gl.uniform1f(u.u_smooth, Math.min(0.95, C.smooth));
        gl.uniform1i(u.u_hyst, C.hysteresis ? 1 : 0);
        gl.uniform1f(u.u_tLow, C.tLow);
        gl.uniform1f(u.u_tHigh, C.tHigh);
      });
      cur = dst;
      this.copy(cur, T.prev);
      this.prev = { t, key: base };
    }
    // 7. Feather.
    cur = this.blurOp(cur, T.c, other(cur), C.feather);
    this.copy(cur, T.out);
    // The subject layer: its own grow and feather (§10.4), and the outline.
    let sub = T.out;
    if (Sb.grow || Sb.feather > 0) {
      sub = this.morphOp(T.out, T.c, T.a, Sb.grow);
      sub = this.blurOp(sub, T.c, sub === T.a ? T.b : T.a, Sb.feather);
    }
    this.copy(sub, T.sub);
    if (Sb.outline > 0) this.morphOp(T.sub, T.c, T.outline, Sb.outline);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.key = key;
    this.distT = -1;
    return true;
  }

  // Fill holes / Keep largest region on a copy of at most FIX_SIZE px (the long side).
  fix(src, fillPercent, keepLargest) {
    const gl = this.gl;
    const e = this.e;
    const s = Math.min(1, FIX_SIZE / Math.max(e.w, e.h));
    const w = Math.max(1, Math.round(e.w * s)), h = Math.max(1, Math.round(e.h * s));
    const small = this.tex2(w, h, gl.RGBA8);
    this.into(small, w, h);
    gl.useProgram(this.post.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.post.u.u_in, 0);
    gl.uniform1i(this.post.u.u_doFix, 0);
    gl.uniform1i(this.post.u.u_doTemporal, 0);
    drawQuad(gl);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.deleteTexture(small);
    const b = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) b[i] = px[i * 4] > 127 ? 1 : 0;
    const r = cleanRegions(b, w, h, fillPercent, keepLargest);
    const rg = new Uint8Array(w * h * 2);
    for (let i = 0; i < w * h; i++) {
      rg[i * 2] = r.fill[i] * 255;
      rg[i * 2 + 1] = r.remove[i] * 255;
    }
    gl.deleteTexture(this.fixTex);
    this.fixTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fixTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, rg);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    texParams(gl, gl.TEXTURE_2D);
  }

  // Jump flooding: the nearest subject pixel of each pixel (for the Subject distance map).
  distance() {
    const gl = this.gl;
    const T = this.tex;
    if (!T.j1 || this.distT === this.key) return T.j1 ? this.distTex : null;
    let a = T.j1, b = T.j2;
    this.pass(this.jfa, T.out, a, (u) => gl.uniform1i(u.u_init, 1));
    for (let k = 2 ** Math.ceil(Math.log2(Math.max(this.e.w, this.e.h))); k >= 1; k >>= 1) {
      this.pass(this.jfa, a, b, (u) => {
        gl.uniform1i(u.u_init, 0);
        gl.uniform1i(u.u_k, k);
      });
      [a, b] = [b, a];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.distTex = a;
    this.distT = this.key;
    return a;
  }

  // The uniforms of subject.glsl for an effect program.
  subjectUniforms(p, on) {
    const gl = this.gl;
    const s = this.e.settings;
    const Sb = s.subject;
    gl.uniform1i(p.u.u_subOn, on ? 1 : 0);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.sub);
    gl.uniform1i(p.u.u_subMask, 8);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.outline);
    gl.uniform1i(p.u.u_outline, 9);
    gl.uniform1i(p.u.u_outlineOn, Sb.outline > 0 ? 1 : 0);
    gl.uniform3fv(p.u.u_outlineColor, hexRgb(Sb.outlineColor));
    gl.uniform1f(p.u.u_subOpacity, Sb.opacity);
    gl.uniform1i(p.u.u_subBlend, BLEND_INDEX[Sb.blend] ?? 0);
    gl.uniform1f(p.u.u_spill, s.cutout.chroma.on ? s.cutout.chroma.spill : 0);
    gl.uniform3fv(p.u.u_keyRgb, hexRgb(s.cutout.chroma.key));
  }

  // The Mask view.
  render() {
    const gl = this.gl;
    gl.useProgram(this.show.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.out);
    gl.uniform1i(this.show.u.u_in, 0);
    drawQuad(gl);
  }
}
