// HTTP integration tests: start server/index.js as a child process on a free port.
//  1. mock mode (MUX_MOCK=1): all four endpoints + upload errors
//  2. "real" mode against a fake mux gateway (local HTTP server), to exercise
//     the full read/edit path: prompt -> model answer -> extractAbc/validateAbc -> JSON.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures');

function imageForm(buf, type = 'image/png', name = 'noder.png', field = 'image') {
  const fd = new FormData();
  fd.append(field, new Blob([buf], { type }), name);
  return fd;
}

async function json(res) {
  const ct = res.headers.get('content-type') || '';
  assert.match(ct, /application\/json/, `expected JSON, got ${ct} (HTTP ${res.status})`);
  return res.json();
}

const PNG = fs.readFileSync(path.join(FIX, 'mester-jakob.png'));

describe('mock mode', () => {
  let srv;
  before(async () => {
    srv = await startServer({ MUX_MOCK: '1', MUX_API_KEY: '' });
  });
  after(async () => {
    await srv?.stop();
  });

  test('GET /health', async () => {
    const r = await fetch(`${srv.base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await json(r), { ok: true });
  });

  test('GET /api/config reports mock', async () => {
    const r = await fetch(`${srv.base}/api/config`);
    assert.equal(r.status, 200);
    assert.deepEqual(await json(r), { mock: true });
  });

  test('POST /api/read with a PNG returns the mock ABC', async () => {
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(PNG) });
    assert.equal(r.status, 200);
    const b = await json(r);
    assert.equal(typeof b.abc, 'string');
    assert.match(b.abc, /^X:/m);
    assert.match(b.abc, /^K:/m);
    assert.equal(typeof b.title, 'string');
    assert.ok(Array.isArray(b.warnings));
  });

  test('POST /api/read with a JPEG photo works too', async () => {
    const jpg = fs.readFileSync(path.join(FIX, 'glade-jul.photo.jpg'));
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(jpg, 'image/jpeg', 'foto.jpg') });
    assert.equal(r.status, 200);
    assert.ok((await json(r)).abc);
  });

  test('POST /api/read without a file -> 400 JSON', async () => {
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: new FormData() });
    assert.equal(r.status, 400);
    assert.equal(typeof (await json(r)).error, 'string');
  });

  test('POST /api/read with a non-image file -> 4xx JSON', async () => {
    const txt = Buffer.from('this is definitely not a picture of sheet music\n'.repeat(50));
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(txt, 'image/png', 'fake.png') });
    assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
    assert.equal(typeof (await json(r)).error, 'string');
  });

  test('POST /api/read with an oversize upload (16 MB) -> 413 JSON', async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 0xff);
    PNG.copy(big, 0, 0, Math.min(PNG.length, 64));
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(big) });
    assert.equal(r.status, 413);
    assert.equal(typeof (await json(r)).error, 'string');
  });

  test('POST /api/read with a wrong field name -> 400 JSON', async () => {
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(PNG, 'image/png', 'x.png', 'photo') });
    assert.equal(r.status, 400);
    assert.equal(typeof (await json(r)).error, 'string');
  });

  test('POST /api/edit returns abc + explanation', async () => {
    const abc = fs.readFileSync(path.join(FIX, 'mester-jakob.abc'), 'utf8');
    const r = await fetch(`${srv.base}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ abc, instruction: 'Ret takt 2 til halvnoder' }),
    });
    assert.equal(r.status, 200);
    const b = await json(r);
    assert.equal(typeof b.abc, 'string');
    assert.match(b.abc, /K:/);
    assert.equal(typeof b.explanation, 'string');
  });

  test('POST /api/edit with missing fields / bad JSON -> 400 JSON', async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ abc: 'X:1\nK:C\nC', instruction: '' }), '{not json']) {
      const r = await fetch(`${srv.base}/api/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(r.status, 400, body);
      assert.equal(typeof (await json(r)).error, 'string');
    }
  });

  test('unknown /api route -> 404 JSON', async () => {
    const r = await fetch(`${srv.base}/api/nope`);
    assert.equal(r.status, 404);
    assert.equal(typeof (await json(r)).error, 'string');
  });

  test('GET / serves the frontend (if present)', { skip: !fs.existsSync(path.join(ROOT, 'public', 'index.html')) }, async () => {
    const r = await fetch(`${srv.base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });
});

// ---------------------------------------------------------------------------
// Fake mux: an OpenAI-compatible endpoint answering with canned model output.

describe('real mode against a fake mux gateway', () => {
  let srv;
  let mux;
  const calls = [];
  let nextAnswers = [];
  const truth = fs.readFileSync(path.join(FIX, 'glade-jul.abc'), 'utf8').trim();

  before(async () => {
    mux = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {}
        calls.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        const content = nextAnswers.length ? nextAnswers.shift() : 'NOT_MUSIC';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 10 } }));
      });
    });
    await new Promise((r) => mux.listen(0, '127.0.0.1', r));
    srv = await startServer({
      MUX_MOCK: '',
      MUX_API_KEY: 'test-key-not-real',
      MUX_BASE_URL: `http://127.0.0.1:${mux.address().port}`,
    });
  });
  after(async () => {
    await srv?.stop();
    await new Promise((r) => mux?.close(r));
  });

  test('/api/config reports mock:false', async () => {
    assert.deepEqual(await json(await fetch(`${srv.base}/api/config`)), { mock: false });
  });

  test('/api/read: chatty fenced answer -> clean ABC, title, image sent as data URI', async () => {
    calls.length = 0;
    nextAnswers = [`Tonearten er B-dur (to b'er), 3/4.\n\n\`\`\`abc\n${truth}\n\`\`\`\n\nJeg er usikker på akkorderne.`];
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(fs.readFileSync(path.join(FIX, 'glade-jul.png'))) });
    const b = await json(r);
    assert.equal(r.status, 200, JSON.stringify(b) + '\n' + srv.log().slice(-2000));
    assert.equal(b.title, 'Glade jul');
    assert.equal(b.abc.trim(), truth);
    assert.ok(Array.isArray(b.warnings));
    assert.equal(calls.length, 1, 'expected exactly one model call for a valid answer');
    assert.equal(calls[0].url, '/v1/chat/completions');
    assert.equal(calls[0].auth, 'Bearer test-key-not-real');
    const parts = calls[0].body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const img = parts.find((p) => p.type === 'image_url');
    assert.match(img.image_url.url, /^data:image\/jpeg;base64,/);
  });

  test('/api/read: invalid first answer is retried once', async () => {
    calls.length = 0;
    nextAnswers = ['Here are the notes: C D E F', `\`\`\`abc\n${truth}\n\`\`\``];
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(PNG) });
    const b = await json(r);
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(calls.length, 2);
    assert.equal(b.title, 'Glade jul');
  });

  test('/api/read: NOT_MUSIC -> 422 JSON error', async () => {
    nextAnswers = ['NOT_MUSIC'];
    const r = await fetch(`${srv.base}/api/read`, { method: 'POST', body: imageForm(PNG) });
    assert.equal(r.status, 422);
    assert.equal(typeof (await json(r)).error, 'string');
  });

  test('/api/edit: returns edited ABC and explanation', async () => {
    const edited = truth.replace('K:Bb', 'K:C');
    nextAnswers = [`Jeg har ændret tonearten til C-dur.\n\n\`\`\`abc\n${edited}\n\`\`\``];
    const r = await fetch(`${srv.base}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ abc: truth, instruction: 'Skift til C-dur' }),
    });
    const b = await json(r);
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.match(b.abc, /^K:C$/m);
    assert.match(b.explanation, /C-dur/);
  });
});
