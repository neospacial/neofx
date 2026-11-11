// Phase 6 (plan §14, §13.2): the compositor (§10). "Each blend mode against a JS reference of the
// W3C formula, error ≤ 1/255." Then the full effect in Mode 1 (Replace / Blend, opacity, age decay,
// age tint, age brightness) against a JS model, and the UI.

import { createRequire } from 'node:module';
import { assert, hasFfmpeg } from './lib/util.mjs';
import { composite } from './lib/blendref.mjs';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { FIX_DIR } from './fixtures.test.mjs';
import { launch, open } from './playback.test.mjs';
import { BLEND_MODES, hexRgb } from '../src/gpu/blend.js';
import { curveTable, CURVE_PRESETS } from '../src/maps/curve.js';
import { DEFAULTS, clone } from '../src/app/settings.js';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  chromium = null;
}

const W = 320, H = 240;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Test colours: random, plus the edge values (0, 1, 1/2, 1/4, 254/255) and greys.
function inputs(n) {
  const r = rng(5);
  const edge = [0, 255, 128, 64, 254, 1, 192];
  const base = new Uint8Array(n * 4), effect = new Uint8Array(n * 4);
  const alphas = [255, 128, 64, 0, 230];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      base[i * 4 + c] = i % 5 === 0 ? edge[(i + c) % edge.length] : Math.floor(r() * 256);
      effect[i * 4 + c] = i % 7 === 0 ? edge[(i * 3 + c) % edge.length] : Math.floor(r() * 256);
    }
    if (i % 11 === 0) effect[i * 4 + 1] = effect[i * 4 + 2] = effect[i * 4]; // greys
    base[i * 4 + 3] = 255;
    effect[i * 4 + 3] = i % 3 === 0 ? Math.floor(r() * 256) : alphas[i % alphas.length];
  }
  return { base, effect };
}

async function withApp(fn, file = 'code.mp4') {
  if (!chromium || !hasFfmpeg()) return console.log('      (skipped: no Playwright or FFmpeg)');
  const f = makeFixtures(FIX_DIR, ['code.mp4', file]);
  const { browser, page, errors } = await launch({ width: 1280, height: 800 }, '', false);
  try {
    await open(page, f[file]);
    await fn(page);
    assert(!errors.length, errors.join('; '));
  } finally {
    await browser.close();
  }
}

// The JS model of the Mode 1 effect with the compositor (vertical linear map, frame blend off).
function model(S, t, frames, x, y) {
  const C = S.composite, L = S.look;
  const max = S.timemap.maxDelay;
  const px = (k) => {
    const o = (y * W + x) * 4;
    return [0, 1, 2].map((c) => frames[k][o + c] / 255);
  };
  const base = px(0);
  const v = Math.fround((y + 0.5) / H);
  const d = Math.fround(v * max);
  if (t - d < -1e-3) return C.mode === 'blend' ? base : [0, 0, 0];
  let c = px(Math.floor(d + 0.5));
  // Age look.
  const u = Math.min(1, Math.max(0, d / Math.max(1, max)));
  if (L.tint) {
    const n = L.tintColors.length;
    const xx = u * (n - 1), i = Math.min(Math.floor(xx), n - 2), f = xx - i;
    const a = hexRgb(L.tintColors[i]), b = hexRgb(L.tintColors[i + 1]);
    c = c.map((v2, j) => v2 + (v2 * (a[j] + (b[j] - a[j]) * f) - v2) * L.tintAmount);
  }
  const m = 1 + (L.ageBrightness - 1) * u;
  c = c.map((v2) => Math.min(1, Math.max(0, v2 * m)));
  if (C.mode !== 'blend') return c;
  const len = C.decayLength > 0 ? C.decayLength : Math.max(1, max);
  const uu = d / len;
  let alpha = 1;
  if (C.decay === 'linear') alpha = Math.min(1, Math.max(0, 1 - uu));
  else if (C.decay === 'exp') alpha = 2 ** -uu;
  else if (C.decay === 'curve') {
    const tb = Uint8Array.from(curveTable(CURVE_PRESETS[C.decayCurve]), (q) => Math.round(q * 255));
    const xx = Math.min(1, Math.max(0, uu)) * 255, i = Math.floor(Math.min(xx, 254));
    alpha = 1 - (tb[i] + (tb[i + 1] - tb[i]) * (xx - i)) / 255;
  }
  // Hue, Saturation, Color: near-grey colours have no stable hue; the 8-bit frames of the model
  // can then give a different hue than the GPU. Those pixels are not compared (null).
  const satOf = (q) => Math.max(...q) - Math.min(...q);
  if (['hue', 'saturation', 'color'].includes(C.blend) && (satOf(c) < 0.03 || satOf(base) < 0.03)) return null;
  return composite(C.blend, base, c, C.opacity * alpha, C.linear);
}

export const tests = [
  {
    name: '§13.2 compositor: each of the 19 blend modes (and in linear light) against the W3C formulas, error ≤ 1/255',
    timeout: 120000,
    async fn() {
      await withApp(async (page) => {
        const n = 4096;
        const { base, effect } = inputs(n);
        for (const [mode] of BLEND_MODES) {
          for (const linear of [false, true]) {
            const px = await page.evaluate(async ([mode, linear, b, e]) => {
              const r = await window.neofx.gpu.call({ cmd: 'compositeTest', mode, linear, base: Uint8Array.from(b), effect: Uint8Array.from(e) });
              return Array.from(r.pixels);
            }, [mode, linear, Array.from(base), Array.from(effect)]);
            let worst = 0, where = null;
            for (let i = 0; i < n; i++) {
              const cb = [0, 1, 2].map((c) => base[i * 4 + c] / 255);
              const cs = [0, 1, 2].map((c) => effect[i * 4 + c] / 255);
              const ref = composite(mode, cb, cs, effect[i * 4 + 3] / 255, linear);
              for (let c = 0; c < 3; c++) {
                const e = Math.abs(px[i * 4 + c] - Math.round(ref[c] * 255));
                if (e > worst) [worst, where] = [e, { cb: cb.map((q) => q * 255), cs: cs.map((q) => q * 255), a: effect[i * 4 + 3], got: px.slice(i * 4, i * 4 + 3), want: ref.map((q) => +(q * 255).toFixed(2)) }];
              }
            }
            // The 8-bit output is at most 1/255 from the rounded reference.
            assert(worst <= 1, `${mode}${linear ? ' (linear)' : ''}: error ${worst.toFixed(2)} / 255 at ${JSON.stringify(where)}`);
          }
        }
      });
    },
  },
  {
    name: 'Mode 1 with the compositor: Replace / Blend, blend modes, opacity, age decay (linear, exponential, curve), age tint, age brightness',
    timeout: 300000,
    async fn() {
      await withApp(async (page) => {
        const configs = [
          { composite: {}, look: {} }, // Replace (default)
          { composite: {}, look: { tint: true, tintColors: ['#ffffff', '#ff4000'], ageBrightness: 0.5 } },
          { composite: { mode: 'blend', blend: 'normal', opacity: 0.6, decay: 'linear' }, look: {} },
          { composite: { mode: 'blend', blend: 'difference', decay: 'exp', decayLength: 10 }, look: {} },
          { composite: { mode: 'blend', blend: 'screen', linear: true, decay: 'curve', decayCurve: 'easeIn' }, look: {} },
          { composite: { mode: 'blend', blend: 'multiply' }, look: { tint: true, tintColors: ['#80ff80', '#ffffff', '#4060ff'], tintAmount: 0.5, ageBrightness: 1.5 } },
          { composite: { mode: 'blend', blend: 'hue', opacity: 0.8 }, look: {} },
          { composite: { mode: 'blend', blend: 'softlight', decay: 'linear', decayLength: 20 }, look: {} },
          { composite: { mode: 'blend', blend: 'luminosity', linear: true }, look: {} },
        ];
        const b64 = (str) => Buffer.from(str, 'base64');
        // In the page: settings, seek, and the canvas as base64 (top row first).
        await page.evaluate(() => {
          window.__px = async () => {
            const p = (await window.neofx.gpu.call({ cmd: 'read' })).pixels;
            const o = new Uint8Array(p.length);
            for (let y = 0; y < 240; y++) o.set(p.subarray((239 - y) * 1280, (240 - y) * 1280), y * 1280);
            let s = '';
            for (let k = 0; k < o.length; k += 32768) s += String.fromCharCode(...o.subarray(k, k + 32768));
            return btoa(s);
          };
        });
        for (const t of [45, 12]) {
          // The stored frames t − 0 .. t − 30 (they do not depend on the compositor settings).
          const frames = (await page.evaluate(async (t) => {
            const N = window.neofx;
            N.change('timemap.blend', false);
            await N.applySettings();
            await N.player.seek(t);
            const out = [];
            for (let k = 0; k <= 30; k++) {
              await N.gpu.call({ cmd: 'render', index: t, delay: k });
              out.push(await window.__px());
            }
            return out;
          }, t)).map(b64);
          for (const cfg of configs) {
            const S = clone(DEFAULTS);
            Object.assign(S.composite, cfg.composite);
            Object.assign(S.look, cfg.look);
            S.timemap.blend = false;
            const res = b64(await page.evaluate(async ([S, t]) => {
              const N = window.neofx;
              const set = (o, p) => {
                for (const [k, v] of Object.entries(o)) {
                  if (v && typeof v === 'object' && !Array.isArray(v)) set(v, `${p}${k}.`);
                  else N.change(`${p}${k}`, v);
                }
              };
              set({ composite: S.composite, look: S.look, timemap: S.timemap }, '');
              await N.applySettings();
              await N.player.seek(t);
              await N.gpu.call({ cmd: 'render', index: t });
              return window.__px();
            }, [S, t]));
            let bad = 0, worst = 0, where = null;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              const want = model(S, t, frames, x, y);
              if (!want) continue;
              for (let c = 0; c < 3; c++) {
                const e = Math.abs(res[(y * W + x) * 4 + c] - want[c] * 255);
                if (e > 3) bad++;
                if (e > worst) [worst, where] = [e, [x, y, c, res[(y * W + x) * 4 + c], +(want[c] * 255).toFixed(1)]];
              }
            }
            // The non-separable modes (Hue, Saturation, Color, Luminosity) amplify the 8-bit rounding of
            // the model's input frames for dark and grey pixels; the formula test above checks them on
            // identical inputs.
            const allow = ['hue', 'saturation', 'color', 'luminosity'].includes(S.composite.blend) ? 0.01 : 0.002;
            assert(bad <= allow * W * H * 3, `${JSON.stringify(cfg)} t ${t}: ${bad} values differ, worst ${worst.toFixed(1)} at ${where}`);
          }
        }
      }, 'color.mp4');
    },
  },
  {
    name: 'compositor UI: Replace hides the blend settings; Blend shows 19 modes; decay and tint controls',
    timeout: 120000,
    async fn() {
      await withApp(async (page) => {
        const q = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
        assert(!(await q('[data-key="composite.blend"]')), 'Replace: no blend mode');
        await page.click('[data-key="composite.mode"] button[data-value="blend"]');
        await page.waitForFunction(() => window.neofx.settings.composite.mode === 'blend');
        const n = await page.evaluate(() => document.querySelectorAll('[data-key="composite.blend"] option').length);
        assert(n === 19, `${n} blend modes`);
        await page.selectOption('[data-key="composite.blend"] select', 'exclusion');
        await page.selectOption('[data-key="composite.decay"] select', 'exp');
        await page.waitForFunction(() => window.neofx.settings.composite.blend === 'exclusion' && !!document.querySelector('[data-key="composite.decayLength"]'));
        assert((await page.textContent('[data-key="composite.decayLength"] label')) === 'Half-life', 'exp: Half-life');
        await page.evaluate(() => { document.querySelector('details[data-name="look"]').open = true; });
        await page.click('[data-key="look.tint"] button[data-value="true"]');
        await page.waitForFunction(() => document.querySelectorAll('[data-key="look.tintColors"] input[type=color]').length === 2);
        await page.click('[data-key="look.tintColors"] button[aria-label="Add a colour"]');
        await page.waitForFunction(() => window.neofx.settings.look.tintColors.length === 3);
        // Spatial offset: it changes the result; 0 gives it back.
        const read = () => page.evaluate(async () => {
          await window.neofx.applySettings();
          await window.neofx.player.seek(40);
          return Array.from((await window.neofx.gpu.call({ cmd: 'read' })).pixels.filter((_, i) => i % 97 === 0));
        });
        await page.evaluate(() => window.neofx.change('composite.mode', 'replace'));
        const a = await read();
        await page.evaluate(() => window.neofx.change('look.offset', 12));
        const b = await read();
        await page.evaluate(() => window.neofx.change('look.offset', 0));
        const c = await read();
        assert(a.some((v, i) => v !== b[i]) && a.every((v, i) => v === c[i]), 'spatial offset');
      });
    },
  },
];
