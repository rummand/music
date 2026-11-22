// Client for mux, the owner's OpenAI-compatible LLM gateway.
// POST {base}/v1/chat/completions with a Bearer key. Never log the key or images.

export class MuxError extends Error {
  /**
   * @param {string} message Danish message safe to show to users
   * @param {number} status HTTP status to return to our client
   * @param {string} code short machine code for logs
   */
  constructor(message, status = 502, code = 'mux_error') {
    super(message);
    this.name = 'MuxError';
    this.status = status;
    this.code = code;
  }
}

/** Text of the first choice; handles string content and content-part arrays. */
export function contentOf(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

/**
 * Call mux chat completions.
 * @param {object} config from loadConfig()
 * @param {{model:string, messages:object[], maxTokens?:number, temperature?:number, timeoutMs?:number, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<{content:string, finishReason:string|null, usage:object|null}>}
 */
export async function chat(config, { model, messages, maxTokens = 4000, temperature = 0, timeoutMs, fetchImpl = fetch }) {
  const url = `${config.muxBaseUrl}/v1/chat/completions`;
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.muxApiKey}`,
        'x-mux-agent': 'noder',
        'x-mux-tags': 'noder',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: AbortSignal.timeout(timeoutMs ?? config.timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      console.warn(`[mux] ${model} timed out after ${Date.now() - started} ms`);
      throw new MuxError(
        'Det tog for lang tid at få svar fra AI-modellen. Prøv igen om lidt – eller prøv med et skarpere billede af kun én sang.',
        504,
        'timeout',
      );
    }
    console.warn(`[mux] ${model} network error: ${err?.message}`);
    throw new MuxError('Kunne ikke få forbindelse til AI-tjenesten. Prøv igen om lidt.', 502, 'network');
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    console.warn(`[mux] ${model} HTTP ${res.status} after ${Date.now() - started} ms: ${detail.replace(/\s+/g, ' ')}`);
    if (res.status === 401 || res.status === 403) {
      throw new MuxError('Serveren er ikke sat korrekt op til AI-tjenesten (adgangsnøgle). Kontakt den, der driver siden.', 502, 'auth');
    }
    if (res.status === 429) {
      throw new MuxError('AI-tjenesten har travlt lige nu. Vent et øjeblik, og prøv igen.', 503, 'busy');
    }
    if (res.status === 413) {
      throw new MuxError('Billedet er for stort til AI-tjenesten. Prøv med et mindre billede.', 413, 'too_large');
    }
    if (res.status === 504 || res.status === 408) {
      throw new MuxError('Det tog for lang tid at få svar fra AI-modellen. Prøv igen om lidt.', 504, 'timeout');
    }
    throw new MuxError('AI-tjenesten svarede med en fejl. Prøv igen om lidt.', 502, `http_${res.status}`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new MuxError('AI-tjenesten sendte et svar, der ikke kunne læses. Prøv igen.', 502, 'bad_json');
  }
  const content = contentOf(json);
  const finishReason = json?.choices?.[0]?.finish_reason ?? null;
  console.log(
    `[mux] ${model} ok in ${Date.now() - started} ms, finish=${finishReason}, tokens=${json?.usage?.completion_tokens ?? '?'}`,
  );
  return { content, finishReason, usage: json?.usage ?? null };
}
