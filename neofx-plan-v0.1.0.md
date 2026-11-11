# neofx — Implementation Plan (for app version 0.1.0)

Plan file: `neofx-plan-v0.1.0.md`. Language: ASD-STE100 Simplified Technical English.

---

## 0. How to use this file

1. Read all of this file before you write code.
2. Do the phases in §14 in sequence. Do not start a phase before the tests of the previous phase pass.
3. Section §2 is the decisions log. It is the record of what Ryan selected. Do not change a decision without a question to Ryan.
4. Section §15 has the open items. Build the default that each item gives, and keep the code easy to change for that item.
5. When a phase is done, update the README.md and the version in `package.json`.

---

## 1. Summary

neofx is a video effect app in one standalone HTML file. It makes time distortion effects.

- **Mode 1 — Time Map.** A greyscale map gives each pixel a delay in frames. Black = the current frame. White = the maximum delay (a slider).
- **Mode 2 — Slit Scan.** A 1 px source line (or the edge of the subject) repeats in one direction. With **Time** on, each pixel gets older as its distance from the source increases.
- **Cutout.** A background removal that has no machine-learning model. It can put the subject on top of the effect, or apply the scan to the subject only.
- **Compositor.** The effect layer and the subject layer go on the original video with a blend mode, an opacity, and an alpha decay by age.
- **Export.** Full-resolution MP4 (H.264) with the original audio copied without a new encode.

Hard rules:

- R-1: One HTML file. No libraries. No network requests. The app works offline and from GitHub Pages.
- R-2: Use only browser APIs: WebCodecs (`VideoDecoder`, `VideoEncoder`), WebGL2, `OffscreenCanvas`, Workers, File API. These are not libraries and not online calls.
- R-3: Input: MP4 and MOV files only (the frame-exact path).
- R-4: Main platforms: desktop Chrome and Chrome on Android. Other browsers that have WebCodecs and WebGL2 must work, but are not the test targets.
- R-5: There is no live camera input.
- R-6: The output file name of the build has the version: `dist/neofx-v0.1.0.html`. The build also copies it to `index.html` for GitHub Pages.

---

## 2. Decisions log (from the planning chat)

| ID | Decision |
|---|---|
| D1 | App name: **neofx** (all lowercase). |
| D2 | Reuse parts of neomosh (`github.com/neospacial/neomosh`): the MP4 reader, the MP4 muxer, the WebCodecs decode/encode patterns, the build tool, and the test harness (§3). Do not reuse the neomosh H.264 codec. |
| D3 | One shared engine for the two modes: the same decode pipeline, frame store, compositor, and export (§5). |
| D4 | Optional frame blend: when a delay is between two frames, mix the two frames. This removes visible steps on smooth gradients. |
| D5 | Memory limit: a maximum delay that the frame store can hold, and a working resolution setting for the preview. The UI shows the limit (§6.4). |
| D6 | Background removal without an AI model: background difference (median clean plate), chroma key, luma key, a mask brush (garbage matte), and feather/grow/shrink. Made for tripod footage. Ryan accepted this. |
| D7 | Mode 1 direction: black = current frame. White = a past frame. The delay for white is a slider, in **frames**, up to the maximum that the frame store can hold. |
| D8 | "Not online" rule: when a pixel needs a frame before frame 0, it is black. It comes online when the playhead gets to the frame that it needs. After that, it always has a reference. This rule applies to Mode 1 and Mode 2. |
| D9 | Mode 1 maps: as many built-in gradients and patterns as is reasonable for time displacement (§7.3). Custom image map with Fill / Fit / Stretch. Custom video map (animated map). |
| D10 | Mode 2 rate: any reasonable rate, and a rate that is a function of the age of the pixel (pixels move faster or slower as they get older). |
| D11 | Mode 2 overlay: the old pixels can go on the original video. Alpha: full, or decay with age. Blend modes: Normal, Overlay, Subtract, Multiply, Exclusion, Divide, and more (§10.2). The subject cutout can also go on top with the same options. |
| D12 | Mode 2 source line: a 1 px line at any angle and any position. The repeat goes perpendicular to the line, in one direction only. A setting turns the direction 180°. |
| D13 | Mode 2 Time switch: **Off** = the current line repeats (static smear). **On** = the pixels get older as they go away from the line. |
| D14 | Cutout modes: **Off** (default); **Overlay** (subject on top of the scanned video; the scan source can be the line or the subject edge); **Scan object** (background is the original video; the scan applies only to the subject layer; the source is always the subject edge). |
| D15 | Edge source: all perimeter pixels of the subject are the source. The user sets the scan direction (an angle). |
| D16 | Audio: copy the original audio into the export without a new encode (pass-through). |
| D17 | Output: MP4, H.264 only. |
| D18 | Input: MP4/MOV only. |
| D19 | Preview: reduced resolution for real-time play. Full quality only at export. |
| D20 | Presets: save to and load from files. |
| D21 | UI: desktop-editor layout, with the most functions. It must also work on Chrome for Android (§12). |

---

## 3. Reuse from neomosh

Copy these files into the neofx repository. Keep their tests. Change them as given.

| neomosh file | Use in neofx | Changes |
|---|---|---|
| `src/mux/demux.js` (`demuxMp4`) | Read the video track of MP4/MOV: decoder config, samples, display times, sync flags, rotation (`tkhd` matrix), edit list (`elst`). | Add the audio track: codec (`mp4a`, also `Opus` if present), raw sample entry (copy the `esds`/`dOps` bytes), sample offsets, sizes, times. Add fragmented MP4 only if it is easy; else show "This file type is not supported". |
| `src/mux/mp4.js` (`muxMp4`, `avcC`, `DataPacker`) | Write the export file: `ftyp`, `moov`, `mdat`, `co64` when necessary. | Add a second track (audio) with the copied sample entry. Interleave video and audio chunks (for example, 1 s chunks). Add a `colr` box (BT.709). |
| `src/mux/remux.js` (`CutRetime`) | Reference only, for time-scale arithmetic. | — |
| `src/app/worker.js` (VideoDecoder part, §11.5 in neomosh) | Frame-exact decode of a file, not in real time. Back-pressure handling. | Move into `src/io/decode-worker.js`. Add seek to the previous sync sample, then decode forward. |
| `src/app/upscale.js` (`upscaleConfig`) | The list of H.264 codec strings and the `isConfigSupported` probe. | Probe High (`avc1.640034`/`640028`), then Main (`avc1.4D0028`), then Baseline (`avc1.42E028`). Select the level from the size and frame rate. |
| `src/app/worker.js` (VideoEncoder part) | Encode pattern with `encodeQueueSize` back-pressure. | Move into `src/io/encode-worker.js`. |
| `tools/build.mjs` | Inline all sources into one HTML file. Markers `<!--@css-->`, `<!--@js-->`, `<!--@modules-->`, `"@WORKER:…"`, `@VERSION@`. | Remove `CODEC_MODULES`. Add an `@GLSL:path` marker that inlines a shader file as a JS string. |
| `tests/` harness, `tests/lib/` | Node tests, FFmpeg/ffprobe checks, Playwright browser tests. | Keep the structure. Replace the codec tests. |

Do not copy: `src/codec/`, `src/codec/wasm/`, `src/app/recorder.js`, the camera UI, IndexedDB clip storage.

---

## 4. Platform requirements

At startup, check these items. If an item is missing, show one clear message and stop.

| Item | Check | When missing |
|---|---|---|
| WebGL2 | `canvas.getContext('webgl2')` | "This browser has no WebGL2." |
| Float render targets | `EXT_color_buffer_float` (or half float) | Use RGBA8 targets. Some modes lose precision (see §8.3). |
| `VideoDecoder` | `typeof VideoDecoder` and `isConfigSupported` for the file | "This browser cannot decode this file (codec: …)." |
| `VideoEncoder` H.264 | `isConfigSupported` (§3) | Preview works. Export is disabled with a message. |
| `OffscreenCanvas` + WebGL2 in a worker | Feature test | Run the GPU work on the main thread (fallback). |
| `MAX_ARRAY_TEXTURE_LAYERS`, `MAX_TEXTURE_SIZE` | Read once | Limits the frame store (§6.4). |

---

## 5. Architecture

### 5.1 Threads

| Thread | Work |
|---|---|
| Main | UI, input, preview canvas display, settings state, undo/redo. |
| Decode worker | `demuxMp4`, `VideoDecoder`, seek, frame delivery (transferable `VideoFrame`). One instance for the source video. One more instance for a video map (§7.4). |
| GPU worker | Owns an `OffscreenCanvas` with WebGL2. Holds the frame store, the slit history, the mask pipeline, the compositor. Renders the preview, and renders the export frames. |
| Analysis worker | CPU work: the median clean plate (§9.2). |
| Encode worker | `VideoEncoder` and the muxer at export. |

Data flow (preview and export use the same flow):

```
file ─► demux ─► VideoDecoder ─► VideoFrame ─► GPU worker:
          upload ─► frame store (ring) ─► mask pipeline ─► effect (Mode 1 or Mode 2) ─► compositor
              ─► preview canvas (preview)  or  ─► VideoFrame(canvas) ─► VideoEncoder ─► muxer (export)
```

### 5.2 The shared engine (D3)

The engine has these parts. Each mode uses some of them.

| Part | Mode 1 | Mode 2 Line | Mode 2 Edge |
|---|---|---|---|
| Frame store (ring buffer of past frames, §6) | yes | no | no |
| Slit history (one line for each frame, §8.3) | no | yes | no |
| Emitter history (subject edges for each frame, §8.4) | no | no | yes |
| Mask pipeline (§9) | if a cutout or a mask-based map is on | if cutout is on | yes |
| Compositor (§10) | yes | yes | yes |

The **frame index** is the unit of time everywhere (D7). Frame *t* is the *t*-th decoded frame in display order. Variable frame rate files keep their original timestamps at export, so the audio stays in sync.

### 5.3 Repository layout

```
src/
  app/        index.html, style.css, main.js, ui/ (panels, widgets, curve editor, timeline)
  io/         demux.js, mp4.js, decode-worker.js, encode-worker.js, export.js, preset.js
  gpu/        gl.js (context, textures, programs), store.js, slit.js, emit.js, mask.js, composite.js
  gpu/glsl/   *.vert, *.frag
  maps/       builtin.js (procedural maps), mapsource.js (image / video maps)
  analysis/   cleanplate.js
tools/        build.mjs, make-fixtures.mjs
tests/        node and Playwright tests (§13)
dist/         neofx-v<version>.html
index.html    copy of the app for GitHub Pages
```

---

## 6. Decode, seek, and the frame store

### 6.1 Load

1. The user drops or opens a file.
2. `demuxMp4` reads it. If it returns null, show "Only MP4 and MOV files are supported."
3. Apply the rotation from `tkhd` (use `turnedCrop` from neomosh). All later work uses the turned (display) size.
4. Read the frame count, the frame times, the source fps (the median of the frame durations), and the audio track (if present).
5. Make the timeline thumbnails in the background (decode one frame for each 2 % of the length, at 160 px).

### 6.2 Seek

To show frame *t* with a mode that needs history of depth *A* frames:

1. Find the last sync sample at or before frame max(0, *t* − *A*).
2. Decode forward from that sample. Upload each frame into the frame store. Do not render the frames before *t* (warm-up).
3. Render frame *t*.

Show a small progress bar on the preview during warm-up. A new seek cancels the warm-up that is in progress.

Mode 2 does not need warm-up after the analysis pass (§8.3, §8.4), because its history is small and it is kept for the full video.

### 6.3 Frame store (Mode 1)

- A `TEXTURE_2D_ARRAY` ring buffer with *N* layers. Layer = frame index mod *N*.
- Storage format: **YUV 4:2:0** to use less memory: one R8 array for Y (full size) and one RG8 array for UV (half size). That is 1.5 bytes for each pixel (RGBA8 is 4). Convert to RGB in the shader that samples the store.
- Upload: draw the `VideoFrame` (as a texture source) to an RGB target, then convert to Y and UV in one pass. Close each `VideoFrame` immediately after the upload.

### 6.4 Memory limit (D5)

- At startup and when the working resolution changes, compute *N*:
  *N* = min(`MAX_ARRAY_TEXTURE_LAYERS`, floor(budget / bytesPerFrame), 1000).
- Budget: start at 1.0 GB on desktop and 384 MB on Android. Do a test allocation. If it fails (`gl.getError()` = `OUT_OF_MEMORY`, or context lost), halve the budget and try again.
- The **Max delay** slider of Mode 1 cannot go above *N* − 1.
- Show the limit in the status bar: "Buffer: 240 frames at 540p (≈ 330 MB)".
- At export, the store is at the export resolution. Compute *N* for that resolution before the export starts. If the Max delay is larger than *N* − 1, tell the user, and offer a lower export resolution.

---

## 7. Mode 1 — Time Map

### 7.1 The effect

For each output pixel *p* at frame *t*:

```
v      = map(p, t)            // 0..1, after the map adjustments (§7.5)
d      = v × MaxDelay         // frames, a float
d      = quantize(d)          // if Delay steps > 0
src    = t − d
if src < 0:  output = black (D8)   // "not online"
else if FrameBlend on:  output = mix(frame[floor(src)], frame[ceil(src)], fract(src))
else:  output = frame[round(src)]
```

`frame[k]` is read from the frame store at the same pixel position *p*.

### 7.2 Mode 1 settings

| Setting | Values | Default |
|---|---|---|
| Max delay (white) | 0 … *N* − 1 frames | min(30, *N* − 1) |
| Delay steps | 0 (smooth), 2 … 64 | 0 |
| Frame blend | On / Off | On |
| Map source | Built-in / Image / Video | Built-in: Linear |
| Spatial offset (optional) | 0 … 64 px, angle | 0 — each delayed pixel also moves by *v* × offset. Gives a "drag" look. |

### 7.3 Built-in maps (D9)

Each map has its own parameters, plus the common adjustments in §7.5. Every built-in map can animate (§7.6).

| Map | Parameters |
|---|---|
| Linear | angle, position, width |
| Mirrored linear | angle, center, width |
| Radial | center, radius, aspect |
| Angular (conic) | center, start angle, turns |
| Spiral | center, arms, tightness |
| Diamond / Box | center, size, roundness |
| Four corners | value at each corner (bilinear) |
| Stripes / Bars | count, angle, softness, duty |
| Sine waves | frequency x, frequency y, angle, phase |
| Rings | center, count, softness |
| Checkerboard | cells, softness |
| Value noise / fBm | scale, octaves, roughness, seed |
| Ridged noise | scale, octaves, seed |
| Cellular (Worley) | scale, seed, metric (distance to cell point) |
| Voronoi cells | scale, seed (one random delay for each cell — "shattered time") |
| Random blocks (mosaic) | block width, block height, seed |
| Random rows / columns | size, direction, seed |
| Bayer dither | matrix size (2, 4, 8), base value |
| Video luminance (self) | source: current frame luma. Bright = old (or inverted) |
| Motion | frame difference of the source (smoothed). Moving areas = old |
| Subject mask | subject = one value, background = another (uses §9) |
| Subject distance | distance from the subject edge, with a falloff (uses §9) |

Procedural maps are GLSL functions. They render into an R16F (or R8) map texture at the working resolution, one time for each frame only if the map animates.

### 7.4 Custom maps

- **Image map:** PNG / JPEG / WebP. Convert to luma (BT.709 weights). Fit mode: **Fill** (cover and crop), **Fit** (contain; the empty area uses the "Outside value" setting, default 0), **Stretch**. Plus a transform: position, scale, rotation, flip.
- **Video map:** MP4/MOV, decoded with a second decode worker. Same fit modes and transform. Sync: **Frame-locked** (map frame = source frame index × speed + offset), with end behavior **Loop**, **Hold last**, or **Ping-pong**.

### 7.5 Map adjustments (all map sources)

Invert; Levels (black point, white point); Gamma; Contrast; Curve (curve editor, §12.6); Posterize (steps); Blur (radius); Tile (x, y) and Mirror tile; Offset (x, y). The order is fixed: transform → tile → blur → levels → gamma/contrast → curve → posterize → invert.

### 7.6 Map animation

For built-in maps: Phase speed (scroll in the direction of the map), Rotation speed (°/frame), Pulse (scale oscillation: amount, period), Seed change every *k* frames. For a time-based map, the map value at frame *t* uses the parameters at frame *t*.

---

## 8. Mode 2 — Slit Scan

### 8.1 Geometry

- The **source line** is a 1 px line. The user sets a point on it (x, y) and an angle (0–360°). The user drags the line on the preview, and drags a rotate handle.
- The **scan direction** *d* is perpendicular to the line. The repeat goes only on one side (D12). **Flip direction** turns *d* by 180°.
- All Mode 2 work happens in a **rotated space** where *d* is +x′. Then each row of the rotated space is one ray. The source line is the column x′ = x₀.
- Turn the frame into the rotated space with one resample pass (bilinear). For 0°, 90°, 180°, 270°, use an exact pixel transpose (no resample). The rotated texture size is the size of the box that holds the turned frame.
- Pixels on the other side of the line (x′ < x₀) show the original video (they are not part of the effect layer).

### 8.2 Time Off (D13)

The effect pixel at (x′, y′) with x′ ≥ x₀ is the current source pixel at (x₀, y′). This is the classic static smear.

### 8.3 Time On, line source (exact method)

Age as a function of distance:

- The user sets the **rate** *r(a)* in pixels for each frame, as a function of the age *a* (D10).
- The distance that a pixel moves by the age *a* is *S(a)* = ∫₀ᵃ *r* dτ. Make *S* as a lookup table with one entry for each frame of age, up to Max age.
- The inverse, *A(s)* (age for a distance *s*), is a second lookup table (1D texture, float). Make it by binary search on *S*.

**Slit history.** For each decoded frame *t*, copy the pixels of the source column (x₀, all y′) into row (*t* mod *H*) of a 2D texture: width = rotated height, height *H* = history length. Memory: a 2200 px line × 4096 rows × 4 B = 36 MB. *H* default = the frame count of the video (if it fits), else 4096.

The history depends only on the line position, the angle, and the source video. When the line changes, rebuild the history: an **analysis pass** decodes the full video at the working resolution and fills the history. Show progress. Until the pass is done, the preview uses the frames that are in the history; frames that are not in it yet are black.

Effect pixel at (x′, y′), frame *t*:

```
s   = x′ − x₀                    // distance from the source line, ≥ 0
a   = A(s)                       // age in frames (float)
if a > MaxAge: transparent
src = t − a
if src < 0: black (D8)
color = history(row = src, column = y′)   // nearest row (Sharp) or mix of 2 rows (Blend)
age   = a                        // to the compositor, for decay and tint
```

This is exact for each rate function, also for fractional rates (for example 0.25 px/frame).

### 8.4 Time On, edge source (D14, D15)

The source is all the perimeter pixels of the subject (from the mask, §9). The subject moves, so the source moves.

**Emitters.** For each frame, in the rotated space, scan each row. An emitter is a position where the mask goes from inside (≥ 0.5) to outside along +x′. Keep up to *K* = 4 emitters for each row (the first 4 from the left). For each emitter, store its x′ position (sub-pixel, from the mask values) and the color of the last subject pixel. Store this for each frame in an **emitter history** texture: (row, frame mod *H*, emitter k) → (x′, RGBA). Memory: 2200 rows × 1024 frames × 4 × 8 B ≈ 72 MB. Default *H* for edges = 512 frames (the Max age limit for Edge source).

The emitter history is made by the same analysis pass as §8.3 (it needs the mask, so the mask settings are part of the input of the pass).

Note: emitters on the far side of the subject (where the trail goes into the subject) also make trails. The subject layer is on top, so it covers those trails (D15: "all perimeter pixels").

**Trail render (each output frame *t*).** Draw the trail of each emitter as line segments in the rotated space:

1. For each row y′, each age a = 0 … MaxAge − 1, each emitter k of frame *t* − a: the position is x_e(*t* − a, k) + *S*(a). Join the positions of age a and age a + 1 for the same row and the same k with a horizontal segment (`GL_LINES`, or a full-screen pass that does the same in a fragment shader).
2. Each segment carries the color and the age. Use the depth test with depth = age, so the **youngest** pixel wins where trails overlap.
3. The segments fill the gaps when the rate is more than 1 px/frame (the trail stretches). When the rate is less than 1, the segments are short and the trail is compressed. Both are correct.
4. Emitter k of frame *t* − a and emitter k of frame *t* − a − 1 can be different edges. Only join them when |Δx_e| < "Join limit" (default 8 px). Else draw a point.

Cost: rows × MaxAge × K segments. Limit MaxAge for the Edge source by the measured GPU time (target ≤ 20 ms at the preview resolution). The UI shows the limit.

**Time Off with the edge source:** for each row, the current emitter color repeats from the emitter position to the next emitter (or to the end of the row) in +x′. Use one fragment pass that scans the emitters of the row (K ≤ 4).

### 8.5 Mode 2 settings

| Setting | Values | Default |
|---|---|---|
| Source | Line / Subject edge (Edge needs Cutout ≠ Off) | Line |
| Line position | x, y (drag on preview) | center |
| Line angle | 0–360°, snap 15° with Shift (desktop) or a snap button (touch) | 90° (vertical line, scan to the right) |
| Edge direction (Edge source) | 0–360° | 0° (to the right) |
| Flip direction | On / Off | Off |
| Time | Off / On | On |
| Rate type | Constant, Accelerate, Decelerate, Exponential, Custom curve | Constant |
| Rate | 0.05 … 32 px/frame | 1 |
| Rate end / curve | for the non-constant types: rate at Max age, or the curve | — |
| Max age | 1 … *H* frames | 600 (Line), 120 (Edge) |
| Sampling | Sharp (nearest frame) / Blend (mix 2 frames) | Sharp |
| Slit width | 1 … 16 px (average of the pixels across the line) | 1 |
| Join limit (Edge) | 1 … 64 px | 8 |

Rate type formulas (age *a* from 0 to Max age *M*, *u* = *a*/*M*):

- Constant: *r* = r₀
- Accelerate: *r* = r₀ + (r₁ − r₀) · u²
- Decelerate: *r* = r₀ + (r₁ − r₀) · (1 − (1 − u)²)
- Exponential: *r* = r₀ · (r₁/r₀)^u
- Custom curve: *r* = r₀ + (r₁ − r₀) · curve(u)

---

## 9. Cutout (subject mask, D6)

### 9.1 Mask pipeline (GPU, each frame)

1. **Methods** (each one on or off; each gives a soft mask 0–1):
   - **Background difference:** distance between the current frame and the clean plate in YCbCr. Weight for Y is lower (to ignore light changes) — "Light tolerance" setting. Threshold and softness. Shadow suppression: if Y is darker by less than X % and the chroma is the same, it is background.
   - **Chroma key:** key color (eyedropper on the preview), tolerance, softness, spill suppression amount.
   - **Luma key:** low, high, softness, invert.
2. **Combine:** Union (max) or Intersect (min) of the methods that are on.
3. **Garbage matte:** a painted texture with two values: "Always subject" and "Never subject". The user paints with a brush (size, hardness) on the preview. The matte is static for the full video in v0.1.0.
4. **Clean up:** Open (remove small spots), Close (fill small holes), Fill holes (enclosed areas smaller than X % of the frame — use a flood pass from the border in a worker on a small copy, ≤ 256 px), Keep largest region (optional).
5. **Grow / Shrink:** −32 … +32 px (min/max passes).
6. **Temporal smooth:** mix with the mask of the previous frame (0–0.95). Plus hysteresis: a pixel turns on above T_high, and turns off below T_low.
7. **Feather:** blur radius 0–32 px.

The mask is computed at the export resolution at export, and at the working resolution in the preview.

### 9.2 Clean plate

Three options:

- **Auto (median):** the analysis worker takes 31 frames, evenly spaced over the video, at ≤ 540 px short side. The clean plate is the median of each pixel and channel. Then it is scaled to the working size.
- **Pick a frame:** the user moves the playhead to a frame with no subject and touches "Use this frame".
- **Image file:** the user opens an image of the empty scene.

### 9.3 Mask import (extra)

The user can open a black-and-white mask video (MP4/MOV) that they made in a different app. It replaces steps 1–3. Steps 4–7 still apply.

### 9.4 Cutout modes (D14)

| Mode | Base layer | Effect layer | Top layer |
|---|---|---|---|
| Off (default) | original | effect (Mode 1 or Mode 2) | — |
| Overlay | original | effect. Mode 2 source: Line or Subject edge | subject (current frame × mask), not changed by the effect |
| Scan object (Mode 2 only) | original, not changed | Mode 2 trail of the subject only. Source is always Subject edge + direction | subject (current frame × mask) |

In Mode 1, Cutout can be Off or Overlay. Scan object is a Mode 2 mode only.

---

## 10. Compositor

### 10.1 Layers and order

Bottom to top: **Base** → **Effect** → **Subject**. Each pixel of the effect layer has a color, a coverage alpha, and an age (frames).

Rules for "not online" pixels (D8) and empty pixels:

- **Effect composite = Replace** (default for Mode 1, and for Mode 2 with Cutout Off): the effect replaces the base. Pixels that are not online are black. In Mode 2, pixels outside the effect side show the base.
- **Effect composite = Blend** (D11): the effect goes on the base with the blend mode and the alpha below. Pixels that are not online and empty pixels are transparent, so the base shows.

### 10.2 Blend modes

For the effect layer and for the subject layer (each has its own setting):
Normal, Add, Screen, Lighten, Color dodge, Overlay, Soft light, Hard light, Multiply, Darken, Color burn, Subtract, Difference, Exclusion, Divide, Hue, Saturation, Color, Luminosity.

Use the W3C Compositing and Blending formulas. Work in linear light, as an option ("Linear blend", default Off).

### 10.3 Alpha and age settings

| Setting | Values | Default |
|---|---|---|
| Opacity | 0–100 % | 100 % |
| Age decay | Full (no decay), Linear, Exponential (half-life in frames), Custom curve | Full |
| Decay length | 1 … Max age frames | Max age |
| Age tint (optional) | Off / a 2–4 color ramp from new to old, with amount | Off |
| Age brightness (optional) | multiplier at max age, 0–2 | 1 |

These settings also apply to Mode 1 (age = the delay *d*).

### 10.4 Subject layer settings

Blend mode (default Normal), opacity, its own feather and grow/shrink (in addition to §9.1), optional outline (width, color) for graphic looks.

---

## 11. Export

### 11.1 Export settings (export dialog)

| Setting | Values | Default |
|---|---|---|
| Resolution | Source, 2160, 1440, 1080, 720, 540 (short side; never above the source) | Source |
| Quality | Bitrate (Mbit/s) or a quality preset: Low / Medium / High / Very high | High (≈ 0.12 bit for each pixel for each frame) |
| Keyframe interval | 1 … 10 s | 2 s |
| Range | Full, or In–Out from the timeline | Full |
| Audio | Copy original / None | Copy original (if the file has audio) |
| Hardware encode | Prefer hardware / Prefer software | Prefer hardware |
| File name | text | `<source name>-neofx.mp4` |

The frame rate and the frame times are the same as the source.

### 11.2 Export process

1. Probe the encoder config (§3). If not supported, try the next profile, then a lower resolution, and tell the user.
2. Make the frame store, slit history, emitter history at the export resolution. For Mode 2, run the analysis pass at the export resolution first.
3. Decode from the last sync sample before In − warm-up. Render each frame. Make a `VideoFrame` from the GPU canvas with the source timestamp and duration. Encode. Keep `encodeQueueSize` ≤ 8.
4. Audio: copy the audio samples between In and Out (whole samples) to the muxer, with the times moved by −In.
5. Mux with `muxMp4` (video + audio). If the file is large (more than 1 GB, or the device has less memory), write the parts to the Origin Private File System, then make the download from that file.
6. Show progress (frames, fps, time left). **Cancel** stops the export and frees the memory.
7. On iOS-like environments with `navigator.share` for files, show **Share**; else **Download**.

### 11.3 Color

- Treat input as BT.709 SDR (or BT.601 when the `VideoFrame.colorSpace` says so).
- HDR input (for example HLG from a phone) is shown and exported as SDR with the browser conversion. Write a note in the README "Known limits".

---

## 12. User interface (D21)

### 12.1 Principles

- The preview is the largest item on the screen at all times.
- Direct control on the preview: drag the line, rotate it, flip the arrow, paint the matte, pick the key color, move the map.
- Each setting has a label, a slider, a number field, and a reset (double-click / double-tap on the label). Default values are marked.
- Settings that do not apply are hidden, not disabled (for example, Edge settings when Source = Line).
- Dark neutral theme, so the colors of the video are easy to see. One accent color. No decoration on the preview.

### 12.2 Desktop layout (width ≥ 1000 px)

```
┌───────────────────────────────────────────────────────────────────────┐
│ neofx   [Open] [Presets ▾] [Undo][Redo]         Buffer 240f · 30fps   [Export] │  top bar
├──────────────────────────────────────────────────┬────────────────────┤
│                                                  │ MODE  [Time Map|Slit Scan] │
│                                                  │ ▸ Map / Source     │
│                 PREVIEW                          │ ▸ Time             │
│     (view: Result | Original | Split | Mask | Map)│ ▸ Cutout           │
│                                                  │ ▸ Composite        │
│                                                  │ ▸ Look (age tint…) │
│                                                  │ [Randomize] [Lock] │
├──────────────────────────────────────────────────┴────────────────────┤
│ ⏮ ◀| ▶ |▶ ⏭  00:12.04 / 01:30.00  f 362   [Loop]  [Preview: 540p ▾]   │  transport
│ [thumbnail strip with playhead, In and Out markers]                     │  timeline
└───────────────────────────────────────────────────────────────────────┘
```

- Right panel ("Inspector"): 340 px, resizable (280–520 px). Sections are collapsible. The order of sections follows the work: what makes the effect → how time works → the subject → how the layers mix → extra looks.
- View switch over the preview: **Result**, **Original**, **Split** (a drag wipe between original and result), **Mask** (the subject mask in white), **Map** (the Mode 1 map, or the age as a heat color in Mode 2).
- Zoom: Fit, 100 %, mouse wheel, drag with the middle button or Space+drag.

### 12.3 Android / narrow layout (width < 1000 px)

```
┌───────────────────────────┐
│ neofx  [Open] [⋯]  [Export]│
├───────────────────────────┤
│         PREVIEW            │  (sticky, top; 16:9 area or the video aspect)
├───────────────────────────┤
│ ▶  f 362  ───●─────── [⋯] │  transport + scrub bar
├───────────────────────────┤
│ [Mode][Map][Time][Cutout][Mix][Look] │  tabs, horizontal scroll
│  settings of the tab       │  (bottom sheet, drag up to make it taller)
└───────────────────────────┘
```

- In landscape on a phone or tablet ≥ 700 px wide: preview left, sheet right (like desktop, narrower).
- Touch targets ≥ 44 px. Sliders: drag along the track; long press then drag for fine steps (×0.1).
- Two fingers on the preview: pinch zoom and pan. One finger: the active tool (line, brush, eyedropper, map move).

### 12.4 Inspector sections (content)

1. **Mode:** Time Map / Slit Scan.
2. **Map** (Mode 1): source type, map list as a grid of small live thumbnails, map parameters, fit/transform, adjustments, animation.
   **Source** (Mode 2): Line / Subject edge, position, angle, flip, slit width, edge direction.
3. **Time:** Mode 1: Max delay, Delay steps, Frame blend. Mode 2: Time On/Off, rate type, rate, curve, Max age, Sampling.
4. **Cutout:** mode (Off / Overlay / Scan object), methods, clean plate, garbage matte tools, clean-up, grow/shrink, temporal smooth, feather, mask import.
5. **Composite:** Effect composite (Replace / Blend), blend mode, opacity, age decay. Subject layer: blend, opacity, outline.
6. **Look:** age tint, age brightness, spatial offset (Mode 1).

### 12.5 Exploration tools

- **Randomize:** sets random values in safe ranges for the open section, or for all sections. A lock icon on each section keeps it. Use a seed, so that **Undo** returns the last look.
- **Presets:** built-in presets (at least 12, covering both modes and the cutout modes) in a gallery with small thumbnails. **Save preset** writes a `.neofx.json` file. **Load preset** reads it. The last settings also stay in `localStorage` (with try/catch).
- Preset file format: `{ "app": "neofx", "version": "0.1.0", "settings": { … } }`. Custom map images and the garbage matte are stored in the file as data URLs (PNG). A custom video map is stored as its file name only; at load, the app asks for the file.
- **Undo / Redo:** each setting change (a slider drag is one change).

### 12.6 Curve editor

One widget for: map curve, rate curve, decay curve. Points with drag, add (click/tap on the line), remove (double-click / long press). Presets: Linear, Ease in, Ease out, S-curve, Step. Monotone cubic interpolation.

### 12.7 Keyboard (desktop)

Space play/pause; ← / → one frame; Shift+← / → 10 frames; Home / End; I / O set In / Out; J K L play backward / stop / forward; \ (backslash) hold to show the original; M mask view; Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z; Ctrl/Cmd+E export.

### 12.8 Status

- Status bar: buffer frames and memory, preview fps, the working resolution.
- When the preview cannot hold the source fps, it drops frames in playback (not in export). A small amber text shows "Preview 18 fps".
- Analysis pass and warm-up show a thin progress bar on the preview.

### 12.9 Start screen

A drop area: "Open a video (MP4 or MOV)". Under it: short text for the two modes, each with an example animation made by the app from a generated test pattern (no files to load).

---

## 13. Verification

### 13.1 Test fixtures

`tools/make-fixtures.mjs` makes test videos with FFmpeg:

- **Frame-number video:** each frame shows its frame number as a binary code in a grid of blocks (8×8 px each, black or white), repeated over the full frame. A test can read, at each pixel, which source frame it shows.
- A subject on a still background (a moving colored disc on a noise background), with a known ground-truth mask.
- A file with a 90° rotation, a file with an edit list, a file with variable frame rate, a file with AAC audio.

### 13.2 Effect tests (Playwright + Chromium, headless with WebGL2)

- Mode 1, vertical gradient, Max delay 30, Frame blend Off: the row with map value *v* shows frame *t* − round(*v*·30). Before frame round(*v*·30), the row is black (D8).
- Mode 2 line, Time On, rate 1: the column at distance *k* shows the source column of frame *t* − *k*. Rate 0.5: distance *k* shows frame *t* − 2*k*. Accelerate: matches *A(s)*.
- Mode 2, Time Off: each column on the effect side equals the source column of frame *t*.
- Line at 37°: the result equals a turned 90° reference within a small error.
- Edge source: the trail of the disc starts at the disc edge and goes in the set direction.
- Mask: IoU with the ground truth > 0.9 for the fixture.
- Compositor: each blend mode against a JS reference of the W3C formula, error ≤ 1/255.

### 13.3 Export tests (Node + FFmpeg)

- ffprobe: H.264, the correct size, the frame count, the frame times equal the source, audio present and the same duration.
- Decode the export with FFmpeg and read the frame-number codes: the delays are correct (with the encoder loss, use the block code, not exact pixels).
- Audio packets are byte-identical to the source packets in the range.

### 13.4 Device tests

Chrome desktop (Windows or macOS) and Chrome Android (one mid-range phone). Record: preview fps at 540p for each mode, export fps at 1080p, the buffer limit. Put the results in the README.

---

## 14. Phases

| Phase | Work | Done when |
|---|---|---|
| 1 | Repository: copy and adapt neomosh `tools/build.mjs`, `src/mux/*`, test harness. `package.json` version 0.1.0. Empty app shell builds to `dist/neofx-v0.1.0.html` and `index.html`. | Build works. Demux/mux tests pass. |
| 2 | Decode worker, seek, timeline, transport, preview canvas (Original only). Rotation, edit list, VFR. | The fixtures play and seek frame-exact. |
| 3 | GPU worker, frame store (YUV), memory probe, status bar. | Store test passes. |
| 4 | Mode 1 with the Linear map. Frame blend, delay steps, D8 black start. | §13.2 Mode 1 test passes. |
| 5 | Map library (§7.3), image and video maps, adjustments, animation, map thumbnails. | All maps render. Fit modes are correct. |
| 6 | Compositor (§10): blend modes, opacity, decay, tint. | §13.2 compositor test passes. |
| 7 | Mode 2 Line: rotated space, slit history, analysis pass, Time Off/On, rate types, curve. Line handles on the preview. | §13.2 Mode 2 tests pass. |
| 8 | Cutout: mask pipeline, clean plate, keys, garbage matte brush, clean-up, mask import, Mask view. Cutout Overlay in Mode 1 and Mode 2 Line. | Mask IoU test passes. |
| 9 | Mode 2 Edge source, emitter history, trail render, Scan object mode. | Edge test passes. Preview GPU time is measured and the Max age limit works. |
| 10 | Export: encoder probe, render loop, audio copy, muxer with audio, OPFS for large files, cancel. | §13.3 tests pass. |
| 11 | UI finish: responsive layouts, inspector, curve editor, randomize, presets (built-in + files), undo/redo, keyboard, start screen. | Playwright UI tests pass on a desktop and a phone-size viewport. |
| 12 | Device tests, performance work, README. | §13.4 results in README. |

---

## 15. Open items (build the default; confirm with Ryan)

| ID | Item | Default to build |
|---|---|---|
| O1 | Cutout **Overlay** with the **Subject edge** source can look the same as **Scan object** when Effect composite = Blend. | Keep both modes. Difference: in Overlay, the effect layer uses Replace by default (pixels that are not online are black); in Scan object, the base is always the original and the effect is always Blend. |
| O2 | Mode 1 with Effect composite = Blend: pixels that are not online are transparent (the original shows), not black. | As written in §10.1. |
| O3 | The garbage matte is static for the full video in v0.1.0. Keyframed mattes can come later. | Static. |
| O4 | Mode 1 + Mode 2 together (stack the two effects). The engine permits it (the Mode 1 output can be the input of Mode 2). | Not in v0.1.0. Keep the code structure ready. |

---

## 16. README (each version)

GitHub format, short: what the app does, how to use it (open, mode, settings, export), the settings tables, browser support, known limits, development commands. No license section.
