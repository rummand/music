// Reads settings from the environment. Never log the API key.

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

function int(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  const apiKey = (env.MUX_API_KEY || '').trim();
  return {
    port: int(env.PORT, 3000),
    muxBaseUrl: (env.MUX_BASE_URL || 'https://mux-production-0b55.up.railway.app').trim().replace(/\/+$/, ''),
    muxApiKey: apiKey,
    visionModel: (env.MUX_VISION_MODEL || 'vision').trim(),
    textModel: (env.MUX_TEXT_MODEL || 'smart').trim(),
    // Mock mode when asked for, or when there is no key to call mux with.
    mock: truthy(env.MUX_MOCK) || !apiKey,
    mockDelayMs: int(env.MUX_MOCK_DELAY_MS, 1000),
    timeoutMs: int(env.MUX_TIMEOUT_MS, 120_000),
    // Requests per IP per 10 minutes.
    readLimit: int(env.RATE_LIMIT_READ, 20),
    editLimit: int(env.RATE_LIMIT_EDIT, 60),
    rateWindowMs: 10 * 60 * 1000,
  };
}
