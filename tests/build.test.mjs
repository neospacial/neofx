// Phase 1: the build makes one standalone page (R-1, R-6).

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { buildPage, bundle, PAGES, VERSION } from '../tools/build.mjs';
import { assert, OUT_DIR } from './lib/util.mjs';

export const tests = [
  {
    name: 'version 0.1.0 and the output file name have the version (R-6)',
    fn() {
      assert(VERSION === '0.1.0', `version ${VERSION}`);
      assert(PAGES[0][1] === `neofx-v${VERSION}.html`, PAGES[0][1]);
    },
  },
  {
    name: 'index.html (GitHub Pages) and dist are the same as a new build',
    fn() {
      const html = buildPage(PAGES[0][0]);
      const root = new URL('..', import.meta.url);
      for (const f of ['index.html', `dist/${PAGES[0][1]}`]) {
        assert(fs.readFileSync(new URL(f, root), 'utf8') === html, `${f} is not the current build: run node tools/build.mjs`);
      }
    },
  },
  {
    name: 'the page builds, with no external URLs and no network APIs (R-1)',
    fn() {
      for (const [tpl] of PAGES) {
        const html = buildPage(tpl);
        assert(!/@(VERSION|WORKER|GLSL|css|js|modules)/.test(html.replace(/@media/g, '')), `${tpl}: marker left`);
        assert(!/https?:\/\//i.test(html), `${tpl}: contains a URL`);
        assert(!/\b(fetch|XMLHttpRequest|importScripts|WebSocket|EventSource)\s*\(/.test(html), `${tpl}: network API`);
        assert(!/<(script|link|img)[^>]+(src|href)=/i.test(html), `${tpl}: external resource`);
        for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1], { filename: tpl });
      }
    },
  },
  {
    name: 'markers: @GLSL in modules and pages, @WORKER, @js, @css',
    fn() {
      const src = path.join(OUT_DIR, 'build_src');
      fs.mkdirSync(path.join(src, 'gpu/glsl'), { recursive: true });
      fs.mkdirSync(path.join(src, 'p'), { recursive: true });
      const frag = '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0, 0.5, 0.0, 1.0); } // "quote" </script>\n';
      fs.writeFileSync(path.join(src, 'gpu/glsl/t.frag'), frag);
      fs.writeFileSync(path.join(src, 'gpu/a.js'), "export const FRAG = \"@GLSL:gpu/glsl/t.frag\";\nexport function twice(x) { return 2 * x; }\n");
      fs.writeFileSync(path.join(src, 'gpu/b.js'), "import { twice, FRAG } from './a.js';\nexport const out = [twice(21), FRAG];\n");
      fs.writeFileSync(path.join(src, 'p/s.css'), 'body{color:red}');
      fs.writeFileSync(path.join(src, 'p/c.js'), "var SHADER = '@GLSL:gpu/glsl/t.frag';");
      fs.writeFileSync(path.join(src, 'p/page.html'), '<!--@css:s.css--><!--@js:c.js--><!--@modules:gpu/a.js,gpu/b.js--><script>var W = "@WORKER:gpu/a.js,gpu/b.js";</script>@VERSION@');
      const ctx = {};
      vm.runInNewContext(bundle(['gpu/a.js', 'gpu/b.js'], src) + '\nresult = out;', ctx);
      assert(ctx.result[0] === 42 && ctx.result[1] === frag, 'bundle with GLSL');
      const html = buildPage('p/page.html', src);
      assert(html.includes('<style>\nbody{color:red}</style>') && html.endsWith(VERSION), 'css or version');
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      assert(scripts.length === 3, `${scripts.length} scripts`);
      const c2 = {};
      vm.runInNewContext(scripts.join('\n;\n') + '\nr = [SHADER, W, out];', c2);
      assert(c2.r[0] === frag && c2.r[2][1] === frag, 'GLSL in classic script and modules');
      const c3 = {};
      vm.runInNewContext(c2.r[1] + '\nr = out[0];', c3);
      assert(c3.r === 42, 'worker source runs');
    },
  },
];
