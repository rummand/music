#!/usr/bin/env node
// Render fixtures/*.abc to songbook-style PNGs (clean) and phone-photo-like JPEGs.
//
// Usage:
//   node test/render-fixtures.mjs [path/to/abcjs-basic-min.js | path/to/node_modules]
//
// Needs: playwright (Chromium), abcjs@6.x, sharp.
// abcjs/sharp are resolved from (in order): the CLI argument, ./node_modules,
// /tmp/claude-0/fixtures-build/node_modules. Set up a scratch dir with:
//   mkdir -p /tmp/claude-0/fixtures-build && cd $_ && npm i abcjs@6.4.4 sharp
//
// Output (in fixtures/):
//   <name>.png        clean render, ~1400 px wide, black on off-white
//   <name>.photo.jpg  rotated / skewed / unevenly lit, JPEG q70

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures');
const SCRATCH = '/tmp/claude-0/fixtures-build';

function findFile(candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

const arg = process.argv[2];
let abcjsFile = null;
const moduleDirs = [];
if (arg) {
  if (arg.endsWith('.js')) abcjsFile = path.resolve(arg);
  else moduleDirs.push(path.resolve(arg));
}
moduleDirs.push(path.join(ROOT, 'node_modules'), path.join(SCRATCH, 'node_modules'));
abcjsFile ||= findFile(moduleDirs.map((d) => path.join(d, 'abcjs/dist/abcjs-basic-min.js')));
if (!abcjsFile) {
  console.error('abcjs not found; pass a path or install abcjs into', SCRATCH);
  process.exit(1);
}

function load(name) {
  const tries = [import.meta.url, ...moduleDirs.map((d) => path.join(d, '..', 'package.json'))];
  for (const t of tries) {
    try { return createRequire(t)(name); } catch {}
  }
  throw new Error(`cannot load ${name}`);
}
const { chromium } = load('playwright');
const sharp = load('sharp');

const abcjsSrc = fs.readFileSync(abcjsFile, 'utf8');
const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.abc')).sort();

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#f7f3e8}
  #page{width:1400px;padding:40px 0 50px;background:#f7f3e8}
  #page svg{display:block;margin:0 auto}
  #page svg path, #page svg text { fill:#111 }
</style></head><body><div id="page"><div id="paper"></div></div>
<script>${abcjsSrc}</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
await page.setContent(html);

for (const f of files) {
  const name = f.replace(/\.abc$/, '');
  const abc = fs.readFileSync(path.join(FIX, f), 'utf8');
  await page.evaluate((abc) => {
    const el = document.getElementById('paper');
    el.innerHTML = '';
    window.ABCJS.renderAbc(el, abc, {
      staffwidth: 1200,
      scale: 1.0,
      paddingleft: 0,
      paddingright: 0,
      add_classes: false,
      format: {
        titlefont: '"Times New Roman" 30 bold',
        composerfont: '"Times New Roman" 15 italic',
        vocalfont: '"Times New Roman" 17',
        gchordfont: '"Helvetica" 15',
      },
    });
  }, abc);
  const pngPath = path.join(FIX, `${name}.png`);
  const buf = await page.locator('#page').screenshot();
  // Flatten to greyscale-ish palette PNG to keep the files small.
  await sharp(buf).png({ palette: true, colors: 32, compressionLevel: 9 }).toFile(pngPath);

  await photoVariant(buf, path.join(FIX, `${name}.photo.jpg`), name);
  console.log('rendered', name);
}
await browser.close();

// Deterministic pseudo-random per file so re-runs produce identical output.
function rng(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function photoVariant(buf, out, seed) {
  const r = rng(seed);
  const angle = (2 + r() * 2) * (r() < 0.5 ? -1 : 1); // 2..4 degrees
  const skewX = (r() - 0.5) * 0.08; // mild shear ("perspective-ish")
  const skewY = (r() - 0.5) * 0.04;
  const paper = { r: 236, g: 228, b: 210 };

  // 1. shear, then rotate, on a paper-coloured background.
  const sheared = await sharp(buf)
    .affine([[1, skewX], [skewY, 0.97]], { background: paper, interpolator: 'bicubic' })
    .png().toBuffer();
  const rotated = await sharp(sheared).rotate(angle, { background: { r: 70, g: 62, b: 55 } }).png().toBuffer();
  const meta = await sharp(rotated).metadata();
  const W = meta.width, H = meta.height;

  // 2. uneven lighting: dark corner gradient + a soft diagonal shadow band (multiply).
  const cx = Math.round(W * (0.2 + r() * 0.6)), cy = Math.round(H * (0.2 + r() * 0.6));
  const shadowX = Math.round(W * (0.55 + r() * 0.3));
  const light = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="g" cx="${cx}" cy="${cy}" r="${Math.max(W, H) * 0.8}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fffaf0"/><stop offset="0.6" stop-color="#d9d0bf"/><stop offset="1" stop-color="#8a8070"/>
      </radialGradient>
      <linearGradient id="s" x1="0" y1="0" x2="1" y2="0.3">
        <stop offset="0" stop-color="#fff"/><stop offset="0.5" stop-color="#fff"/>
        <stop offset="0.75" stop-color="#9c9488"/><stop offset="1" stop-color="#b8b0a2"/>
      </linearGradient>
      <filter id="b"><feGaussianBlur stdDeviation="40"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <polygon points="${shadowX},0 ${W},0 ${W},${H} ${shadowX - W * 0.25},${H}" fill="#8f877a" opacity="0.55" filter="url(#b)"/>
  </svg>`);

  // 3. warm tint + slight blur + noise-ish via JPEG quality.
  const lit = await sharp(rotated)
    .composite([{ input: light, blend: 'multiply' }])
    .modulate({ brightness: 1.05, saturation: 0.9 })
    .tint({ r: 255, g: 244, b: 225 })
    .blur(0.6)
    .png().toBuffer();
  // (resize in a separate pass: sharp applies composite after resize otherwise)
  await sharp(lit)
    .resize({ width: 1400 })
    .jpeg({ quality: 70, mozjpeg: true })
    .toFile(out);
}
