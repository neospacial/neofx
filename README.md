# neofx

neofx is a video effect app in one standalone HTML file. It makes time distortion effects:

- **Time Map** — a greyscale map gives each pixel a delay in frames. Black = the current frame, white = the maximum delay.
- **Slit Scan** — a 1 px source line (or the edge of the subject) repeats in one direction. Pixels get older as their distance from the line increases.

The app uses only browser APIs (WebCodecs, WebGL2, Workers). It has no libraries and makes no network requests, so it works offline and from GitHub Pages. The export is an MP4 (H.264) file with the original audio copied.

> Status: v0.1.0, **phase 9 of 12** (see `neofx-plan-v0.1.0.md` §14). Done: the build, the MP4/MOV reader and muxer (video + audio pass-through), frame-exact seek and playback, the GPU frame store, **Mode 1 — Time Map** with the full map library, the **compositor**, **Mode 2 — Slit Scan** with the line and the **subject-edge** sources, and the **cutout** (Overlay and **Scan object**). The export comes in the next phase.

## How to use

1. Open `dist/neofx-v0.1.0.html` (or `index.html` on GitHub Pages) in desktop Chrome or Chrome on Android.
2. Drop an MP4 or MOV file on the page, or touch **Open**.
3. The preview shows the video (turned as the file says). Use the transport to play and to move frame by frame. Drag on the timeline strip to scrub. **In** and **Out** set a range at the current frame (touch again to clear). **Loop** plays the range again and again.
4. **Preview** sets the working resolution of the preview (short side: 360, 540, 720, 1080, or Source). The preview is never larger than the source.

The status bar shows the frame store: for example "Buffer: 240 frames at 540p (≈ 330 MB)". The store is a ring of past frames on the GPU (YUV 4:2:0, 1.5 bytes for each pixel). Its size is the smallest of: the GPU limit of texture layers, the memory budget divided by the size of one frame, and 1000 frames. The budget starts at 1 GB on desktop and 384 MB on Android, and halves when the GPU cannot allocate it. The Max delay of the Time Map effect (phase 4) cannot be more than this number of frames minus one.

Each seek is frame-exact: the app decodes from the last clean keyframe (IDR) to the frame. Playback uses the file's own frame times, so variable frame rate files play at their true speed. When the device is too slow, the preview drops frames and the status bar shows "Preview N fps" in amber.

Keyboard (desktop): Space play/pause; ← / → one frame; Shift+← / → 10 frames; Home / End; I / O set In / Out; M the Mask view.

## Mode 1 — Time Map

A greyscale map gives each pixel a delay. Black = the current frame. White = the Max delay. Each pixel shows the frame t − d of the source at the same position. When that frame is before the start of the video, the pixel is black ("not online"); it comes online when the playhead gets to the frame that it needs.

| Setting | Values | Default |
|---|---|---|
| Max delay (white) | 0 … N − 1 frames (N: the buffer of the status bar) | 30 |
| Delay steps | 0 (smooth), 2 … 64 | 0 |
| Frame blend | On / Off. On: a delay between two frames mixes them (no steps on smooth gradients) | On |
| Map source | Built-in / Image / Video | Built-in: Linear |

**Built-in maps** (each with its own parameters; the grid in the inspector shows a thumbnail of each one): Linear, Mirrored, Radial, Angular, Spiral, Diamond / Box, Four corners, Stripes, Sine waves, Rings, Checkerboard, Value noise (fBm), Ridged noise, Cellular (Worley), Voronoi cells, Random blocks, Random rows / columns, Bayer dither, Video luminance (the luma of the current frame: bright = old), and Motion (the change between frames: moving areas = old). Subject mask and Subject distance need the cutout (a later version).

**Image map** (PNG, JPEG, WebP) and **video map** (MP4, MOV): converted to luma (BT.709). Fit: **Fill** (cover and crop), **Fit** (contain; the empty area has the Outside value), **Stretch**. Transform: position, scale, rotation, flip. A video map is frame-locked: map frame = source frame × Speed + Offset, with **Loop**, **Hold last**, or **Ping-pong** at the end. It is decoded once when you open it (at most 540 px on the short side, 256 MB).

**Map adjust** (all sources, in this order): offset and tile (repeat or mirror) → blur → levels (black and white point) → gamma and contrast → curve (Linear, Ease in, Ease out, S, Step) → posterize → invert.

**Map animation** (built-in maps): Phase speed (the map moves in its direction; ramps repeat), Rotation speed (°/frame), Pulse (scale: amount and period), New seed every k frames.

## Mode 2 — Slit Scan

A 1 px source line repeats in one direction, perpendicular to the line. With **Time On**, each pixel gets older as its distance from the line increases: the trail shows the past of the line. With **Time Off**, the current line repeats (a static smear). Pixels on the other side of the line show the original video.

Drag the line on the preview: the centre point moves it, the round handle turns it (Shift, or the **Snap 15°** button on touch screens: steps of 15°), the arrow flips the scan direction.

| Setting | Values | Default |
|---|---|---|
| Source | Line / Subject edge | Line |
| Line x, y | 0–1 (a point on the line) | 0.5, 0.5 |
| Line angle | 0–360° (90° = vertical) | 90° (the scan goes to the right) |
| Flip direction | On / Off | Off |
| Slit width | 1–16 px (the average across the line) | 1 |
| Time | On / Off | On |
| Rate type | Constant, Accelerate, Decelerate, Exponential, Curve | Constant |
| Rate | 0.05–32 px/frame | 1 |
| Rate at Max age | for the types that are not Constant | 4 |
| Max age | 1 … the history length (frames) | 600 |
| Sampling | Sharp (nearest frame) / Blend (mix 2 frames) | Sharp |

**Subject edge source** (needs the cutout): all the edge pixels of the subject are the source, so the source moves with the subject. Set the **Edge direction** (0° = to the right) with the round handle on the preview. In each row of the direction, the places where the subject ends (up to 4) emit a trail with the colour of the last subject pixel; the trail of one frame joins to the trail of the frame before when their edges are nearer than the **Join limit** (default 8 px). Where trails cross, the youngest pixel wins. Time Off: the edge colour repeats to the end of the row. The Max age of the edge source (default 120 frames, at most 512) is also limited by the GPU time of the trail (target 20 ms at the preview resolution); the inspector shows the limit.

The age at a distance s is A(s), the inverse of S(a) = ∫ rate. When the line changes, an **analysis pass** decodes the full video in the background and fills the slit history (one row for each frame, up to 4096 frames); the status bar shows "Analysis N %". Until it ends, the trail uses the rows that are there (the frames in the frame store at once); the other rows are black. The **Map** view shows the age as heat colours.

## Cutout

The cutout finds the subject without a machine-learning model. It is made for footage from a tripod. **Overlay** puts the subject (the current frame, not changed by the effect) on top of the effect, in Mode 1 and Mode 2. **Scan object** (Mode 2 only): the background is the original video, the effect is the trail of the subject edge (always blended on the original), and the subject is on top. The **Mask** view (or the M key) shows the mask in white. The Subject mask and Subject distance maps of Mode 1 also use it.

Mask pipeline, in this order:

1. **Methods** (each on or off, combined with Union or Intersect):
   - **Background difference** against a **clean plate**: **Auto** (the median of 31 frames over the video; it is made when you first need it), **This frame**, or an **Image** of the empty scene. Threshold, softness, light tolerance (a lower weight for brightness changes), shadow suppression.
   - **Chroma key**: the key colour (**Pick** it on the preview), tolerance, softness, spill suppression (on the subject layer).
   - **Luma key**: low, high, softness, invert.
   - Or a **mask video** (Mask import): a black-and-white video, one frame for each source frame. It replaces the methods.
2. **Garbage matte**: paint **Always subject** / **Never subject** / **Erase** on the preview (brush size, hardness). The matte is the same for the full video.
3. **Clean up**: Open (removes small spots), Close (fills small gaps), Fill holes (enclosed areas smaller than a part of the frame), Keep largest region.
4. **Grow / shrink** (−32 … 32 px), **Temporal smooth** (a mix with the mask of the previous frame) with **Hysteresis**, **Feather**.

**Subject layer** (Overlay): blend mode, opacity, its own grow / shrink and feather, an outline (width and colour).

## Composite and Look

**Effect composite**: **Replace** (default) shows the effect as it is; pixels that are not online are black. **Blend** puts the effect on the original video with a blend mode and an alpha; pixels that are not online are transparent (the original shows).

| Setting | Values | Default |
|---|---|---|
| Blend mode | Normal, Add, Screen, Lighten, Color dodge, Overlay, Soft light, Hard light, Multiply, Darken, Color burn, Subtract, Difference, Exclusion, Divide, Hue, Saturation, Color, Luminosity (W3C formulas) | Normal |
| Opacity | 0–100 % | 100 % |
| Age decay | Full, Linear, Exponential (half-life), Curve | Full |
| Decay length / Half-life | frames (0 = the Max age) | 0 |
| Linear blend | On / Off (blend in linear light) | Off |
| Age tint | Off / a ramp of 2–4 colours from new to old, with an amount | Off |
| Age brightness | the brightness multiplier at the Max age, 0–2 | 1 |
| Spatial offset (Mode 1 only) | 0–64 px and an angle: each delayed pixel also moves by map value × offset | 0 |

The age of a pixel is its delay in frames (Mode 1) or A(s) (Mode 2). Blend mode, opacity, and decay apply with Blend; tint and brightness apply in both.

The view switch above the preview shows **Result**, **Original** (the source frame), or **Map** (the map in grey). Double-click a setting label to reset it.

## Browser support

Main targets: desktop Chrome and Chrome on Android. Other browsers with WebCodecs and WebGL2 must also work. At start, the app checks WebGL2, float render targets, `VideoDecoder`, `VideoEncoder`, and `OffscreenCanvas` with WebGL2 (plan §4). Without `OffscreenCanvas` WebGL2 in a worker, the GPU work runs on the main thread (open the page with `?gpu=main` to test this).

Input: MP4 and MOV only (not fragmented). Output: MP4, H.264.

## Known limits

- Fragmented MP4 files are not supported.
- Audio pass-through supports AAC (`mp4a`) and Opus.
- Open-GOP files (keyframes that are not IDR) seek more slowly: Chrome's decoder must start at an IDR frame.
- The slit history holds at most 4096 frames (and the GPU texture size limit). In a longer video, a seek far back shows black trails until the frames play again.
- The Subject edge source needs float render targets (EXT_color_buffer_float), which current Chrome has.
- The cutout is made for a camera that does not move. Temporal smooth and hysteresis use the mask of the previous frame: they apply in playback (and export), not to a single seek.
- Grow / shrink and the outline use a square kernel: corners grow a little more than round edges.
- A clean plate from This frame or an Image is not kept when the preview resolution changes (make it again); Auto is made again.
- A video map keeps at most 256 MB of frames; a longer map video holds its last frame that fits.
- Without float render targets, the map has 8-bit precision: with a long Max delay, the delays have steps of Max delay / 255 frames.
- The frame store keeps 8-bit YUV 4:2:0 (BT.709, full range): a small colour change is possible on fine colour edges.
- The edit list start is used; an edit list with more than one segment is read as one segment.

## Development

Requires Node.js 20 or later. The tests also use FFmpeg/ffprobe (with libx264) and Playwright with Chromium; the tests that need them are skipped when they are not installed.

```bash
node tools/build.mjs
```

```bash
node tests/run.mjs
```

```bash
node tests/run.mjs playback
```

```bash
node tools/make-fixtures.mjs
```

The last command writes the test videos (plan §13.1) to `samples/`. The tests make their own copy in `tests/out/fixtures/`. The frame-number video shows its frame number + 1 as a 16-bit block code (0 = black); `readCode` in `tools/make-fixtures.mjs` reads it back.

`tools/build.mjs` inlines all sources into `dist/neofx-v<version>.html` and copies it to `index.html`. Template markers: `<!--@css:path-->`, `<!--@js:path-->`, `<!--@modules:a,b-->`, `"@WORKER:a,b"`, `"@GLSL:path"`, `@VERSION@`.

| Folder | Content |
|---|---|
| `src/app/` | the page, styles, platform checks, `settings.js`, `player.js` (seek, playback clock, store mirror), `gpu-client.js`, `analysis.js` (Mode 2 analysis pass), `preview.js`, `ui/` (timeline, inspector, widgets, line handles, eyedropper and matte brush) |
| `src/gpu/` | `engine.js` (WebGL2: frame store, upload, Time Map render, compositor), `blend.js` (blend modes), `slit.js` (slit history, analysis rows, Mode 2 render), `mask.js` (cutout mask pipeline, clean plate, matte, subject layer), `edge.js` (subject-edge emitters and trail), `mapgen.js` (map: generate, blur, adjust, thumbnails), `gl.js`, `store.js` (sizes, budget), `gpu-worker.js`, `glsl/` |
| `src/analysis/` | `cleanplate.js` (median), `regions.js` (fill holes, keep largest), `analysis-worker.js` |
| `src/modes/` | `slit.js` (Mode 2: rate types, S and A, line geometry) |
| `src/maps/` | `builtin.js` (the map list and parameters), `curve.js` (monotone curves), `mapsource.js` (image and video maps) |
| `src/io/` | `demux.js` (MP4/MOV reader), `mp4.js` (MP4 muxer), `timeline.js` (frame order, seek plan), `decode-worker.js` |
| `tools/` | `build.mjs`, `make-fixtures.mjs` |
| `tests/` | Node tests, FFmpeg checks, Playwright tests |

The MP4 reader, the muxer, the build tool, and the test runner come from [neomosh](https://github.com/neospacial/neomosh).
