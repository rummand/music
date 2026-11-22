// Fixed answers for mock mode (MUX_MOCK=1, or no MUX_API_KEY).
// "Mester Jakob" (traditional, public domain) in F major with chords and Danish lyrics.

export const MOCK_ABC = `X:1
T:Mester Jakob
C:Traditionel
M:4/4
L:1/8
Q:1/4=100
K:F
"F"F2 G2 A2 F2 | F2 G2 A2 F2 | A2 B2 c4 | A2 B2 c4 |
w:Mes-ter Ja-kob, mes-ter Ja-kob, so-ver du? So-ver du?
"F"cd cB A2 F2 | cd cB A2 F2 | F2 "C"C2 "F"F4 | F2 "C"C2 "F"F4 |]
w:Hø-rer du ej klok-ken? Hø-rer du ej klok-ken? Bim, bam, bum. Bim, bam, bum.
`;

export const MOCK_TITLE = 'Mester Jakob';

export const MOCK_READ_WARNING = 'Demo-tilstand: Serveren er ikke forbundet til AI-modellen, så du ser et fast eksempel ("Mester Jakob") i stedet for dit billede.';

export const MOCK_EDIT_EXPLANATION = 'Demo-tilstand: Serveren er ikke forbundet til AI-modellen, så noderne er ikke ændret.';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
