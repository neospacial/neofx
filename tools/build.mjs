// Build: inline all sources into one standalone HTML file (plan R-1, R-6). From neomosh tools/build.mjs.
//   dist/neofx-v<version>.html   the app
//   index.html                   a copy of the app, for GitHub Pages (the repository root)
// Usage: node tools/build.mjs
//
// HTML templates use these markers:
//   <!--@css:path-->      inline a stylesheet (path from the template)
//   <!--@js:path-->       inline a classic script (path from the template)
//   <!--@modules:a,b-->   inline ES modules (paths from src/), bundled into one classic script
//   "@WORKER:a.js,b.js"   a JSON string with the bundled modules (for a Blob URL worker)
//   "@GLSL:path"          a JSON string with a shader file (path from src/). Also in modules.
//   @VERSION@             the version from package.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
export const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const IMPORT_RE = /^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;
const EXPORT_RE = /^export\s+((?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+))/gm;
const GLSL_RE = /(["'])@GLSL:([^"']+)\1/g;

// "@GLSL:path" -> the shader source as a JS string literal.
export function inlineGlsl(code, src = SRC) {
  return code.replace(GLSL_RE, (m, q, f) => JSON.stringify(fs.readFileSync(path.join(src, f.trim()), 'utf8')));
}

// Bundle ES modules into one classic script. Each module runs in its own function scope.
// Its exports become top-level constants, which the next modules use in place of their imports.
// The modules must be in dependency order.
export function bundle(files, src = SRC) {
  const parts = [];
  for (const f of files) {
    let code = inlineGlsl(fs.readFileSync(path.join(src, f), 'utf8'), src);
    // One name for each export: "export const a = 1, b = 2;" would export only a.
    const multi = code.match(/^export\s+(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=[^;\n]*,\s*[A-Za-z0-9_$]+\s*=.*$/m);
    if (multi && !/[([{]/.test(multi[0].split('=')[1].split(',')[0])) throw new Error(`${f}: one export for each declaration: ${multi[0]}`);
    code = code.replace(IMPORT_RE, '');
    const names = [];
    code = code.replace(EXPORT_RE, (m, decl, name) => {
      names.push(name);
      return decl;
    });
    if (/^export\s/m.test(code)) throw new Error(`${f}: unsupported export form`);
    parts.push(`// ---- ${f}\nconst { ${names.join(', ')} } = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();\n`);
  }
  return parts.join('\n');
}

const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
const moduleList = (list) => list.split(',').map((s) => s.trim()).filter(Boolean);

export function buildPage(template, src = SRC) {
  const dir = path.join(src, path.dirname(template));
  let html = fs.readFileSync(path.join(src, template), 'utf8');
  html = html.replace(/<!--@css:([^>]+?)-->/g, (m, f) => `<style>\n${fs.readFileSync(path.join(dir, f), 'utf8')}</style>`);
  html = html.replace(/<!--@js:([^>]+?)-->/g, (m, f) => `<script>\n${safeScript(inlineGlsl(fs.readFileSync(path.join(dir, f), 'utf8'), src))}</script>`);
  html = html.replace(/<!--@modules:([^>]+?)-->/g, (m, list) => `<script>\n'use strict';\n${safeScript(bundle(moduleList(list), src))}</script>`);
  html = html.replace(/"@WORKER:([^"]+)"/g, (m, list) => safeScript(JSON.stringify(bundle(moduleList(list), src))));
  html = inlineGlsl(html, src);
  return html.replace(/@VERSION@/g, VERSION);
}

export const PAGES = [
  ['app/index.html', `neofx-v${VERSION}.html`],
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  for (const [tpl, out] of PAGES) {
    const html = buildPage(tpl);
    fs.writeFileSync(path.join(dist, out), html);
    console.log(`dist/${out} (${(html.length / 1024).toFixed(0)} KB)`);
    if (tpl === PAGES[0][0]) {
      fs.writeFileSync(path.join(root, 'index.html'), html);
      console.log('index.html (the same as the app)');
    }
  }
}
