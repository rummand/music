// Tests for the deterministic clean-up of model ABC in server/omr.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postProcess, fixOrphanRepeats, fixOctaveLeaps, fixKeyFromChords, readingAid } from '../server/omr.js';
import { score } from './omr-eval.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.abc'));
const H = 'X:1\nT:T\nM:4/4\nL:1/8\n';

test('correct fixtures are left unchanged', () => {
  for (const f of fixtures) {
    const abc = fs.readFileSync(path.join(FIX, f), 'utf8');
    assert.equal(postProcess(abc), abc, f);
  }
});

test('"|:" never closed by ":|" is removed; real repeats are kept', () => {
  const got = fixOrphanRepeats(`${H}K:G\n|: "G"D D | G4 G4 |\n|: "G"G G G G G2 B2 | G8 |]\n`);
  assert.equal(got, `${H}K:G\n"G"D D | G4 G4 |\n"G"G G G G G2 B2 | G8 |]\n`);
  const rep = `${H}K:F\n|: F2 G2 A2 F2 :: A2 B2 c4 :|\n|: cd cB A2 F2 :|\n`;
  assert.equal(fixOrphanRepeats(rep), rep);
  assert.equal(fixOrphanRepeats(`${H}K:C\nC8 |: D8 | E8 |]\n`), `${H}K:C\nC8 | D8 | E8 |]\n`);
});

test('leaps of more than an octave are folded back', () => {
  assert.equal(fixOctaveLeaps(`${H}K:F\nF2 G2 A2 F2 | c2 d2 c2 B,2 |\n`), `${H}K:F\nF2 G2 A2 F2 | c2 d2 c2 B2 |\n`);
  // a run written an octave too low is dragged up with the first wrong note
  assert.equal(fixOctaveLeaps(`${H}K:C\nc2 d2 c2 B,2 A,2 | G8 |\n`), `${H}K:C\nc2 d2 c2 B2 A2 | G8 |\n`);
  // a wrong first note of a line is moved toward the rest
  assert.equal(fixOctaveLeaps(`${H}K:C\nE,2 F2 G2 A2 | G8 |\n`), `${H}K:C\nE2 F2 G2 A2 | G8 |\n`);
  // an octave leap is fine
  const ok = `${H}K:C\nC2 c2 C2 c2 | G2 g2 G2 C2 |\n`;
  assert.equal(fixOctaveLeaps(ok), ok);
  // bass clef is left alone
  const bass = `${H}K:C clef=bass\nC,2 E2 C,2 E2 |\n`;
  assert.equal(fixOctaveLeaps(bass), bass);
});

test('a key signature one flat short is fixed from the first chord and last note', () => {
  const tune = `M:3/4\nL:1/8\nK:F\n"Bb"F3 G F2 | D6 | "Eb"G4 G2 | B3 A G2 | "F7"c4 c2 | e3 c A2 | B,6 |]\n`;
  assert.match(fixKeyFromChords(tune), /^K:Bb$/m);
  // first chord F and ending on F in K:F: unchanged
  const f = `M:3/4\nL:1/8\nK:F\n"F"F3 G F2 | "C7"E6 | F6 |]\n`;
  assert.equal(fixKeyFromChords(f), f);
  // first chord D (dominant) in K:G but ending on G: unchanged
  const g = `M:4/4\nL:1/8\nK:G\n"D"D2 | "G"G4 B4 | "D7"A4 F4 | "G"G8 |]\n`;
  assert.equal(fixKeyFromChords(g), g);
  // two accidentals apart: too uncertain, unchanged
  const far = `M:4/4\nL:1/8\nK:C\n"Bb"B4 d4 | B8 |]\n`;
  assert.equal(fixKeyFromChords(far), far);
  // missing sharp, minor key
  assert.match(fixKeyFromChords(`L:1/8\nK:Am\n"Em"E4 G4 | B4 G4 | E8 |]\n`), /^K:Em$/m);
});

test('post-processing raises the score of a real model answer (glade-jul.png, K:F instead of Bb)', () => {
  const truth = fs.readFileSync(path.join(FIX, 'glade-jul.abc'), 'utf8');
  const model = `X:1\nT:Glade jul\nM:3/4\nL:1/8\nK:F\n|:"Bb"F3 G F2 | D6 | "F7"F3 G F2 | D6 |\n|:"Bb"c4 c2 | A3 A3 | "Eb"B4 B2 | B3 A G2 |\n| "F7"c4 c2 | e3 c A2 | B6 | d6 |\n| "F7"B3 F D2 | F3 E C2 | B,6 |]\n`;
  const before = score(truth, model);
  const after = score(truth, postProcess(model));
  assert.equal(before.key, 0);
  assert.equal(after.key, 100);
  assert.ok(after.pitch > before.pitch);
});

test('reading aid names staff positions and note shapes', () => {
  const aid = readingAid(`${H}K:F\nF2 B,2 c4 | d8 |]\n`);
  assert.match(aid, /bar 1: F 1st space, quarter.*B, below ledger line 1 under the staff.*c 3rd space, half \(HOLLOW/);
  assert.match(aid, /bar 2: d 4th line, whole/);
  assert.equal(readingAid(`${H}K:C clef=bass\nC8|`), null);
});

// ---------------------------------------------------------------------------
// readSheet with the optional verify pass, against a fake fetch.
import { readSheet } from '../server/omr.js';

function fakeFetch(answers, calls) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    const content = answers.shift() ?? 'NOT_MUSIC';
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
const cfg = (omrVerify) => ({ muxBaseUrl: 'http://fake', muxApiKey: 'k', visionModel: 'vision', timeoutMs: 5000, omrVerify });
const fence = (abc) => `Analyse.\n\n\`\`\`abc\n${abc}\n\`\`\``;

test('readSheet: verify pass replaces the first answer with the checked one', async () => {
  const truth = fs.readFileSync(path.join(FIX, 'mester-jakob.abc'), 'utf8').trim();
  const wrong = truth.replace('A2 B2 c4', 'A2 B2 c2 A2');
  const calls = [];
  const r = await readSheet(cfg(true), Buffer.from('jpeg'), { fetchImpl: fakeFetch([fence(wrong), `- Takt 2: c er en halvnode.\n\n${fence(truth)}`], calls) });
  assert.equal(calls.length, 2);
  assert.equal(r.abc.trim(), truth);
  const second = calls[1].messages[1].content;
  assert.ok(second.some((p) => p.type === 'image_url'));
  assert.match(second.find((p) => p.type === 'text').text, /bar 2: A 2nd space, quarter/);
});

test('readSheet: an unusable verify answer keeps the first answer', async () => {
  const truth = fs.readFileSync(path.join(FIX, 'glade-jul.abc'), 'utf8').trim();
  for (const bad of ['Sorry, I cannot.', fence('X:1\nK:C\nC2 |]')]) {
    const calls = [];
    const r = await readSheet(cfg(true), Buffer.from('jpeg'), { fetchImpl: fakeFetch([fence(truth), bad], calls) });
    assert.equal(calls.length, 2);
    assert.equal(r.abc.trim(), truth);
  }
});

test('readSheet: verify pass is off unless enabled; post-processing still applies', async () => {
  const calls = [];
  const model = `X:1\nT:Glade jul\nM:3/4\nL:1/8\nK:F\n|:"Bb"F3 G F2 | D6 | "Eb"G4 G2 | B,6 |]`;
  const r = await readSheet(cfg(false), Buffer.from('jpeg'), { fetchImpl: fakeFetch([fence(model)], calls) });
  assert.equal(calls.length, 1);
  assert.match(r.abc, /^K:Bb$/m);
  assert.doesNotMatch(r.abc, /\|:/);
});
