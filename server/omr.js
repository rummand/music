// Reading sheet music (vision model) and editing ABC (text model) through mux.

import { extractAbc, validateAbc, getTitle } from './abc.js';
import { chat, MuxError } from './mux.js';
import {
  OMR_SYSTEM,
  OMR_INSTRUCTIONS,
  omrRetryMessage,
  omrVerifyMessage,
  EDIT_SYSTEM,
  editUserMessage,
  editRetryMessage,
} from './prompts.js';

const NOT_MUSIC_ERROR = 'Billedet ser ikke ud til at indeholde noder. Tag et billede, hvor nodelinjerne fylder det meste af billedet.';

function checkAnswer(content, finishReason) {
  const abc = extractAbc(content);
  const result = validateAbc(abc);
  if (!result.ok && finishReason === 'length') {
    result.errors.push('The answer was cut off (too long). Write a shorter analysis and only the ABC.');
  }
  return result;
}

/**
 * Turn a JPEG of sheet music into ABC.
 * @returns {Promise<{abc:string, title:string|null, warnings:string[]}>}
 */
export async function readSheet(config, jpeg, { fetchImpl } = {}) {
  const started = Date.now();
  const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const messages = [
    { role: 'system', content: OMR_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: OMR_INSTRUCTIONS },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    },
  ];

  const first = await chat(config, { model: config.visionModel, messages, maxTokens: 4000, temperature: 0, fetchImpl });
  if (/^\s*NOT_MUSIC\b/.test(first.content) && !extractAbc(first.content)) {
    throw new MuxError(NOT_MUSIC_ERROR, 422, 'not_music');
  }
  let result = checkAnswer(first.content, first.finishReason);

  if (!result.ok) {
    console.warn(`[read] first answer invalid: ${result.errors.join(' | ')}; retrying once`);
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: first.content || '(empty answer)' },
      { role: 'user', content: omrRetryMessage(result.errors) },
    ];
    const second = await chat(config, {
      model: config.visionModel,
      messages: retryMessages,
      maxTokens: 4000,
      temperature: 0,
      fetchImpl,
    });
    if (/^\s*NOT_MUSIC\b/.test(second.content) && !extractAbc(second.content)) {
      throw new MuxError(NOT_MUSIC_ERROR, 422, 'not_music');
    }
    result = checkAnswer(second.content, second.finishReason);
    if (!result.ok) {
      console.warn(`[read] retry answer invalid: ${result.errors.join(' | ')}`);
      throw new MuxError(
        'Noderne kunne ikke læses. Prøv et nyt billede: hold telefonen lige over siden, sørg for godt lys, og få kun én sang med.',
        422,
        'unreadable',
      );
    }
  }

  if (verifyEnabled(config)) {
    const elapsed = Date.now() - started;
    if (elapsed < VERIFY_SKIP_AFTER_MS) {
      result = await verifyPass(config, messages, result, { fetchImpl });
    } else {
      console.warn(`[read] skipping verify pass: first answer took ${elapsed} ms`);
    }
  }

  // Deterministic clean-up of common model mistakes; re-validate the outcome.
  const fixed = postProcess(result.abc);
  if (fixed !== result.abc) {
    const again = validateAbc(fixed);
    if (again.ok) result = { ...again, notes: [...result.notes, ...again.notes] };
  }

  return {
    abc: result.abc,
    title: getTitle(result.abc),
    warnings: [...result.notes, ...result.warnings],
  };
}

// The verify pass (a second look at the picture with the first transcription
// and a reading aid) is on when OMR_VERIFY=1 or config.omrVerify is true.
const VERIFY_SKIP_AFTER_MS = 20_000;
function verifyEnabled(config) {
  if (typeof config.omrVerify === 'boolean') return config.omrVerify;
  return /^(1|true|yes|on)$/i.test(String(process.env.OMR_VERIFY ?? '').trim());
}

const noteCount = (abc) => {
  const { lines, k } = splitTune(abc);
  let n = 0;
  for (let li = k + 1; li < lines.length; li++) if (isMusic(lines[li])) n += tokenizeMusicLine(lines[li]).filter((t) => t.t === 'note').length;
  return n;
};

/** Ask the model to check its transcription against the image. Falls back to `first` on any problem. */
async function verifyPass(config, messages, first, { fetchImpl }) {
  const aid = readingAid(first.abc);
  if (!aid) return first;
  try {
    const answer = await chat(config, {
      model: config.visionModel,
      messages: [
        messages[0],
        {
          role: 'user',
          content: [
            { type: 'text', text: omrVerifyMessage(first.abc, aid) },
            messages[1].content.find((p) => p.type === 'image_url'),
          ],
        },
      ],
      maxTokens: 4000,
      temperature: 0,
      timeoutMs: 60_000,
      fetchImpl,
    });
    const checked = checkAnswer(answer.content, answer.finishReason);
    if (!checked.ok) {
      console.warn(`[read] verify answer invalid: ${checked.errors.join(' | ')}; keeping first answer`);
      return first;
    }
    const n0 = noteCount(first.abc);
    const n1 = noteCount(checked.abc);
    if (n1 < n0 * 0.6 || n1 > n0 * 1.6) {
      console.warn(`[read] verify answer changed note count ${n0} -> ${n1}; keeping first answer`);
      return first;
    }
    if (checked.warnings.length > first.warnings.length) {
      console.warn(`[read] verify answer has more bar problems (${checked.warnings.length} > ${first.warnings.length}); keeping first answer`);
      return first;
    }
    console.log(`[read] verify pass: ${checked.abc === first.abc ? 'no changes' : 'corrected'}`);
    return { ...checked, notes: [...new Set([...first.notes, ...checked.notes])] };
  } catch (err) {
    console.warn(`[read] verify pass failed (${err.message}); keeping first answer`);
    return first;
  }
}

/** Text before the first code fence, as the explanation. */
function explanationOf(content) {
  const s = (content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const idx = s.search(/(^|\n)[ \t]*(`{3,}|~{3,})/);
  const text = (idx >= 0 ? s.slice(0, idx) : s).trim();
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Change an ABC tune (or answer a question about it) following a Danish instruction.
 * @returns {Promise<{abc:string, explanation:string}>}
 */
export async function editAbc(config, abc, instruction, { fetchImpl } = {}) {
  const messages = [
    { role: 'system', content: EDIT_SYSTEM },
    { role: 'user', content: editUserMessage(abc, instruction) },
  ];
  const first = await chat(config, { model: config.textModel, messages, maxTokens: 4000, temperature: 0, fetchImpl });

  let content = first.content;
  let extracted = extractAbc(content);
  // No ABC at all: the model answered a question in prose. Keep the tune unchanged.
  if (!extracted) {
    const explanation = explanationOf(content);
    if (!explanation) throw new MuxError('AI-modellen gav et tomt svar. Prøv igen.', 502, 'empty');
    return { abc, explanation };
  }

  let result = validateAbc(extracted);
  if (!result.ok) {
    console.warn(`[edit] first answer invalid: ${result.errors.join(' | ')}; retrying once`);
    const second = await chat(config, {
      model: config.textModel,
      messages: [...messages, { role: 'assistant', content }, { role: 'user', content: editRetryMessage(result.errors) }],
      maxTokens: 4000,
      temperature: 0,
      fetchImpl,
    });
    content = second.content;
    extracted = extractAbc(content);
    result = validateAbc(extracted);
    if (!result.ok) {
      throw new MuxError('Ændringen gav ikke gyldige noder. Prøv at formulere ønsket anderledes.', 422, 'invalid_edit');
    }
  }

  const explanation = explanationOf(content) || 'Noderne er opdateret.';
  return { abc: result.abc, explanation };
}

// ---------------------------------------------------------------------------
// Post-processing of the model's ABC: deterministic fixes for the mistakes the
// vision model makes most often (see test/omr-eval.mjs results):
//  - "|:" written at the start of lines where no repeat is printed (no ":|" follows)
//  - single notes or runs written an octave off (B, for B), seen as leaps > an octave
//  - one sharp/flat of the key signature missed (K:F for a tune in Bb whose
//    first chord is Bb and whose melody ends on Bb)

const STEP = 'CDEFGAB';

/**
 * Split an ABC tune into header lines and body lines, and tokenize music lines.
 * Tokens: {t:'note', i, j, acc, letter, octMarks, len, idx} (idx = diatonic step, C4 = 28),
 *         {t:'rest', i, j, len}, {t:'bar', i, j, text}, {t:'chord', text} ("..." symbols),
 *         {t:'stack'} (a [CEG] chord: notes inside are ignored).
 */
export function tokenizeMusicLine(line) {
  const toks = [];
  let i = 0;
  const readLen = (k) => {
    const m = /^(\d*)(\/*)(\d*)/.exec(line.slice(k));
    let len = m[1] ? Number(m[1]) : 1;
    if (m[2]) len /= m[3] ? Number(m[3]) : 2 ** m[2].length;
    return { len, end: k + m[0].length };
  };
  while (i < line.length) {
    const c = line[i];
    if (c === '%') break;
    if (c === '"') {
      const j = line.indexOf('"', i + 1);
      const end = j < 0 ? line.length : j + 1;
      toks.push({ t: 'chord', i, j: end, text: line.slice(i + 1, end - 1) });
      i = end;
      continue;
    }
    if (c === '!' || c === '+' || c === '{') {
      const j = line.indexOf(c === '{' ? '}' : c, i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (c === '[' && /^[A-Za-z]:/.test(line.slice(i + 1, i + 3))) {
      const j = line.indexOf(']', i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (c === '|' || c === ':' || (c === '[' && /[|\d]/.test(line[i + 1] || '')) || c === ']') {
      let j = i;
      while (j < line.length && (/[|:\]]/.test(line[j]) || (line[j] === '[' && /[\d|]/.test(line[j + 1] || '')))) j++;
      while (j < line.length && /\d/.test(line[j])) j++;
      toks.push({ t: 'bar', i, j, text: line.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '[') {
      const j = line.indexOf(']', i + 1);
      const end = j < 0 ? line.length : j + 1;
      const r = readLen(end);
      toks.push({ t: 'stack', i, j: r.end });
      i = r.end;
      continue;
    }
    const m = /^([\^=_]*)([A-Ga-g])([,']*)/.exec(line.slice(i));
    if (m) {
      const r = readLen(i + m[0].length);
      const upper = m[2] === m[2].toUpperCase();
      let oct = upper ? 4 : 5;
      for (const ch of m[3]) oct += ch === "'" ? 1 : -1;
      const step = STEP.indexOf(m[2].toUpperCase());
      toks.push({ t: 'note', i, j: r.end, acc: m[1], letter: m[2].toUpperCase(), octMarks: m[3], len: r.len, idx: oct * 7 + step, lenText: line.slice(i + m[0].length, r.end) });
      i = r.end;
      continue;
    }
    if (c === 'z' || c === 'x') {
      const r = readLen(i + 1);
      toks.push({ t: 'rest', i, j: r.end, len: r.len });
      i = r.end;
      continue;
    }
    i++;
  }
  return toks;
}

function splitTune(abc) {
  const lines = abc.replace(/\r\n?/g, '\n').split('\n');
  const k = lines.findIndex((l) => /^K:/.test(l));
  return { lines, k };
}
const isMusic = (l) => l.trim() && !/^[A-Za-z+]:/.test(l) && !l.trim().startsWith('%');

/** ABC spelling of a diatonic index (C4 = 28 -> "C", 35 -> "c", 21 -> "C,"). */
function spell(letter, idx) {
  const oct = Math.floor(idx / 7);
  if (oct >= 5) return letter.toLowerCase() + "'".repeat(oct - 5);
  return letter + ','.repeat(4 - oct);
}

/** Replace "|:" that is never closed by ":|" / "::" with a plain bar line. */
export function fixOrphanRepeats(abc) {
  const { lines, k } = splitTune(abc);
  if (k < 0) return abc;
  // Collect all bar tokens in order with their positions.
  const bars = [];
  lines.forEach((l, li) => {
    if (li <= k || !isMusic(l)) return;
    for (const t of tokenizeMusicLine(l)) if (t.t === 'bar') bars.push({ li, ...t });
  });
  const orphans = [];
  bars.forEach((b, n) => {
    if (!/\|:$|\|:\d*$/.test(b.text) || /:\|/.test(b.text) || /::/.test(b.text)) return;
    // Look for the next bar with a repeat end before another repeat start.
    for (let m = n + 1; m < bars.length; m++) {
      const t = bars[m].text;
      if (/^:|:\||::/.test(t)) return; // closed
      if (/\|:/.test(t)) break; // another start: this one is an orphan
    }
    orphans.push(b);
  });
  if (!orphans.length) return abc;
  // Edit from the end so positions stay valid.
  for (const b of orphans.reverse()) {
    const l = lines[b.li];
    const before = l.slice(0, b.i);
    const repl = b.text.replace(/\|:/, '|');
    // At the very start of a line a plain "|" is not needed.
    if (!before.trim() && repl === '|') lines[b.li] = l.slice(b.j).replace(/^\s+/, '');
    else lines[b.li] = before + repl + l.slice(b.j);
  }
  return lines.join('\n');
}

/**
 * Move notes back by an octave when the melody leaps more than an octave
 * (a 9th or more) between neighbouring notes on the same line. Songs almost
 * never do that; the model does it when it gets the octave marks wrong.
 */
export function fixOctaveLeaps(abc) {
  const { lines, k } = splitTune(abc);
  if (k < 0) return abc;
  if (lines.some((l) => /^V:|\[V:/.test(l)) || /clef\s*=\s*(bass|alto|tenor)|\bbass\b/i.test(lines[k])) return abc;
  // Median pitch of the whole tune, to tell which side of a leap is the odd one.
  const all = [];
  for (let li = k + 1; li < lines.length; li++) {
    if (isMusic(lines[li])) for (const t of tokenizeMusicLine(lines[li])) if (t.t === 'note') all.push(t.idx);
  }
  if (all.length < 4) return abc;
  const sorted = [...all].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const toward = (idx, ref) => {
    while (idx - ref > 7) idx -= 7;
    while (ref - idx > 7) idx += 7;
    return idx;
  };
  let changed = false;
  for (let li = k + 1; li < lines.length; li++) {
    const l = lines[li];
    if (!isMusic(l)) continue;
    const notes = [];
    let segStart = 0;
    for (const t of tokenizeMusicLine(l)) {
      if (t.t === 'stack') segStart = notes.length; // after a [chord], start afresh
      else if (t.t === 'note') notes.push({ ...t, newIdx: t.idx, first: notes.length === segStart });
    }
    for (let n = 1; n < notes.length; n++) {
      const prev = notes[n - 1];
      const cur = notes[n];
      if (cur.first) continue;
      if (Math.abs(cur.newIdx - prev.newIdx) <= 7) continue;
      if (prev.first && Math.abs(prev.newIdx - median) > Math.abs(cur.newIdx - median)) {
        prev.newIdx = toward(prev.newIdx, cur.newIdx);
      } else {
        cur.newIdx = toward(cur.newIdx, prev.newIdx);
      }
    }
    const edits = notes.filter((t) => t.newIdx !== t.idx);
    if (edits.length) {
      let s = l;
      for (const e of edits.reverse()) s = s.slice(0, e.i) + e.acc + spell(e.letter, e.newIdx) + e.lenText + s.slice(e.j);
      lines[li] = s;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : abc;
}

// Key signatures as number of sharps (+) / flats (-) for major tonics.
const MAJOR_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
const SHARP_ORDER = 'FCGDAEB';
const FLAT_ORDER = 'BEADGCF';
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parse a K: value into {fifths, tonic, minor} or null for anything unusual. */
function parseKey(value) {
  const m = /^\s*([A-G])([#b]?)\s*(m|min|minor|maj|major|ion|ionian|aeo|aeolian)?\s*$/i.exec(value);
  if (!m) return null;
  const tonic = m[1].toUpperCase() + (m[2] || '');
  const minor = /^(m|min|minor|aeo|aeolian)$/i.test(m[3] || '');
  let fifths = MAJOR_FIFTHS[tonic];
  if (fifths == null) {
    // minor: relative major is a minor third up
    if (!minor) return null;
  }
  if (minor) {
    const pc = (PC[tonic[0]] + (tonic[1] === '#' ? 1 : tonic[1] === 'b' ? -1 : 0) + 3 + 12) % 12;
    const rel = Object.keys(MAJOR_FIFTHS).find((t) => pcOf(t) === pc && Math.abs(MAJOR_FIFTHS[t]) <= 6);
    if (!rel) return null;
    fifths = MAJOR_FIFTHS[rel];
  }
  return { fifths, tonic, minor };
}
function pcOf(name) {
  return (PC[name[0]] + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + 12) % 12;
}
function keyAccidental(fifths, letter) {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(letter) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(letter) ? -1 : 0;
  return 0;
}

/**
 * If the key signature looks one sharp/flat short (or long), fix K:.
 * Evidence needed: the first chord symbol and the last melody note name the
 * same pitch, that pitch is not the tonic of the written key, and the key of
 * that chord differs from the written key signature by exactly one accidental.
 */
export function fixKeyFromChords(abc) {
  const { lines, k } = splitTune(abc);
  if (k < 0) return abc;
  const kv = lines[k].slice(2).replace(/%.*/, '');
  const written = parseKey(kv);
  if (!written) return abc;
  let firstChord = null;
  let lastNote = null;
  for (let li = k + 1; li < lines.length; li++) {
    if (!isMusic(lines[li])) continue;
    if (/\[K:/.test(lines[li])) return abc; // key changes: leave alone
    for (const t of tokenizeMusicLine(lines[li])) {
      if (t.t === 'chord' && firstChord == null) {
        const m = /^([A-G])([#b]?)(m(?!aj))?/.exec(t.text);
        if (m) firstChord = { tonic: m[1] + (m[2] || ''), minor: !!m[3] };
      }
      if (t.t === 'note') lastNote = t;
    }
  }
  if (!firstChord || !lastNote) return abc;
  const target = parseKey(firstChord.tonic + (firstChord.minor ? 'm' : ''));
  if (!target || target.fifths === written.fifths) return abc;
  if (Math.abs(target.fifths - written.fifths) !== 1) return abc;
  // Tonic of the written key already matches: nothing to fix.
  if (pcOf(written.tonic) === pcOf(target.tonic)) return abc;
  const accOf = (acc) => (acc.includes('^') ? acc.length : acc.includes('_') ? -acc.length : 0);
  const notePc = (fifths) =>
    (PC[lastNote.letter] + (lastNote.acc ? (lastNote.acc.includes('=') ? 0 : accOf(lastNote.acc)) : keyAccidental(fifths, lastNote.letter)) + 12) % 12;
  if (notePc(target.fifths) !== pcOf(target.tonic)) return abc;
  lines[k] = `K:${target.tonic}${target.minor ? 'm' : ''}`;
  return lines.join('\n');
}

/** All deterministic fixes, in order. Returns the (possibly unchanged) ABC. */
export function postProcess(abc) {
  if (typeof abc !== 'string') return abc;
  let out = abc;
  for (const f of [fixOrphanRepeats, fixOctaveLeaps, fixKeyFromChords]) {
    try {
      out = f(out);
    } catch (err) {
      console.warn(`[read] post-process ${f.name} failed: ${err.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading aid for the verification pass.

function staffPosition(idx) {
  const p = idx - 30; // 0 = bottom line, 1 = first space, ... 8 = top line
  if (p >= 0 && p <= 8) {
    const n = Math.floor(p / 2) + 1;
    const ord = ['', '1st', '2nd', '3rd', '4th', '5th'][n];
    return p % 2 === 0 ? `${ord} line` : `${ord} space`;
  }
  if (p === -1) return 'space just below the staff';
  if (p === 9) return 'space just above the staff';
  if (p < -1) {
    const ledgers = Math.floor((-p) / 2);
    return (-p) % 2 === 0 ? `on ledger line ${ledgers} below the staff` : `below ledger line ${ledgers} under the staff`;
  }
  const ledgers = Math.floor((p - 8) / 2);
  return (p - 8) % 2 === 0 ? `on ledger line ${ledgers} above the staff` : `above ledger line ${ledgers} over the staff`;
}

function lookOf(eighths) {
  const table = {
    0.5: 'sixteenth (filled, double beam)',
    1: 'eighth (filled, beam/flag)',
    1.5: 'dotted eighth',
    2: 'quarter (filled, stem)',
    3: 'dotted quarter',
    4: 'half (HOLLOW, stem)',
    6: 'dotted half (HOLLOW, dot)',
    8: 'whole (HOLLOW, no stem)',
  };
  const key = Math.round(eighths * 1000) / 1000;
  return table[key] || `${key}/8 long`;
}

/** Bar-by-bar description of a single-voice treble-clef ABC tune, or null. */
export function readingAid(abc) {
  const { lines, k } = splitTune(abc);
  if (k < 0) return null;
  if (lines.some((l) => /^V:|\[V:/.test(l)) || /clef\s*=/i.test(lines[k])) return null;
  let unit = 1 / 8;
  for (const l of lines.slice(0, k)) {
    const m = /^L:\s*(\d+)\/(\d+)/.exec(l);
    if (m) unit = Number(m[1]) / Number(m[2]);
  }
  const out = [];
  let bar = [];
  let barNo = 1;
  let system = 0;
  const flush = () => {
    if (!bar.length) return;
    out.push(`  bar ${barNo}: ${bar.join('; ')}`);
    barNo++;
    bar = [];
  };
  for (let li = k + 1; li < lines.length; li++) {
    if (!isMusic(lines[li])) continue;
    system++;
    out.push(`System ${system}:`);
    for (const t of tokenizeMusicLine(lines[li])) {
      if (t.t === 'bar') flush();
      else if (t.t === 'note') {
        const name = `${t.acc}${spell(t.letter, t.idx)}`;
        bar.push(`${name} ${staffPosition(t.idx)}, ${lookOf((t.len * unit) / (1 / 8))}`);
      } else if (t.t === 'rest') bar.push(`rest ${lookOf((t.len * unit) / (1 / 8))}`);
    }
    flush();
    if (out.length > 120) break;
  }
  return out.join('\n');
}
