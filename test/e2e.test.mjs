// Browser end-to-end test (Playwright + headless Chromium) against the mock server.
// Skips itself when public/index.html or Playwright/Chromium are not available.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from './helpers/server.mjs';

const FIX = path.join(ROOT, 'fixtures');

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {}

const skip = !fs.existsSync(path.join(ROOT, 'public', 'index.html'))
  ? 'public/index.html missing'
  : !chromium
    ? 'playwright not installed'
    : false;

// A C-major tune: altsax (+9 semitones) must show it in A major.
const C_MAJOR = `X:1
T:Skala i C
M:4/4
L:1/4
K:C
"C"C D E F | "G"G A B c | "F"c B A G | "C"F E D C |]
w: do re mi fa sol la ti do do ti la sol fa mi re do
`;

describe('e2e: upload, render, transpose for alto sax', { skip }, () => {
  let srv;
  let browser;

  before(async () => {
    srv = await startServer({ MUX_MOCK: '1', MUX_API_KEY: '' });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  async function openAndUpload(page, file) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(srv.base + '/');
    await page.locator('#file-input').setInputFiles(path.join(FIX, file));
    await page.locator('#song').waitFor({ state: 'visible', timeout: 20_000 });
    // abcjs draws the staff into #paper as an <svg>; wait for at least one note head.
    await page.locator('#paper svg').first().waitFor({ state: 'attached', timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('#paper svg .abcjs-note').length > 3, null, { timeout: 20_000 });
    return errors;
  }

  async function keyInfoAfter(page, instrumentId) {
    await page.locator(`#instruments [data-id="${instrumentId}"]`).click();
    await page.waitForFunction(
      (id) => document.querySelector(`#instruments [data-id="${id}"]`)?.getAttribute('aria-checked') === 'true',
      instrumentId,
    );
    return (await page.locator('#key-info').textContent()).trim();
  }

  test('mock read (Mester Jakob, F major): klaver shows F-dur, altsax shows D-dur', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    try {
      const errors = await openAndUpload(page, 'mester-jakob.photo.jpg');
      assert.equal(await page.locator('#mock-notice').isVisible(), true, 'mock notice should be visible');
      assert.match(await page.locator('#song-title').inputValue(), /Mester Jakob/);

      const klaver = await keyInfoAfter(page, 'klaver');
      assert.match(klaver, /F-dur/, klaver);
      const notesKlaver = await page.locator('#paper svg').first().innerHTML();

      const sax = await keyInfoAfter(page, 'altsax');
      assert.match(sax, /D-dur/, sax);
      assert.match(sax, /F-dur/, 'should mention the original key too: ' + sax);
      const notesSax = await page.locator('#paper svg').first().innerHTML();
      assert.notEqual(notesSax, notesKlaver, 'the staff should be redrawn transposed');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('C major tune: klaver shows C-dur, altsax shows A-dur (3 sharps drawn)', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    try {
      // Serve a C-major answer instead of the fixed mock tune.
      await page.route('**/api/read', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ abc: C_MAJOR, title: 'Skala i C', warnings: [] }) }),
      );
      const errors = await openAndUpload(page, 'mester-jakob.png');

      const klaver = await keyInfoAfter(page, 'klaver');
      assert.match(klaver, /C-dur/, klaver);
      const sharpsKlaver = await page.locator('#paper svg .abcjs-key-signature path').count();

      const sax = await keyInfoAfter(page, 'altsax');
      assert.match(sax, /A-dur/, sax);
      const sharpsSax = await page.locator('#paper svg .abcjs-key-signature path').count();
      assert.ok(sharpsSax > sharpsKlaver, `expected key-signature accidentals to appear (${sharpsKlaver} -> ${sharpsSax})`);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});
