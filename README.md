# music

**Noder** — tag et billede af noder (fx fra Højskolesangbogen), og få dem vist online, transponeret til dit instrument.

Live: https://noder-production.up.railway.app (ingen login)

## Sådan virker det

1. Upload eller fotografér en nodeside.
2. Serveren sender billedet til mux' `vision`-rute, som skriver noderne om til ABC-notation.
3. Siden tegner noderne med [abcjs](https://www.abcjs.net/) og kan
   - transponere til fx altsax (Es, +9 halvtoner), tenorsax, klarinet/trompet (B), horn (F) eller frit valg,
   - afspille melodien i koncerttone,
   - rette noderne direkte eller med en beskrivelse ("gør melodien enklere"), som går gennem mux' `smart`-rute.

Sange gemmes kun i browseren (localStorage).

## Kør lokalt

```bash
npm install
npm run dev          # demo-tilstand: ingen mux-nøgle nødvendig
MUX_API_KEY=mux-sk-… npm start
npm test
```

Indstillinger: se `.env.example` (`MUX_BASE_URL`, `MUX_API_KEY`, `MUX_VISION_MODEL`, `MUX_TEXT_MODEL`, `PORT`, rate limits).

## Kvalitet

`node test/omr-eval.mjs <url>` læser billederne i `fixtures/` og sammenligner med facit (toneart, taktart, toner, tekst).

## Deploy

Railway-projekt `music`, service `noder`, deployer automatisk fra GitHub-branchen. Variabler: `MUX_API_KEY` (tenant `music` i mux), `MUX_BASE_URL`, `PORT=3000`.
