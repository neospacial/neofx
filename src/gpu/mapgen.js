// The map pipeline of the engine (plan §7.3 – §7.6): generate -> blur (2 passes) -> adjust, into a
// map texture. The custom map (image or video frames) is an R8 texture array.

import { program, texParams, drawQuad } from './gl.js';
import { MAP_INDEX, paramArray, videoMapFrame } from '../maps/builtin.js';
import { curveTable, CURVE_PRESETS } from '../maps/curve.js';

const QUAD_VERT = "@GLSL:gpu/glsl/quad.vert";
const STORE_GLSL = "@GLSL:gpu/glsl/store.glsl";
const GEN_FRAG = "@GLSL:gpu/glsl/mapgen.frag";
const BLUR_FRAG = "@GLSL:gpu/glsl/mapblur.frag";
const ADJUST_FRAG = "@GLSL:gpu/glsl/mapadjust.frag";
const FITS = { fill: 0, fit: 1, stretch: 2 };

export class MapGen {
  constructor(engine) {
    this.e = engine;
    const gl = (this.gl = engine.gl);
    this.float = engine.caps.floatTargets;
    this.gen = program(gl, QUAD_VERT, `#version 300 es\nprecision highp float;\nprecision highp int;\n${STORE_GLSL}\n${GEN_FRAG}`);
    this.blur = program(gl, QUAD_VERT, `#version 300 es\n${BLUR_FRAG}`);
    this.adjust = program(gl, QUAD_VERT, `#version 300 es\n${ADJUST_FRAG}`);
    this.curveTex = gl.createTexture();
    this.curveKey = '';
    this.custom = null; // { tex, w, h, layers, count, rotation }
    this.emptyCustom = this.makeArray(1, 1, 1);
    this.targets = null;
  }

  // A map texture (R32F, or RGBA8 without float targets).
  makeTarget(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.float ? gl.R32F : gl.RGBA8, w, h);
    texParams(gl, gl.TEXTURE_2D, gl.NEAREST);
    return t;
  }

  makeArray(w, h, layers) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, layers);
    texParams(gl, gl.TEXTURE_2D_ARRAY);
    return t;
  }

  // The work textures for a size: { w, h, raw, a, b }.
  work(w, h) {
    const gl = this.gl;
    if (this.targets && this.targets.w === w && this.targets.h === h) return this.targets;
    if (this.targets) for (const k of ['raw', 'a', 'b']) gl.deleteTexture(this.targets[k]);
    this.targets = { w, h, raw: this.makeTarget(w, h), a: this.makeTarget(w, h), b: this.makeTarget(w, h) };
    return this.targets;
  }

  into(tex, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.e.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
  }

  // Custom map: allocate for count frames of w x h (an image: count 1).
  beginCustom(w, h, count, rotation = 0) {
    this.clearCustom();
    this.custom = { tex: this.makeArray(w, h, count), w, h, layers: count, count: 0, rotation };
    return this.custom;
  }

  clearCustom() {
    if (this.custom) this.gl.deleteTexture(this.custom.tex);
    this.custom = null;
  }

  // Put a picture (ImageBitmap or VideoFrame) into layer i of the custom map, as luma.
  putCustom(i, source, rotation) {
    const c = this.custom;
    this.e.lumaInto(c.tex, i, c.w, c.h, source, rotation);
    c.count = Math.max(c.count, i + 1);
  }

  empty2D() {
    if (!this.empty) this.empty = this.makeTarget(1, 1);
    return this.empty;
  }

  curve(points) {
    const gl = this.gl;
    const key = JSON.stringify(points);
    if (key === this.curveKey) return;
    this.curveKey = key;
    const table = curveTable(points);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, table);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, Uint8Array.from(table, (v) => Math.round(v * 255)));
    texParams(gl, gl.TEXTURE_2D, gl.NEAREST);
  }

  // Render the map of frame t (map: the map settings) into out (w x h).
  run(map, t, out, w, h) {
    const gl = this.gl;
    const e = this.e;
    const W = this.work(w, h);
    const A = map.adjust, an = map.anim;
    const custom = (map.source === 'image' || map.source === 'video') && this.custom && this.custom.count;

    // The subject maps: the mask and the jump flood distance (plan §7.3, §9). Made first: the
    // distance pass uses its own programs (set before the uniforms of the map program).
    const mk = e.mask;
    const subj = map.source === 'builtin' && (map.type === 'subject' || map.type === 'subjectdist') && mk.tex;
    const dist = subj && map.type === 'subjectdist' ? mk.distance() : null;
    // 1. Generate.
    const g = this.gen;
    this.into(W.raw, w, h);
    gl.useProgram(g.prog);
    e.bindStore(g);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, e.layersTex);
    gl.uniform1i(g.u.u_layers, 4);
    gl.uniform1i(g.u.u_n, e.n);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, custom ? this.custom.tex : this.emptyCustom);
    gl.uniform1i(g.u.u_custom, 5);
    gl.uniform2f(g.u.u_res, w, h);
    gl.uniform1i(g.u.u_t, t);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, subj ? mk.tex.out : this.empty2D());
    gl.uniform1i(g.u.u_mask, 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, dist || this.empty2D());
    gl.uniform1i(g.u.u_dist, 7);
    gl.uniform2f(g.u.u_workRes, e.w, e.h);
    this.into(W.raw, w, h);
    gl.useProgram(g.prog);
    gl.uniform1i(g.u.u_src, custom ? 1 : 0);
    gl.uniform2f(g.u.u_offset, A.offsetX, A.offsetY);
    gl.uniform2f(g.u.u_tile, Math.max(1, A.tileX), Math.max(1, A.tileY));
    gl.uniform1i(g.u.u_mirror, A.mirrorTile ? 1 : 0);
    if (custom) {
      const c = this.custom, im = map.image;
      const layer = map.source === 'video' ? videoMapFrame(t, c.count, map.video.speed, map.video.offset, map.video.end) : 0;
      gl.uniform1f(g.u.u_layer, layer);
      gl.uniform2f(g.u.u_csize, c.w, c.h);
      gl.uniform1i(g.u.u_fit, FITS[im.fit] ?? 0);
      gl.uniform1f(g.u.u_outside, im.outside);
      gl.uniform2f(g.u.u_pos, im.x, im.y);
      gl.uniform1f(g.u.u_scale, im.scale);
      gl.uniform1f(g.u.u_crot, im.rotation);
      gl.uniform2f(g.u.u_flip, im.flipX ? -1 : 1, im.flipY ? -1 : 1);
    } else {
      const type = MAP_INDEX[map.type] ?? 0;
      const k = new Float32Array(12);
      k.set(paramArray(map.type, map.params[map.type]));
      gl.uniform1i(g.u.u_type, type);
      gl.uniform1fv(g.u['u_k[0]'], k);
      gl.uniform1f(g.u.u_phase, an.phaseSpeed * t);
      gl.uniform1f(g.u.u_rot, an.rotSpeed * t);
      gl.uniform1f(g.u.u_pulse, 1 + an.pulseAmount * Math.sin((2 * Math.PI * t) / Math.max(1, an.pulsePeriod)));
      gl.uniform1f(g.u.u_seed, an.seedEvery > 0 ? Math.floor(t / an.seedEvery) : 0);
    }
    drawQuad(gl);

    // 2. Blur (two passes).
    let src = W.raw;
    if (A.blur > 0) {
      gl.useProgram(this.blur.prog);
      gl.uniform1f(this.blur.u.u_radius, Math.min(64, A.blur));
      gl.uniform1i(this.blur.u.u_in, 0);
      gl.activeTexture(gl.TEXTURE0);
      this.into(W.a, w, h);
      gl.bindTexture(gl.TEXTURE_2D, W.raw);
      gl.uniform2f(this.blur.u.u_dir, 1, 0);
      drawQuad(gl);
      this.into(W.b, w, h);
      gl.bindTexture(gl.TEXTURE_2D, W.a);
      gl.uniform2f(this.blur.u.u_dir, 0, 1);
      drawQuad(gl);
      src = W.b;
    }

    // 3. Adjust.
    const ad = this.adjust;
    const pts = Array.isArray(A.curve) ? A.curve : CURVE_PRESETS[A.curve] || CURVE_PRESETS.linear;
    const useCurve = JSON.stringify(pts) !== JSON.stringify(CURVE_PRESETS.linear);
    if (useCurve) this.curve(pts);
    this.into(out, w, h);
    gl.useProgram(ad.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.uniform1i(ad.u.u_in, 0);
    gl.uniform1i(ad.u.u_curve, 1);
    gl.uniform1i(ad.u.u_useCurve, useCurve ? 1 : 0);
    gl.uniform1f(ad.u.u_black, A.black);
    gl.uniform1f(ad.u.u_white, A.white);
    gl.uniform1f(ad.u.u_gamma, A.gamma);
    gl.uniform1f(ad.u.u_contrast, Math.max(-0.99, Math.min(0.99, A.contrast)));
    gl.uniform1i(ad.u.u_posterize, A.posterize);
    gl.uniform1i(ad.u.u_invert, A.invert ? 1 : 0);
    drawQuad(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Thumbnails (plan §12.4): each map of the list at w x h for frame t, as luma bytes.
  thumbs(list, t, w, h) {
    const gl = this.gl;
    const out = this.makeTarget(w, h);
    const save = this.targets;
    this.targets = null;
    const res = [];
    const px = new Float32Array(w * h * 4);
    const px8 = new Uint8Array(w * h * 4);
    for (const map of list) {
      this.run(map, t, out, w, h);
      this.into(out, w, h);
      const y = new Uint8Array(w * h);
      if (this.float) {
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        for (let i = 0; i < w * h; i++) y[i] = Math.round(Math.max(0, Math.min(1, px[i * 4])) * 255);
      } else {
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px8);
        for (let i = 0; i < w * h; i++) y[i] = px8[i * 4];
      }
      res.push(y);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.targets) for (const k of ['raw', 'a', 'b']) gl.deleteTexture(this.targets[k]);
    this.targets = save;
    gl.deleteTexture(out);
    return res;
  }
}
