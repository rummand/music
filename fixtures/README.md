# OMR test fixtures

Ground-truth ABC files for testing how well the vision model reads sheet music,
plus images rendered from them. Only the first verse and only the melody.

| File | Key | Meter | Features |
|---|---|---|---|
| `mester-jakob.abc` | F major (1 flat) | 4/4 | four `|: :|` / `::` repeats, eighth notes, chords |
| `glade-jul.abc` | B♭ major (2 flats) | 3/4 | dotted rhythms, low B♭, slurred melisma (`_`), æøå |
| `lille-peter-edderkop.abc` | D major (2 sharps) | 6/8 | 2-eighth pickup, rests, apostrophe in lyrics |
| `hjulene-paa-bussen.abc` | G major (1 sharp) | 4/4 | 2-eighth pickup, word split across lines (`Hju-le-` / `ne`) |

For each song:

- `<name>.png`: clean songbook-style render (title, chords, lyrics; black on off-white; 1400 px wide).
- `<name>.photo.jpg`: "phone photo" made from the PNG: shear, 2–4° rotation, dark table edge,
  uneven lighting with a shadow band, warm tint, slight blur, JPEG quality 70.

Regenerate with `node test/render-fixtures.mjs` (needs Playwright/Chromium, abcjs and sharp;
see the header of that script). The output is deterministic.

## How accurate are the melodies?

The images are rendered from these ABC files, so the scoring in `test/omr-eval.mjs` stays
correct whatever the answer is. The question here is only whether a real songbook prints the
same notes. I wrote them from memory; nothing was checked against a printed source.

- **Mester Jakob**: confident. This is the standard Frère Jacques tune, and every phrase is
  repeated. The Danish words are common, but some versions end "Bim, bam, bum" instead of
  "Ding, dang, dong" (the backend's mock tune uses "Bim, bam, bum").
- **Glade jul** (Gruber 1818 / Ingemann): the melody is confident (Stille Nacht, written in
  3/4 with eighths). How the Danish syllables sit under the notes is less certain. To fit
  "en-gle da-le" I split the dotted half A of the second phrase into two dotted quarters. The
  chords are a simple I/IV/V7 setting and are not copied from Højskolesangbogen. Lyrics are
  verse 1 in the older spelling ("hvor de se, hvad for Gud er kønt").
- **Lille Peter Edderkop**: medium confidence. The contour is the Itsy-Bitsy-Spider tune,
  but the exact 6/8 rhythm is my own fit to the Danish words, and printed versions differ.
  The chords are approximate.
- **Hjulene på bussen**: medium confidence. The contour is the usual Wheels-on-the-Bus tune.
  The rhythm of the last line ("he-le ve-jen gen-nem by-en") is my own fit. The Danish words
  are the common kindergarten version.

The well-known Højskolesangbogen melodies by Weyse and Carl Nielsen ("I østen stiger solen
op", "Jeg ved en lærkerede", and others) were left out on purpose. I could not reproduce them
reliably enough to call them ground truth. If someone adds scans or transcriptions of those
pages, they would make better fixtures than these.

All four are public domain: traditional tunes, Gruber (d. 1863) and Ingemann (d. 1862).
