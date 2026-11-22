// Unit tests for the pure ABC helpers in server/abc.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractAbc, validateAbc } from '../server/abc.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const TUNE = `X:1
T:Mester Jakob
M:4/4
L:1/8
K:F
"F"F2 G2 A2 F2 | F2 G2 A2 F2 | A2 B2 c4 | A2 B2 c4 |
w:Mes-ter Ja-kob, mes-ter Ja-kob, so-ver du? So-ver du?`;

test('extractAbc: ```abc fenced block with prose around it', () => {
  const text = `Here is the transcription:\n\n\`\`\`abc\n${TUNE}\n\`\`\`\n\nI was unsure about bar 3.`;
  const abc = extractAbc(text);
  assert.ok(abc);
  assert.match(abc, /^X:1/);
  assert.match(abc, /^K:F$/m);
  assert.doesNotMatch(abc, /```/);
  assert.doesNotMatch(abc, /transcription|unsure/);
});

test('extractAbc: fence without language tag', () => {
  const abc = extractAbc(`Sure!\n\`\`\`\n${TUNE}\n\`\`\``);
  assert.ok(abc);
  assert.match(abc, /^T:Mester Jakob$/m);
  assert.doesNotMatch(abc, /Sure/);
});

test('extractAbc: prefers the ```abc block over another fenced block', () => {
  const text = `\`\`\`json\n{"a":1}\n\`\`\`\n\`\`\`abc\n${TUNE}\n\`\`\``;
  const abc = extractAbc(text);
  assert.match(abc, /^K:F$/m);
  assert.doesNotMatch(abc, /"a":1/);
});

test('extractAbc: unclosed fence (answer cut off)', () => {
  const abc = extractAbc(`\`\`\`abc\n${TUNE}\n"C"c2 d2`);
  assert.ok(abc);
  assert.match(abc, /^K:F$/m);
});

test('extractAbc: unfenced ABC with prose before and after', () => {
  const abc = extractAbc(`Analysis: F major, 4/4.\n\n${TUNE}\n\nLet me know if you need changes.`);
  assert.ok(abc);
  assert.match(abc, /^X:1/);
  assert.doesNotMatch(abc, /Analysis|Let me know/);
});

test('extractAbc: unfenced without X: starts at the first header field', () => {
  const noX = TUNE.replace(/^X:1\n/, '');
  const abc = extractAbc(`Svar:\n${noX}`);
  assert.ok(abc);
  assert.match(abc, /^T:Mester Jakob/);
});

test('extractAbc: CRLF line endings', () => {
  const abc = extractAbc('```abc\r\n' + TUNE.replace(/\n/g, '\r\n') + '\r\n```');
  assert.ok(abc);
  assert.doesNotMatch(abc, /\r/);
});

test('extractAbc: <think> blocks are ignored', () => {
  const abc = extractAbc(`<think>K:C maybe? X:9</think>\n\`\`\`abc\n${TUNE}\n\`\`\``);
  assert.match(abc, /^X:1/);
  assert.doesNotMatch(abc, /think/);
});

test('extractAbc: garbage / non-strings give null', () => {
  for (const v of [undefined, null, 42, {}, '', '   ', 'I cannot read this image, sorry.', 'NOT_MUSIC']) {
    assert.equal(extractAbc(v), null, `for ${JSON.stringify(v)}`);
  }
});

test('validateAbc: valid tune is ok and keeps the music', () => {
  const r = validateAbc(TUNE);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.errors, []);
  assert.match(r.abc, /^X:1\n/);
  assert.match(r.abc, /A2 B2 c4/);
  assert.ok(Array.isArray(r.warnings));
});

test('validateAbc: missing X: is added at the top', () => {
  const r = validateAbc(TUNE.replace(/^X:1\n/, ''));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.match(r.abc, /^X:1\nT:Mester Jakob/);
});

test('validateAbc: X: not first is moved to the top', () => {
  const r = validateAbc(TUNE.replace(/^X:1\nT:Mester Jakob/, 'T:Mester Jakob\nX:3'));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.match(r.abc, /^X:3\nT:/);
});

test('validateAbc: missing K: is invalid', () => {
  const r = validateAbc(TUNE.replace(/^K:F\n/m, ''));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /K:/.test(e)));
});

test('validateAbc: garbage, empty and non-strings are invalid', () => {
  for (const v of [undefined, null, '', '   ', 'Hello, this is not music at all.', 'K:C\n', 12]) {
    const r = validateAbc(v);
    assert.equal(r.ok, false, `expected invalid for ${JSON.stringify(v)}`);
    assert.ok(r.errors.length > 0);
  }
});

test('validateAbc: unbalanced chord-symbol quote is invalid', () => {
  const r = validateAbc(TUNE.replace('"F"F2', '"F F2'));
  assert.equal(r.ok, false);
});

test('validateAbc: blank lines inside the tune are removed', () => {
  const r = validateAbc(TUNE.replace('A2 B2 c4 |\nw:', 'A2 B2 c4 |\n\nw:'));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.doesNotMatch(r.abc.trim(), /\n\s*\n/);
});

test('validateAbc: "% NOTE:" comments become notes', () => {
  const r = validateAbc(`${TUNE}\n% NOTE: takt 3 er utydelig`);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.ok(r.notes.some((n) => /takt 3/.test(n)));
  assert.doesNotMatch(r.abc, /NOTE/);
});

test('validateAbc: bar with wrong length gives a warning, not an error', () => {
  const r = validateAbc(TUNE.replace('A2 B2 c4 | A2', 'A2 B2 c4 c2 | A2'));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.ok(r.warnings.length >= 1, 'expected a bar-length warning');
});

test('validateAbc: final bar line |] and repeats are accepted', () => {
  const r = validateAbc(`${TUNE.split('\nw:')[0]} cd cB A2 F2 |]`);
  assert.equal(r.ok, true, r.errors.join('; '));
  const r2 = validateAbc('X:1\nM:3/4\nL:1/4\nK:G\n|: G A B :|[1 c3 :|[2 d3 |]');
  assert.equal(r2.ok, true, r2.errors.join('; '));
});

test('validateAbc: all ground-truth fixtures are valid without bar warnings', () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.abc'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const r = validateAbc(fs.readFileSync(path.join(FIX, f), 'utf8'));
    assert.equal(r.ok, true, `${f}: ${r.errors.join('; ')}`);
    assert.deepEqual(r.warnings, [], `${f}: ${r.warnings.join('; ')}`);
  }
});

test('extractAbc + validateAbc round-trip on every fixture wrapped in a chatty answer', () => {
  for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.abc'))) {
    const truth = fs.readFileSync(path.join(FIX, f), 'utf8').trim();
    const answer = `Jeg har læst noderne.\n\n\`\`\`abc\n${truth}\n\`\`\`\n\nBemærk: akkorderne er usikre.`;
    const abc = extractAbc(answer);
    assert.equal(abc, truth, f);
  }
});
