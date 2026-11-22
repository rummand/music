// Express app. Exported as createApp(config) so tests can run it without listening.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import multer from 'multer';

import { loadConfig } from './config.js';
import { createRateLimiter } from './ratelimit.js';
import { normaliseImage, ImageError } from './image.js';
import { readSheet, editAbc } from './omr.js';
import { MuxError } from './mux.js';
import { MOCK_ABC, MOCK_TITLE, MOCK_READ_WARNING, MOCK_EDIT_EXPLANATION, sleep } from './mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const require = createRequire(import.meta.url);
const ABCJS_FILE = require.resolve('abcjs/dist/abcjs-basic-min.js');

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_ABC_CHARS = 50_000;
export const MAX_INSTRUCTION_CHARS = 2_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
});

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function handleFailure(res, err, what) {
  if (err instanceof MuxError || err instanceof ImageError) {
    return sendError(res, err.status, err.message);
  }
  console.error(`[${what}] unexpected error:`, err?.stack || err);
  return sendError(res, 500, 'Der skete en uventet fejl på serveren. Prøv igen.');
}

export function createApp(config = loadConfig()) {
  const app = express();
  // Railway puts one proxy in front of us; req.ip is then the client address from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // Short access log for API calls (no bodies, no keys).
  app.use('/api', (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms ip=${req.ip}`);
    });
    next();
  });

  const readLimiter = createRateLimiter({
    limit: config.readLimit,
    windowMs: config.rateWindowMs,
    message: 'Du har læst mange billeder på kort tid. Vent nogle minutter, og prøv igen.',
  });
  const editLimiter = createRateLimiter({
    limit: config.editLimit,
    windowMs: config.rateWindowMs,
    message: 'Du har bedt om mange ændringer på kort tid. Vent nogle minutter, og prøv igen.',
  });
  app.locals.limiters = { read: readLimiter, edit: editLimiter };
  app.locals.config = config;

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/api/config', (req, res) => res.json({ mock: config.mock }));

  app.get('/vendor/abcjs-basic-min.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript').sendFile(ABCJS_FILE);
  });

  app.post(
    '/api/read',
    readLimiter,
    (req, res, next) => {
      upload.single('image')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return sendError(res, 413, 'Billedet er for stort. Det må højst være 15 MB.');
          }
          if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
            return sendError(res, 400, 'Send præcis ét billede i feltet "image".');
          }
          return sendError(res, 400, 'Upload af billedet mislykkedes. Prøv igen.');
        }
        return sendError(res, 400, 'Upload af billedet mislykkedes. Send billedet som multipart/form-data i feltet "image".');
      });
    },
    async (req, res) => {
      if (!req.file) return sendError(res, 400, 'Der blev ikke sendt noget billede. Vælg et billede af noderne.');
      try {
        const img = await normaliseImage(req.file.buffer);
        if (config.mock) {
          await sleep(config.mockDelayMs);
          return res.json({ abc: MOCK_ABC, title: MOCK_TITLE, warnings: [MOCK_READ_WARNING] });
        }
        console.log(`[read] image ${req.file.size} bytes -> ${img.width}x${img.height} jpeg ${img.buffer.length} bytes`);
        const out = await readSheet(config, img.buffer);
        return res.json(out);
      } catch (err) {
        return handleFailure(res, err, 'read');
      }
    },
  );

  app.post('/api/edit', editLimiter, express.json({ limit: '256kb' }), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const abc = typeof body.abc === 'string' ? body.abc : '';
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    if (!abc.trim()) return sendError(res, 400, 'Der mangler noder (abc) at ændre.');
    if (!instruction) return sendError(res, 400, 'Skriv, hvad du gerne vil have ændret.');
    if (abc.length > MAX_ABC_CHARS) return sendError(res, 413, 'Noderne er for lange til at blive ændret.');
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      return sendError(res, 400, `Beskrivelsen er for lang (højst ${MAX_INSTRUCTION_CHARS} tegn).`);
    }
    try {
      if (config.mock) {
        await sleep(Math.min(config.mockDelayMs, 500));
        return res.json({ abc, explanation: MOCK_EDIT_EXPLANATION });
      }
      return res.json(await editAbc(config, abc, instruction));
    } catch (err) {
      return handleFailure(res, err, 'edit');
    }
  });

  app.use('/api', (req, res) => sendError(res, 404, 'Ukendt adresse.'));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // Errors from body parsing etc.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return sendError(res, 413, 'Forespørgslen er for stor.');
    if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'Forespørgslen er ikke gyldig JSON.');
    console.error('[app] error:', err?.stack || err);
    return sendError(res, err?.status && err.status < 500 ? err.status : 500, 'Der skete en uventet fejl på serveren. Prøv igen.');
  });

  return app;
}
