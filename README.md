# neofx

neofx is a video effect app in one standalone HTML file. It makes time distortion effects:

- **Time Map** — a greyscale map gives each pixel a delay in frames. Black = the current frame, white = the maximum delay.
- **Slit Scan** — a 1 px source line (or the edge of the subject) repeats in one direction. Pixels get older as their distance from the line increases.

The app uses only browser APIs (WebCodecs, WebGL2, Workers). It has no libraries and makes no network requests, so it works offline and from GitHub Pages. The export is an MP4 (H.264) file with the original audio copied.

> Status: v0.1.0, **phase 2 of 12** (see `neofx-plan-v0.1.0.md` §14). Done: the build, the MP4/MOV reader and muxer (video + audio pass-through), the decode worker with frame-exact seek, the Original preview, the transport and the timeline. The effects (Time Map, Slit Scan), the cutout, and the export come in the next phases.

## How to use

1. Open `dist/neofx-v0.1.0.html` (or `index.html` on GitHub Pages) in desktop Chrome or Chrome on Android.
2. Drop an MP4 or MOV file on the page, or touch **Open**.
3. The preview shows the video (turned as the file says). Use the transport to play and to move frame by frame. Drag on the timeline strip to scrub. **In** and **Out** set a range at the current frame (touch again to clear). **Loop** plays the range again and again.
4. **Preview** sets the working resolution of the preview (short side: 360, 540, 720, 1080, or Source). The preview is never larger than the source.

Each seek is frame-exact: the app decodes from the last clean keyframe (IDR) to the frame. Playback uses the file's own frame times, so variable frame rate files play at their true speed. When the device is too slow, the preview drops frames and the status bar shows "Preview N fps" in amber.

Keyboard (desktop): Space play/pause; ← / → one frame; Shift+← / → 10 frames; Home / End; I / O set In / Out.

## Browser support

Main targets: desktop Chrome and Chrome on Android. Other browsers with WebCodecs and WebGL2 must also work. At start, the app checks WebGL2, float render targets, `VideoDecoder`, `VideoEncoder`, and `OffscreenCanvas` with WebGL2 (plan §4).

Input: MP4 and MOV only (not fragmented). Output: MP4, H.264.

## Known limits

- Fragmented MP4 files are not supported.
- Audio pass-through supports AAC (`mp4a`) and Opus.
- Open-GOP files (keyframes that are not IDR) seek more slowly: Chrome's decoder must start at an IDR frame.
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
| `src/app/` | the page, styles, platform checks, `player.js` (seek, playback clock), `preview.js`, `ui/timeline.js` |
| `src/io/` | `demux.js` (MP4/MOV reader), `mp4.js` (MP4 muxer), `timeline.js` (frame order, seek plan), `decode-worker.js` |
| `tools/` | `build.mjs`, `make-fixtures.mjs` |
| `tests/` | Node tests, FFmpeg checks, Playwright tests |

The MP4 reader, the muxer, the build tool, and the test runner come from [neomosh](https://github.com/neospacial/neomosh).
