// Pure helpers for ABC notation: pull it out of a model's answer, check it,
// tidy it, and look for bars whose length does not match the meter.
// No I/O here, so the test suite can exercise everything directly.

const FIELD_LINE = /^[A-Za-z+]:/;
const NOTE_LETTER = /[A-Ga-g]/;

/**
 * Pull ABC notation out of a model answer.
 * Prefers a ```abc fenced block, then any fenced block that looks like ABC,
 * then unfenced text starting at the first header line (X:, T:, M:, L:, K:).
 * Accepts a fence that was never closed (answer cut off by max_tokens).
 * @param {unknown} text
 * @returns {string|null} the ABC (trimmed), or null when nothing ABC-like is found
 */
export function extractAbc(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.replace(/\r\n?/g, '\n');
  // Reasoning models may wrap their thinking in <think> tags.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');

  const fences = [];
  const fenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    fences.push({ lang: m[3].toLowerCase(), body: m[4] });
  }
  const looksAbc = (b) => /^[ \t]*K:/m.test(b);
  const pick =
    fences.find((f) => f.lang === 'abc' && looksAbc(f.body)) ||
    fences.find((f) => looksAbc(f.body)) ||
    fences.find((f) => f.lang === 'abc' && f.body.trim());
  if (pick) return cleanBlock(pick.body);

  // Unfenced: start at X: if present, else the first header field line.
  const lines = s.split('\n');
  let start = lines.findIndex((l) => /^\s*X:\s*\d*\s*$/.test(l));
  if (start < 0) start = lines.findIndex((l) => /^\s*[TMLKQC]:/.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start);
  if (!rest.some((l) => /^\s*K:/.test(l))) return null;
  // Drop trailing prose: lines after the music that are neither fields,
  // comments nor contain a bar line.
  while (rest.length) {
    const last = rest[rest.length - 1].trim();
    if (last === '' || !(FIELD_LINE.test(last) || last.startsWith('%') || last.includes('|'))) rest.pop();
    else break;
  }
  return cleanBlock(rest.join('\n'));
}

function cleanBlock(body) {
  const out = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/^[ \t]+(?=[A-Za-z+]:)/, ''))
    .filter((l) => !/^\s*(`{3,}|~{3,})/.test(l))
    .join('\n')
    .trim();
  return out || null;
}

/** True if a body line is music (not a field, lyrics or comment). */
function isMusicLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('%')) return false;
  if (FIELD_LINE.test(t)) return false;
  return true;
}

/** Remove things in a music line that can contain note letters but are not notes. */
function stripNonNotes(line) {
  return line
    .replace(/%.*$/, '')
    .replace(/"[^"]*"/g, '')
    .replace(/![^!]*!/g, '')
    .replace(/\+[^+\s]*\+/g, '')
    .replace(/\[[A-Za-z]:[^\]]*\]/g, '');
}

/**
 * Check and tidy ABC text.
 * Fixes: adds X:1 (and moves X: to the top), removes blank lines inside the
 * tune (a blank line ends an ABC tune), strips "% NOTE:" lines into notes.
 * Errors (ok=false) are Danish/English strings suitable to feed back to the model.
 * @param {unknown} abc
 * @returns {{ok:boolean, abc:string, errors:string[], warnings:string[], notes:string[]}}
 */
export function validateAbc(abc) {
  const errors = [];
  const warnings = [];
  const notes = [];
  if (typeof abc !== 'string' || !abc.trim()) {
    return { ok: false, abc: '', errors: ['No ABC notation found in the answer.'], warnings, notes };
  }

  let lines = abc.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));

  // Pull out "% NOTE: ..." comments the model was asked to leave for unclear spots.
  lines = lines.filter((l) => {
    const m = /^\s*%+\s*(?:NOTE|NOTA|BEMÆRK|USIKKER)\s*:\s*(.+)$/i.exec(l);
    if (m) {
      notes.push(m[1].trim());
      return false;
    }
    return true;
  });

  // Drop leading blank lines and any stray fence lines.
  lines = lines.filter((l) => !/^\s*(`{3,}|~{3,})/.test(l));
  while (lines.length && !lines[0].trim()) lines.shift();

  // X: must be the first line.
  const xIdx = lines.findIndex((l) => /^X:/.test(l));
  let xLine = 'X:1';
  if (xIdx >= 0) {
    const n = /^X:\s*(\d+)/.exec(lines[xIdx]);
    xLine = `X:${n ? n[1] : 1}`;
    lines.splice(xIdx, 1);
  }
  lines.unshift(xLine);

  const kIdx = lines.findIndex((l) => /^K:/.test(l));
  if (kIdx < 0) {
    errors.push('Missing the K: (key) header line. The header must end with a K: line, e.g. "K:F" or "K:Dm".');
  }

  // Keep only header + tune; remove blank lines inside the tune so it is not cut short.
  const headerEnd = kIdx >= 0 ? kIdx : lines.length - 1;
  const header = lines.slice(0, headerEnd + 1).filter((l) => l.trim() !== '');
  const body = kIdx >= 0 ? lines.slice(kIdx + 1).filter((l) => l.trim() !== '') : [];

  if (kIdx >= 0) {
    // Notes before K: in the header mean the header is out of order.
    const strayMusic = header.slice(1, -1).filter((l) => isMusicLine(l) && NOTE_LETTER.test(stripNonNotes(l)));
    if (strayMusic.length) {
      errors.push('Music appears before the K: line. Put all header fields (X:, T:, M:, L:, Q:) first, then K:, then the music.');
    }
    const musicLines = body.filter(isMusicLine);
    const hasNote = musicLines.some((l) => /[A-Ga-g]/.test(stripNonNotes(l)));
    if (!hasNote) {
      errors.push('No notes found after the K: line. Write the melody as ABC notes (A-G, a-g) after K:.');
    }
    body.forEach((l, i) => {
      if (!isMusicLine(l)) return;
      const noComment = l.replace(/%.*$/, '');
      if ((noComment.match(/"/g) || []).length % 2 === 1) {
        errors.push(`Unbalanced quote (") in music line ${i + 1}: ${l.slice(0, 60)}. Chord symbols must be written like "Am".`);
      }
      const opens = (noComment.replace(/"[^"]*"/g, '').match(/\[/g) || []).length;
      const closes = (noComment.replace(/"[^"]*"/g, '').match(/\]/g) || []).length;
      if (opens !== closes) {
        errors.push(`Unbalanced [ ] brackets in music line ${i + 1}: ${l.slice(0, 60)}.`);
      }
    });
  }

  const out = [...header, ...body].join('\n') + '\n';
  if (!errors.length) warnings.push(...checkBars(out));
  return { ok: errors.length === 0, abc: out, errors, warnings, notes };
}

/** First T: field of the tune, or null. */
export function getTitle(abc) {
  if (typeof abc !== 'string') return null;
  const m = /^T:[ \t]*(.*\S)[ \t]*$/m.exec(abc);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Bar-length check

function parseFraction(s) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s || '');
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  return d ? { n, d } : null;
}

/** Meter as {n, d} or null for none/free meter. */
function parseMeter(value) {
  const v = (value || '').trim();
  if (!v || /^none$/i.test(v)) return null;
  if (v === 'C') return { n: 4, d: 4 };
  if (v === 'C|') return { n: 2, d: 2 };
  // Complex meters like (2+3)/8 or 2+3/8
  const m = /^\(?([\d+]+)\)?\s*\/\s*(\d+)/.exec(v);
  if (!m) return null;
  const n = m[1].split('+').reduce((a, b) => a + Number(b || 0), 0);
  const d = Number(m[2]);
  return n && d ? { n, d } : null;
}

function defaultUnit(meter) {
  if (meter && meter.n / meter.d < 0.75) return 1 / 16;
  return 1 / 8;
}

const fmt = (x) => {
  const r = Math.round(x * 100) / 100;
  return String(r).replace('.', ',');
};

/**
 * Measure each bar and return Danish warnings for bars whose length does not
 * fit the meter. A short first bar (pickup), a short last bar, and short bars
 * next to repeat signs are allowed. Multi-voice tunes are not checked.
 * @param {string} abc
 * @returns {string[]}
 */
export function checkBars(abc) {
  if (typeof abc !== 'string') return [];
  const lines = abc.replace(/\r\n?/g, '\n').split('\n');
  const kIdx = lines.findIndex((l) => /^K:/.test(l));
  if (kIdx < 0) return [];
  if (lines.some((l) => /^V:/.test(l) || /\[V:/.test(l))) return [];

  let meter = null;
  let unit = null;
  for (const l of lines.slice(0, kIdx + 1)) {
    if (/^M:/.test(l)) meter = parseMeter(l.slice(2));
    if (/^L:/.test(l)) {
      const f = parseFraction(l.slice(2));
      if (f) unit = f.n / f.d;
    }
  }
  if (unit == null) unit = defaultUnit(meter);

  const bars = []; // {dur, meter, repeatBefore, repeatAfter, skip}
  let cur = { dur: 0, meter, repeatBefore: false, skip: false };
  let tuplet = null; // {left, factor}
  let lastNoteLen = 0;
  let pendingBroken = null; // factor to apply to the next note

  const closeBar = (barText) => {
    const repeat = /:/.test(barText) || /\]/.test(barText) || /\[/.test(barText);
    if (cur.dur > 1e-9 || cur.skip) {
      cur.repeatAfter = repeat;
      bars.push(cur);
    }
    cur = { dur: 0, meter, repeatBefore: repeat, skip: false };
  };

  const readLength = (str, i) => {
    const m = /^(\d*)(\/*)(\d*)/.exec(str.slice(i));
    let len = 1;
    const num = m[1] ? Number(m[1]) : 1;
    if (m[2]) {
      const den = m[3] ? Number(m[3]) : 2 ** m[2].length;
      len = num / den;
    } else {
      len = num;
    }
    return { len, next: i + m[0].length };
  };

  const addNote = (len) => {
    let d = len * unit;
    if (pendingBroken) {
      d *= pendingBroken;
      pendingBroken = null;
    }
    if (tuplet) {
      d *= tuplet.factor;
      tuplet.left -= 1;
      if (tuplet.left <= 0) tuplet = null;
    }
    lastNoteLen = d;
    cur.dur += d;
  };

  for (const raw of lines.slice(kIdx + 1)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('%')) continue;
    if (FIELD_LINE.test(line)) {
      if (/^M:/.test(line)) {
        meter = parseMeter(line.slice(2));
        cur.meter = meter;
      }
      if (/^L:/.test(line)) {
        const f = parseFraction(line.slice(2));
        if (f) unit = f.n / f.d;
      }
      continue;
    }
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '%') break;
      if (c === '"') {
        const j = line.indexOf('"', i + 1);
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      if (c === '!' || c === '+') {
        const j = line.indexOf(c, i + 1);
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      if (c === '{') {
        const j = line.indexOf('}', i + 1);
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      if (c === '[' && /^[A-Za-z]:/.test(line.slice(i + 1, i + 3))) {
        const j = line.indexOf(']', i + 1);
        const field = line.slice(i + 1, j < 0 ? line.length : j);
        if (field.startsWith('M:')) {
          meter = parseMeter(field.slice(2));
          cur.meter = meter;
        }
        if (field.startsWith('L:')) {
          const f = parseFraction(field.slice(2));
          if (f) unit = f.n / f.d;
        }
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      if (c === '[' && /\d/.test(line[i + 1] || '')) {
        // Ending marker [1 / [2 at the start of a bar.
        i += 1;
        while (i < line.length && /[\d,.-]/.test(line[i])) i++;
        cur.repeatBefore = true;
        continue;
      }
      if (c === '|' || c === ':' || (c === '[' && line[i + 1] === '|') || c === ']') {
        let j = i;
        while (
          j < line.length &&
          (/[|:\]]/.test(line[j]) || (line[j] === '[' && /[\d|]/.test(line[j + 1] || '')))
        ) {
          j++;
        }
        // Endings written right after a bar line: |1, :|2
        while (j < line.length && /[\d]/.test(line[j]) ) j++;
        closeBar(line.slice(i, j));
        i = j;
        continue;
      }
      if (c === '[') {
        // Chord: duration is that of its first note, times any length after ']'.
        const j = line.indexOf(']', i + 1);
        const inner = line.slice(i + 1, j < 0 ? line.length : j);
        const first = /[=^_]*([A-Ga-gzx])[,']*(\d*\/*\d*)/.exec(inner);
        let len = 1;
        if (first) len = readLength(first[2], 0).len;
        i = j < 0 ? line.length : j + 1;
        const after = readLength(line, i);
        addNote(len * after.len);
        i = after.next;
        continue;
      }
      if (c === '(') {
        const m = /^\((\d)(?::(\d)?)?(?::(\d))?/.exec(line.slice(i));
        if (m) {
          const p = Number(m[1]);
          const compound = cur.meter && cur.meter.d === 8 && cur.meter.n % 3 === 0 && cur.meter.n > 3;
          const defaultQ = { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 }[p] ?? (compound ? 3 : 2);
          const q = m[2] ? Number(m[2]) : defaultQ;
          const r = m[3] ? Number(m[3]) : p;
          tuplet = { left: r, factor: q / p };
          i += m[0].length;
          continue;
        }
        i++;
        continue;
      }
      if (c === '>' || c === '<') {
        let n = 0;
        while (line[i] === c) {
          n++;
          i++;
        }
        const shift = 1 - 1 / 2 ** n; // > : 1.5/0.5, >> : 1.75/0.25
        const prev = c === '>' ? 1 + shift : 1 - shift;
        const next = c === '>' ? 1 - shift : 1 + shift;
        cur.dur += lastNoteLen * (prev - 1);
        pendingBroken = next;
        continue;
      }
      if (c === 'Z' || c === 'X') {
        // Multi-measure rest: count as whole bars, do not check.
        const after = readLength(line, i + 1);
        cur.skip = true;
        i = after.next;
        continue;
      }
      if (/[A-Ga-gzx]/.test(c)) {
        let j = i + 1;
        while (j < line.length && /[,']/.test(line[j])) j++;
        const { len, next } = readLength(line, j);
        addNote(len);
        i = next;
        continue;
      }
      // Accidentals, octave marks, ties, slurs, spaces, decorations, spacer y.
      i++;
    }
    // A line ending does not end a bar in ABC; keep accumulating.
  }
  if (cur.dur > 1e-9) {
    cur.repeatAfter = true;
    cur.last = true;
    bars.push(cur);
  }
  if (bars.length) bars[bars.length - 1].last = true;

  const problems = [];
  let number = 0;
  bars.forEach((bar, idx) => {
    const isPickup = idx === 0 && bar.meter && bar.dur < bar.meter.n / bar.meter.d - 1e-6;
    if (!isPickup) number++;
    if (bar.skip || !bar.meter) return;
    const expected = bar.meter.n / bar.meter.d;
    const diff = bar.dur - expected;
    if (Math.abs(diff) < 1e-6) return;
    if (diff < 0 && (idx === 0 || bar.last || bar.repeatBefore || bar.repeatAfter)) return;
    problems.push({ number: isPickup ? 0 : number, beats: bar.dur * bar.meter.d, expected: bar.meter.n, meter: bar.meter });
  });

  if (!problems.length) return [];
  const shown = problems.slice(0, 4).map(
    (p) =>
      `Takt ${p.number} ser ud til at have ${fmt(p.beats)} slag, men taktarten ${p.meter.n}/${p.meter.d} giver ${p.expected}. Tjek noderne i den takt.`,
  );
  if (problems.length > 4) shown.push(`… og ${problems.length - 4} takter mere med forkert længde.`);
  return shown;
}
