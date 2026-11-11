# neofx

neofx is a video effect app in one standalone HTML file. It makes time distortion effects:

- **Time Map** — a greyscale map gives each pixel a delay in frames. Black = the current frame, white = the maximum delay.
- **Slit Scan** — a 1 px source line (or the edge of the subject) repeats in one direction. Pixels get older as their distance from the line increases.

The app uses only browser APIs (WebCodecs, WebGL2, Workers). It has no libraries and makes no network requests, so it works offline and from GitHub Pages. The export is an MP4 (H.264) file with the original audio copied.

> Status: v0.1.0, **phase 1 of 12** (see `neofx-plan-v0.1.0.md` §14). Done: the build, the MP4/MOV reader (video and audio tracks), the MP4 muxer (video + audio pass-through), the test harness, and an empty app shell with the platform checks. The effects, the preview, and the export come in the next phases.

## How to use

Open `dist/neofx-v0.1.0.html` (or `index.html` on GitHub Pages) in desktop Chrome or Chrome on Android. At this phase, the app shows the start screen and checks the browser. Video loading comes in phase 2.

## Browser support

Main targets: desktop Chrome and Chrome on Android. Other browsers with WebCodecs and WebGL2 must also work. At start, the app checks WebGL2, float render targets, `VideoDecoder`, `VideoEncoder`, and `OffscreenCanvas` with WebGL2 (plan §4).

Input: MP4 and MOV only (not fragmented). Output: MP4, H.264.

## Known limits

- Fragmented MP4 files are not supported.
- Audio pass-through supports AAC (`mp4a`) and Opus.

## Development

Requires Node.js 20 or later. The tests also use FFmpeg/ffprobe (with libx264) and Playwright with Chromium; the tests that need them are skipped when they are not installed.

```bash
node tools/build.mjs
```

```bash
node tests/run.mjs
```

```bash
node tests/run.mjs mp4
```

`tools/build.mjs` inlines all sources into `dist/neofx-v<version>.html` and copies it to `index.html`. Template markers: `<!--@css:path-->`, `<!--@js:path-->`, `<!--@modules:a,b-->`, `"@WORKER:a,b"`, `"@GLSL:path"`, `@VERSION@`.

| Folder | Content |
|---|---|
| `src/app/` | the page, styles, app shell, platform checks |
| `src/io/` | `demux.js` (MP4/MOV reader), `mp4.js` (MP4 muxer) |
| `tools/` | `build.mjs` |
| `tests/` | Node tests, FFmpeg checks, Playwright tests |

The MP4 reader, the muxer, the build tool, and the test runner come from [neomosh](https://github.com/neospacial/neomosh).
