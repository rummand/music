#!/usr/bin/env node
// OMR quality evaluation: send every fixture image to POST /api/read and score
// the returned ABC against the ground-truth fixtures/<name>.abc.
//
// Usage:
//   node test/omr-eval.mjs [baseUrl] [--only substr] [--variant png|photo] [--out file]
//   baseUrl defaults to http://localhost:3000 (or $NODER_URL)
//
// Scores (0-100):
//   key      key signature matches (same set of sharps/flats; mode ignored)
//   meter    M: matches (C == 4/4, C| == 2/2)
//   pitch    1 - editDistance/maxLen over the sequence of sounding pitches (MIDI)
//   pitch+dur  same over (pitch, duration) pairs
//   interval same over successive pitch intervals (forgives a wrong key/octave)
//   lyrics   F1 word overlap of the w: lyrics (syllables joined, case/punct-insensitive)
// Repeats are compared as written (not unfolded); ties are not merged.
// Writes test/omr-eval-results.json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(ROOT, 'fixtures');

function loadAbcjs() {
  const bases = [
    path.join(ROOT, 'package.json'),
    '/tmp/claude-0/fixtures-build/package.json',
    import.meta.url,
  ];
  for (const b of bases) {
    try {
      return createRequire(b)('abcjs');
    } catch {}
  }
  return null;
}
const ABCJS = loadAbcjs();

// ---------------------------------------------------------------------------
// Parsing

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const ACC = { sharp: 1, flat: -1, natural: 0, dblsharp: 2, dblflat: -2, quartersharp: 0.5, quarterflat: -0.5 };

/** Parse ABC into {key, meter, notes:[{midi, dur}], lyrics:[words]} using abcjs. */
export function analyse(abc) {
  const out = { key: null, keyAcc: null, meter: null, notes: [], lyrics: lyricWords(abc), parseError: null };
  if (!abc || typeof abc !== 'string') {
    out.parseError = 'empty';
    return out;
  }
  if (!ABCJS) {
    out.parseError = 'abcjs not available';
    return out;
  }
  let tune;
  try {
    tune = ABCJS.parseOnly(abc)[0];
  } catch (e) {
    out.parseError = String(e.message || e);
    return out;
  }
  if (!tune || !tune.lines) {
    out.parseError = 'no tune';
    return out;
  }
  try {
    const ks = tune.getKeySignature();
    out.key = `${ks.root}${ks.acc || ''}${ks.mode || ''}`;
  } catch {}
  try {
    const mf = tune.getMeterFraction();
    if (mf && mf.num) out.meter = `${mf.num}/${mf.den}`;
  } catch {}

  // Walk the first voice of the first staff.
  let keyAcc = {}; // letter -> semitone offset from the key signature
  let barAcc = {}; // "letter+octave" -> offset from accidentals within the bar
  for (const line of tune.lines) {
    if (!line.staff) continue;
    const staff = line.staff[0];
    if (!staff) continue;
    if (staff.key) keyAcc = keyMap(staff.key);
    if (out.keyAcc == null && staff.key) out.keyAcc = keySig(staff.key);
    const voice = staff.voices && staff.voices[0];
    if (!voice) continue;
    for (const el of voice) {
      if (el.el_type === 'bar') {
        barAcc = {};
        continue;
      }
      if (el.el_type === 'key') {
        keyAcc = keyMap(el);
        continue;
      }
      if (el.el_type !== 'note' || el.rest || !el.pitches || !el.pitches.length) {
        if (el.el_type === 'note' && el.rest && el.rest.type !== 'spacer') {
          out.notes.push({ midi: null, dur: round(el.duration) });
        }
        continue;
      }
      // Melody = top note of a chord.
      const p = el.pitches.reduce((a, b) => (b.pitch > a.pitch ? b : a));
      const step = ((p.pitch % 7) + 7) % 7;
      const octave = Math.floor(p.pitch / 7);
      const letter = 'CDEFGAB'[step];
      const id = `${letter}${octave}`;
      if (p.accidental && p.accidental in ACC) barAcc[id] = ACC[p.accidental];
      const acc = id in barAcc ? barAcc[id] : keyAcc[letter] || 0;
      out.notes.push({ midi: 60 + octave * 12 + LETTER_PC[step] + acc, dur: round(el.duration) });
    }
  }
  return out;
}

const round = (x) => Math.round((x || 0) * 10000) / 10000;

function keyMap(key) {
  const m = {};
  for (const a of key.accidentals || []) m[a.note.toUpperCase()] = ACC[a.acc] || 0;
  return m;
}
function keySig(key) {
  return (key.accidentals || [])
    .map((a) => `${a.acc === 'sharp' ? '^' : a.acc === 'flat' ? '_' : '='}${a.note.toUpperCase()}`)
    .sort()
    .join('');
}

/** Words of all w: lines, syllables joined, lowercased, punctuation stripped. */
export function lyricWords(abc) {
  if (typeof abc !== 'string') return [];
  const text = abc
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => /^w:/.test(l))
    .map((l) => l.slice(2).trim())
    .join(' ');
  return text
    .replace(/\\-/g, '-')
    .replace(/[_*|~]/g, ' ')
    .replace(/-\s*/g, '') // join syllables (also across w: lines)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}']/gu, '').replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Scoring

export function editDistance(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (eq(a[i - 1], b[j - 1]) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[m];
}

export function similarity(a, b, eq) {
  const max = Math.max(a.length, b.length);
  if (!max) return 100;
  return Math.round((1 - editDistance(a, b, eq) / max) * 1000) / 10;
}

function f1(truth, got) {
  if (!truth.length && !got.length) return 100;
  if (!truth.length || !got.length) return 0;
  const count = new Map();
  for (const w of truth) count.set(w, (count.get(w) || 0) + 1);
  let hit = 0;
  for (const w of got) {
    const c = count.get(w) || 0;
    if (c > 0) {
      hit++;
      count.set(w, c - 1);
    }
  }
  const p = hit / got.length;
  const r = hit / truth.length;
  return p + r ? Math.round(((2 * p * r) / (p + r)) * 1000) / 10 : 0;
}

/** Compare two ABC strings; returns scores 0-100 (key/meter are 0 or 100). */
export function score(truthAbc, gotAbc) {
  const t = analyse(truthAbc);
  const g = analyse(gotAbc);
  const tp = t.notes.filter((n) => n.midi != null);
  const gp = g.notes.filter((n) => n.midi != null);
  const intervals = (ns) => ns.slice(1).map((n, i) => n.midi - ns[i].midi);
  return {
    key: t.keyAcc != null && t.keyAcc === g.keyAcc ? 100 : 0,
    meter: t.meter && t.meter === g.meter ? 100 : 0,
    pitch: similarity(tp.map((n) => n.midi), gp.map((n) => n.midi)),
    pitchDur: similarity(t.notes, g.notes, (x, y) => x.midi === y.midi && Math.abs(x.dur - y.dur) < 1e-3),
    interval: similarity(intervals(tp), intervals(gp)),
    lyrics: f1(t.lyrics, g.lyrics),
    detail: {
      truthKey: t.key,
      gotKey: g.key,
      truthMeter: t.meter,
      gotMeter: g.meter,
      truthNotes: t.notes.length,
      gotNotes: g.notes.length,
      parseError: g.parseError,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const o = { url: process.env.NODER_URL || 'http://localhost:3000', only: null, variant: null, out: path.join(HERE, 'omr-eval-results.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = argv[++i];
    else if (a === '--variant') o.variant = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (/^https?:\/\//.test(a)) o.url = a.replace(/\/+$/, '');
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function readImage(url, file) {
  const buf = fs.readFileSync(file);
  const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type }), path.basename(file));
  const t0 = Date.now();
  const res = await fetch(`${url}/api/read`, { method: 'POST', body: fd });
  const ms = Date.now() - t0;
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: `non-JSON response (HTTP ${res.status})` };
  }
  return { status: res.status, ms, body };
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!ABCJS) console.warn('warning: abcjs not found, note scores will be 0 (npm install in the project root)');
  let cfg = null;
  try {
    cfg = await (await fetch(`${opt.url}/api/config`)).json();
  } catch (e) {
    console.error(`cannot reach ${opt.url}: ${e.message}`);
    process.exit(2);
  }

  const names = fs
    .readdirSync(FIX)
    .filter((f) => f.endsWith('.abc'))
    .map((f) => f.slice(0, -4))
    .filter((n) => !opt.only || n.includes(opt.only))
    .sort();

  const rows = [];
  for (const name of names) {
    const truth = fs.readFileSync(path.join(FIX, `${name}.abc`), 'utf8');
    const variants = [
      ['png', `${name}.png`],
      ['photo', `${name}.photo.jpg`],
    ].filter(([v, f]) => (!opt.variant || opt.variant === v) && fs.existsSync(path.join(FIX, f)));
    for (const [variant, file] of variants) {
      process.stderr.write(`reading ${file} ... `);
      const r = await readImage(opt.url, path.join(FIX, file));
      const abc = r.body && typeof r.body.abc === 'string' ? r.body.abc : null;
      const s = abc ? score(truth, abc) : null;
      process.stderr.write(`${r.status} ${r.ms} ms\n`);
      rows.push({
        fixture: name,
        variant,
        file,
        status: r.status,
        ms: r.ms,
        error: r.body && r.body.error ? r.body.error : null,
        title: r.body && r.body.title ? r.body.title : null,
        warnings: (r.body && r.body.warnings) || [],
        scores: s,
        abc,
      });
    }
  }

  // Table
  const cols = ['fixture', 'var', 'http', 'key', 'meter', 'pitch%', 'p+dur%', 'interv%', 'lyrics%', 'secs', 'warn'];
  const w = [22, 6, 5, 6, 6, 7, 7, 8, 8, 6, 5];
  console.log(cols.map((c, i) => (i < 2 ? pad(c, w[i]) : lpad(c, w[i]))).join(' '));
  console.log(w.map((n) => '-'.repeat(n)).join(' '));
  for (const r of rows) {
    const s = r.scores;
    const cells = [
      r.fixture.slice(0, 22),
      r.variant,
      r.status,
      s ? (s.key ? 'ok' : 'FAIL') : '-',
      s ? (s.meter ? 'ok' : 'FAIL') : '-',
      s ? s.pitch.toFixed(1) : '-',
      s ? s.pitchDur.toFixed(1) : '-',
      s ? s.interval.toFixed(1) : '-',
      s ? s.lyrics.toFixed(1) : '-',
      (r.ms / 1000).toFixed(1),
      r.warnings.length,
    ];
    console.log(cells.map((c, i) => (i < 2 ? pad(c, w[i]) : lpad(c, w[i]))).join(' '));
    if (r.error) console.log(`   error: ${r.error}`);
  }
  const scored = rows.filter((r) => r.scores);
  const avg = (k) => (scored.length ? scored.reduce((a, r) => a + r.scores[k], 0) / scored.length : 0);
  const summary = {
    n: rows.length,
    ok: scored.length,
    key: avg('key'),
    meter: avg('meter'),
    pitch: avg('pitch'),
    pitchDur: avg('pitchDur'),
    interval: avg('interval'),
    lyrics: avg('lyrics'),
  };
  console.log(w.map((n) => '-'.repeat(n)).join(' '));
  console.log(
    [pad('MEAN', w[0]), pad('', w[1]), lpad(`${summary.ok}/${summary.n}`, w[2]),
      lpad(summary.key.toFixed(0), w[3]), lpad(summary.meter.toFixed(0), w[4]),
      lpad(summary.pitch.toFixed(1), w[5]), lpad(summary.pitchDur.toFixed(1), w[6]),
      lpad(summary.interval.toFixed(1), w[7]), lpad(summary.lyrics.toFixed(1), w[8])].join(' '),
  );

  const result = { date: new Date().toISOString(), url: opt.url, mock: cfg ? cfg.mock : null, summary, rows };
  fs.writeFileSync(opt.out, JSON.stringify(result, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), opt.out)}${cfg && cfg.mock ? '  (server is in MOCK mode: scores are meaningless)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
