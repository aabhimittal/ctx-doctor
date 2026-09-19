// Anthropic Messages API over plain fetch. No SDK: this package has no runtime
// dependencies, and `fetch` has been global since Node 18.

const VERSION = '2023-06-01';
// ANTHROPIC_BASE_URL is honoured so the harness can be pointed at a gateway,
// a proxy, or — in this package's own tests — a local stub.
const endpoint = () => `${(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class ApiError extends Error {
  constructor(status, body) {
    super(`Anthropic API ${status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export function requireApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set. Ablation makes real API calls; export a key first.');
  }
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One non-streaming completion.
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, stopReason: string}>}
 */
export async function complete({
  apiKey, model, system, prompt, maxTokens = 2048, effort, timeoutMs = 120000, maxRetries = 4,
}) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (system) body.system = system;
  // `effort` is rejected by models that do not implement it, so callers pass it
  // only for models where models.js says it is supported.
  if (effort) body.output_config = { effort };

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt++ >= maxRetries) throw err;
      await sleep(backoff(attempt));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw new ApiError(res.status, text);
    }

    const json = await res.json();
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage: json.usage ?? {}, stopReason: json.stop_reason };
  }
}

function backoff(attempt) {
  const base = Math.min(16000, 500 * 2 ** attempt);
  return base + Math.random() * 250; // jitter, so parallel workers do not sync up
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
