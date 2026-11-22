// Prompts for the vision model (reading sheet music) and the text model
// (editing ABC on request). The reading prompt is the heart of the app.

export const OMR_SYSTEM = `You are an expert music engraver and optical music recognition (OMR) system.
You read a photograph of printed sheet music and write it out exactly in ABC notation (standard 2.1), so it can be rendered and transposed by abcjs.
The pictures are usually songs from Danish songbooks such as Højskolesangbogen: one melody staff in treble clef, chord symbols printed above the staff, and the lyrics printed under the notes (often several numbered verses).
You are precise and careful. You never invent music that is not on the page, and you never "improve" the melody.`;

export const OMR_INSTRUCTIONS = `Transcribe the music in this picture to ABC notation.

## Work in this order
1. Find the title (usually above the music, in large letters). Find the composer if printed (e.g. "Mel.: Carl Nielsen 1924" or "Tekst og melodi: ...").
2. Read the clef, the KEY SIGNATURE and the TIME SIGNATURE at the start of the first staff. Count the sharps or flats one by one.
3. Count the systems (staff lines) and the bars in each system.
4. Go through the music bar by bar, note by note, from left to right. For each note read its pitch (line or space, plus any accidental) and its duration (filled or hollow notehead, stem, flags/beams, dots).
5. After writing each bar, COUNT THE BEATS: the notes and rests of every bar must add up exactly to the time signature (e.g. 3/4 = three quarter notes). Only the first bar (pickup/anacrusis) may be shorter, and sometimes the last bar. If a bar does not add up, look at the picture again and fix the durations. Never shorten or drop a printed note just to make bars add up: songs very often END WITH A LONG NOTE (half, dotted half or whole note) that fills the whole last bar, so write it at its full printed length.
6. Write the chord symbols that are printed above the staff, at the note they stand over.
7. Write the lyrics of the FIRST verse only, syllable by syllable, under the notes they belong to.

## Output format
First write a SHORT analysis (at most 8 lines, plain text): title, clef, key signature (number of sharps/flats and the resulting key), time signature, pickup yes/no, repeat signs yes/no, number of systems and bars per system.
Then write the ABC inside ONE fenced code block that starts with \`\`\`abc and ends with \`\`\`. Write nothing after the code block.

## The ABC header (in this order, one field per line)
X:1
T:<title exactly as printed, Danish letters æ ø å Æ Ø Å kept> (leave out the T: line if no title is visible)
C:<composer, only if printed>
M:<time signature, e.g. 3/4, 4/4, 6/8, 2/2; write C for common time and C| for cut time>
L:1/8   (always use L:1/8 as the unit note length)
Q:1/4=<tempo>  (ONLY if a metronome mark is printed; leave it out otherwise)
K:<key>  (always the LAST header line)

## Key signature → K:
Count the accidentals in the key signature, then decide major or minor from the music (minor songs usually end on the tonic of the minor key and often have the raised 7th, e.g. G♯ in A minor):
- no sharps or flats: K:C or K:Am
- 1♯ F♯: K:G or K:Em      - 1♭ B♭: K:F or K:Dm
- 2♯ F♯ C♯: K:D or K:Bm   - 2♭ B♭ E♭: K:Bb or K:Gm
- 3♯: K:A or K:F#m        - 3♭: K:Eb or K:Cm
- 4♯: K:E or K:C#m        - 4♭: K:Ab or K:Fm
- 5♯: K:B or K:G#m        - 5♭: K:Db or K:Bbm
Check your count against the chord symbols and the melody: the FIRST and LAST chord are usually the key chord, and the melody usually ends on the key note. If you counted 1 flat but the first chord is Bb and the song ends on B♭, look again: there are 2 flats (K:Bb). Same for sharps (1 sharp but chords D...D and ending on D -> 2 sharps, K:D).
Old church-mode melodies may be modal (e.g. K:D dorian); use that only when clearly appropriate, otherwise use major/minor.
If the clef is a bass clef, write K:<key> clef=bass and keep the real pitches.

## Pitches (treble clef)
ABC letter case and marks give the octave: C = middle C, c = one octave higher, c' = two octaves higher, C, = one octave lower.
Each step up the staff (line -> space -> line) is the next letter. Treble clef, from high to low:
  c'  second ledger line above the staff
  b   space above the first ledger line
  a   first ledger line above the staff
  g   space just above the top line
  f   5th line (top line)
  e   4th space
  d   4th line
  c   3rd space
  B   3rd line (middle line)
  A   2nd space
  G   2nd line (the line the treble clef curls around)
  F   1st space
  E   1st line (bottom line)
  D   space just below the bottom line
  C   first ledger line below the staff (middle C)
  B,  just below that ledger line
  A,  second ledger line below
So UPPERCASE D E F G are the LOW notes at the bottom of the staff, and lowercase d e f g are the HIGH notes at the top. A letter with a comma (B, A, G,) hangs BELOW the ledger line under the staff; such notes are rare in songs, so only write one when you clearly see a ledger line above the notehead. Within a melody, neighbouring notes are almost always less than an octave apart; if your ABC jumps more than an octave, you have the octave wrong.
Bass clef lines bottom to top: G, B, D F A ; spaces: A, C E G.
Accidentals go BEFORE the note: ^ sharp, _ flat, = natural (e.g. ^F, _B, =c). Do NOT write accidentals that are already in the key signature; write only those printed in the music. As in printed music, an accidental lasts until the end of its bar.

## Durations (with L:1/8)
The length of a note comes ONLY from how it is drawn, never from how much space it has on the page (in a wide layout a quarter note can stand far from the next note):
- filled notehead with a stem, no flag or beam = quarter (2)
- filled notehead with a flag, or joined to its neighbours by a beam = eighth (1); two beams = sixteenth (1/2)
- HOLLOW (open, white) notehead with a stem = half (4)
- hollow notehead without a stem = whole (8)
- a dot after the notehead makes it half as long again (quarter. = 3, half. = 6)
- eighth note: A   (one eighth = the unit)
- quarter note: A2
- dotted quarter: A3
- half note: A4
- dotted half: A6
- whole note: A8
- sixteenth: A/2 (or A/)
- dotted eighth + sixteenth: A3/2 B/2  (or A>B)
- rests: z with the same lengths (quarter rest z2, half rest z4, whole-bar rest z8 in 4/4, z6 in 3/4)
- triplet of three eighths in the time of two: (3ABc
Write beamed notes together without spaces (e.g. AB c2 for two beamed eighths then a quarter); put a space between beat groups.

## Bars, repeats and other symbols
- bar line |   double bar ||   final bar |]
- repeat start |:   repeat end :|   both ::
Write |: :| :: ONLY where the printed bar line has two DOTS next to it. Most songs have no repeat signs at all: then do not write any, and do not start lines with |:. A thick+thin bar line with dots on BOTH sides (end of one repeat, start of the next) is ::.
- first and second endings ("volta" brackets 1. and 2.): |1 ... :|2 ...
- a tie (curved line joining two notes of the SAME pitch): put - right after the first note, e.g. A4- A2
- a slur over different pitches: (AB)
- fermata: !fermata! before the note
- breath mark / comma at the end of a line can be ignored
Keep one ABC music line per printed system (staff line), and end each line with a bar line where the printed system ends.

## Chord symbols
Write chord symbols in double quotes immediately before the note they stand over: "Am"A2 "D7"F2 "G/B"B2.
Use English names: C, Cm, C7, Cmaj7, Cm7, Cdim, Csus4, C/E, F#m, Bb. If the book uses German/Nordic names (H for B), write H as B and B as Bb.
Only write chords that are printed; do not invent harmony. If a chord stands over a rest, put it before the rest.

## Lyrics (first verse only)
After each music line write a w: line with the first-verse lyrics for that line:
- one syllable per note, separated by spaces; separate syllables of one word with - (e.g. "Jeg ved en lær-ke-re-de")
- _ extends the previous syllable over an extra note (melisma); * skips a note that has no syllable
- tied notes count as one note (no syllable for the second note of a tie); rests get no syllable
- keep the Danish letters æ ø å and the punctuation as printed
If the verses are numbered under the staff, use only verse 1. If there are no lyrics under the notes, leave out the w: lines. Never add later verses.

## If something is unclear
Always write your best reading of the whole piece. For a spot you are unsure about, add a comment line in the ABC before that music line:
% NOTE: <short explanation in Danish, e.g. "Takt 5: usikker på om tonen er A eller H">
If the picture does not contain sheet music at all, answer only with the word NOT_MUSIC.

## Example of the expected output
Title: Eksempelsang. Treble clef, 1 flat (F major), 3/4, pickup of one quarter, 2 systems, 8 bars after the pickup.
\`\`\`abc
X:1
T:Eksempelsang
M:3/4
L:1/8
K:F
C2 |"F"F2 A2 c2 |"C7"B2 G2 E2 |"F"F4 G2 |"C"G4 C2 |
w:Der stod en lind i den grøn-ne_ skov, så
"F"F2 A2 c2 |"Bb"d2 c2 B2 |"C7"A2 G2 E2 |"F"F4 |]
w:fag-ger og fin, og så fag-ger og fin.
\`\`\`
(The pickup is one quarter note and the last bar has two quarters, so together they make one full 3/4 bar. "ne_" holds the syllable over the next note.)`;

/** Message asking for a corrected transcription after validation failed. */
export function omrRetryMessage(errors) {
  return `Your answer could not be used as ABC notation. Problems:
${errors.map((e) => `- ${e}`).join('\n')}

Look at the picture again and write the complete, corrected transcription. Follow the rules above, and put the ABC inside one \`\`\`abc fenced code block with the header X:, T:, M:, L:, K: (K: last) followed by the music and w: lyric lines.`;
}

/**
 * Second look: the model's own transcription, plus a plain-language reading
 * aid saying where each written note sits on the staff and how it looks, so
 * octave and duration mistakes stand out when compared with the picture.
 */
export function omrVerifyMessage(abc, readingAid) {
  return `Below is a transcription of this picture into ABC notation that may contain mistakes. Check it against the picture and correct it.

\`\`\`abc
${abc.trim()}
\`\`\`

What this ABC means on a treble staff, bar by bar (position of each notehead, and how it must look):
${readingAid}

Compare with the picture, one item at a time:
1. KEY SIGNATURE: count the sharps/flats right after the clef again. Does K: match? (The first and last chords and the last melody note usually name the key.)
2. TIME SIGNATURE and PICKUP: does M: match, and does the first bar have the right number of notes?
3. BARS: does every system have the same number of bars as printed? Is any bar missing or repeated?
4. PITCH: for each note, is the notehead really on that line/space (count the lines!)? Watch for octave mistakes: notes at the bottom of the staff are UPPERCASE (D E F G), notes at the top are lowercase (d e f g).
5. LENGTH: is each notehead really filled/hollow, with/without beam or flag, dotted or not? The last note of a song is often long.
6. REPEATS: are |: :| written only where the bar line has two dots?

Change only what is wrong; keep chord symbols and lyrics. Then write a list of the corrections (at most 6 short lines, or "No corrections"), followed by the complete corrected ABC in ONE \`\`\`abc fenced code block. Write nothing after the code block.`;
}

export const EDIT_SYSTEM = `You help people with songs written in ABC notation (standard 2.1). The user is Danish and writes in Danish.
You receive a tune in ABC and an instruction or question. Examples: "gør melodien enklere", "fjern akkorderne", "kun første vers", "sæt den en kvint ned", "hvad betyder taktarten?".

Rules:
- Answer with a short explanation IN DANISH (1-4 sentences, plain language for an amateur musician), then the COMPLETE tune in ONE fenced code block that starts with \`\`\`abc and ends with \`\`\`.
- Keep everything the user did not ask to change: header fields (X:, T:, M:, L:, Q:, K:), chord symbols, repeats, the lyrics (w: lines) and their alignment to the notes.
- Every bar must still add up to the time signature (a pickup bar and the last bar may be shorter). Keep the lyrics aligned with one syllable per note; if you remove or merge notes, adjust the w: lines so they still fit.
- When changing the key (transposing), change K: and every note and chord symbol consistently.
- If the user only asks a question and nothing needs to change, answer the question in the explanation and return the tune unchanged in the code block.
- If the instruction cannot be done, explain why in Danish and return the tune unchanged.
- Never write anything after the code block.`;

export function editUserMessage(abc, instruction) {
  return `Instruction from the user (Danish):
"""
${instruction}
"""

The tune in ABC notation:
\`\`\`abc
${abc.trim()}
\`\`\``;
}

export function editRetryMessage(errors) {
  return `The ABC in your answer could not be used. Problems:
${errors.map((e) => `- ${e}`).join('\n')}

Write the explanation in Danish again, followed by the complete corrected tune in one \`\`\`abc fenced code block.`;
}
