// Tests for the OMR scoring helpers in test/omr-eval.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, analyse, lyricWords, similarity } from './omr-eval.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.abc'));

test('every fixture scores 100 against itself', () => {
  for (const f of fixtures) {
    const abc = fs.readFileSync(path.join(FIX, f), 'utf8');
    const s = score(abc, abc);
    for (const k of ['key', 'meter', 'pitch', 'pitchDur', 'interval', 'lyrics']) assert.equal(s[k], 100, `${f} ${k}`);
    assert.ok(analyse(abc).notes.length > 10, f);
  }
});

test('key signature accidentals are applied (Bb in F major, F# in D major)', () => {
  const jakob = analyse(fs.readFileSync(path.join(FIX, 'mester-jakob.abc'), 'utf8'));
  assert.ok(jakob.notes.some((n) => n.midi === 70)); // B -> Bb4
  assert.ok(!jakob.notes.some((n) => n.midi === 71));
  const peter = analyse(fs.readFileSync(path.join(FIX, 'lille-peter-edderkop.abc'), 'utf8'));
  assert.ok(peter.notes.some((n) => n.midi === 66 + 12)); // f -> F#5
});

test('bar-local accidentals carry through the bar only', () => {
  const a = analyse('X:1\nL:1/4\nK:C\n^F F G | F');
  assert.deepEqual(a.notes.map((n) => n.midi), [66, 66, 67, 65]);
});

test('repeats are unfolded so written-out tunes match', () => {
  const a = 'X:1\nM:4/4\nL:1/4\nK:C\n|: C D E F :| G A B c |\n|: c B A G |1 F E D C :|2 C4 |]';
  const b = 'X:1\nM:4/4\nL:1/4\nK:C\nC D E F | C D E F | G A B c | c B A G | F E D C | c B A G | C4 |]';
  assert.equal(score(a, b).pitchDur, 100);
});

test('wrong key / meter / notes lower the scores', () => {
  const truth = fs.readFileSync(path.join(FIX, 'glade-jul.abc'), 'utf8');
  const wrong = truth.replace('K:Bb', 'K:F').replace('M:3/4', 'M:6/8');
  const s = score(truth, wrong);
  assert.equal(s.key, 0);
  assert.equal(s.meter, 0);
  assert.ok(s.pitch < 100 && s.pitch > 50, `pitch ${s.pitch}`); // only the E/Eb notes differ
  const halfDur = truth.replace(/^L:1\/8$/m, 'L:1/16');
  const s2 = score(truth, halfDur);
  assert.equal(s2.pitch, 100);
  assert.ok(s2.pitchDur < 30, `pitchDur ${s2.pitchDur}`);
});

test('lyrics: syllables are joined across hyphens and lines', () => {
  const abc = fs.readFileSync(path.join(FIX, 'hjulene-paa-bussen.abc'), 'utf8');
  const w = lyricWords(abc);
  assert.equal(w.filter((x) => x === 'hjulene').length, 2);
  assert.ok(w.includes('byen'));
  assert.ok(w.includes('på'));
});

test('garbage ABC scores low instead of throwing', () => {
  const truth = fs.readFileSync(path.join(FIX, 'mester-jakob.abc'), 'utf8');
  const s = score(truth, 'this is not abc');
  assert.equal(s.key, 0);
  assert.ok(s.pitch < 30, `pitch ${s.pitch}`);
  assert.equal(similarity([], []), 100);
});
