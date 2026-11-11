# neofx

neofx is a video effect app in one standalone HTML file. It makes time distortion effects:

- **Time Map** — a greyscale map gives each pixel a delay in frames. Black = the current frame, white = the maximum delay.
- **Slit Scan** — a 1 px source line (or the edge of the subject) repeats in one direction. Pixels get older as their distance from the line increases.

The app uses only browser APIs (WebCodecs, WebGL2, Workers). It has no libraries and makes no network requests, so it works offline and from GitHub Pages. The export is an MP4 (H.264) file with the original audio copied.

> Status: v0.1.0, **phase 3 of 12** (see `neofx-plan-v0.1.0.md` §14). Done: the build, the MP4/MOV reader and muxer (video + audio pass-through), the decode worker with frame-exact seek, the transport and the timeline, the GPU worker and the frame store. The effects (Time Map, Slit Scan), the cutout, and the export come in the next phases.

## How to use

1. Open `dist/neofx-v0.1.0.html` (or `index.html` on GitHub Pages) in desktop Chrome or Chrome on Android.
2. Drop an MP4 or MOV file on the page, or touch **Open**.
3. The preview shows the video (turned as the file says). Use the transport to play and to move frame by frame. Drag on the timeline strip to scrub. **In** and **Out** set a range at the current frame (touch again to clear). **Loop** plays the range again and again.
4. **Preview** sets the working resolution of the preview (short side: 360, 540, 720, 1080, or Source). The preview is never larger than the source.

The status bar shows the frame store: for example "Buffer: 240 frames at 540p (≈ 330 MB)". The store is a ring of past frames on the GPU (YUV 4:2:0, 1.5 bytes for each pixel). Its size is the smallest of: the GPU limit of texture layers, the memory budget divided by the size of one frame, and 1000 frames. The budget starts at 1 GB on desktop and 384 MB on Android, and halves when the GPU cannot allocate it. The Max delay of the Time Map effect (phase 4) cannot be more than this number of frames minus one.

Each seek is frame-exact: the app decodes from the last clean keyframe (IDR) to the frame. Playback uses the file's own frame times, so variable frame rate files play at their true speed. When the device is too slow, the preview drops frames and the status bar shows "Preview N fps" in amber.

Keyboard (desktop): Space play/pause; ← / → one frame; Shift+← / → 10 frames; Home / End; I / O set In / Out.

## Browser support

Main targets: desktop Chrome and Chrome on Android. Other browsers with WebCodecs and WebGL2 must also work. At start, the app checks WebGL2, float render targets, `VideoDecoder`, `VideoEncoder`, and `OffscreenCanvas` with WebGL2 (plan §4). Without `OffscreenCanvas` WebGL2 in a worker, the GPU work runs on the main thread (open the page with `?gpu=main` to test this).

Input: MP4 and MOV only (not fragmented). Output: MP4, H.264.

## Known limits

- Fragmented MP4 files are not supported.
- Audio pass-through supports AAC (`mp4a`) and Opus.
- Open-GOP files (keyframes that are not IDR) seek more slowly: Chrome's decoder must start at an IDR frame.
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

The last command writes the test videos (plan §13.1) to `samples/`. The tests make their own copy in `tests/out/fixtures/`. The frame-number video shows its frame number as a 16-bit block code; `readCode` in `tools/make-fixtures.mjs` reads it back.

`tools/build.mjs` inlines all sources into `dist/neofx-v<version>.html` and copies it to `index.html`. Template markers: `<!--@css:path-->`, `<!--@js:path-->`, `<!--@modules:a,b-->`, `"@WORKER:a,b"`, `"@GLSL:path"`, `@VERSION@`.

| Folder | Content |
|---|---|
| `src/app/` | the page, styles, platform checks, `player.js` (seek, playback clock, store mirror), `gpu-client.js`, `preview.js`, `ui/timeline.js` |
| `src/gpu/` | `engine.js` (WebGL2: frame store, upload, preview render), `gl.js`, `store.js` (sizes, budget), `gpu-worker.js`, `glsl/` |
| `src/io/` | `demux.js` (MP4/MOV reader), `mp4.js` (MP4 muxer), `timeline.js` (frame order, seek plan), `decode-worker.js` |
| `tools/` | `build.mjs`, `make-fixtures.mjs` |
| `tests/` | Node tests, FFmpeg checks, Playwright tests |

The MP4 reader, the muxer, the build tool, and the test runner come from [neomosh](https://github.com/neospacial/neomosh).
