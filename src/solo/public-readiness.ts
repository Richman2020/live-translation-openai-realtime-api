import { type SoloConfig, validPublicUrl } from './config';

export type PublicReadinessResult =
  | { status: 'ready'; code: 'PUBLIC_CALLBACK_READY' }
  | { status: 'unreachable'; code: 'PUBLIC_CALLBACK_UNREACHABLE' }
  | { status: 'wrong_service'; code: 'PUBLIC_CALLBACK_WRONG_SERVICE' }
  | { status: 'invalid_configuration'; code: 'PUBLIC_CALLBACK_URL_INVALID' };

const MAX_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 4096;
const UNREACHABLE: PublicReadinessResult = {
  status: 'unreachable',
  code: 'PUBLIC_CALLBACK_UNREACHABLE',
};
const WRONG_SERVICE: PublicReadinessResult = {
  status: 'wrong_service',
  code: 'PUBLIC_CALLBACK_WRONG_SERVICE',
};

/** Read-only callback probe. Never returns the URL, body, or upstream error. */
export async function checkPublicReadiness(
  config: Pick<SoloConfig, 'PUBLIC_BASE_URL'>,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<PublicReadinessResult> {
  if (!validPublicUrl(config.PUBLIC_BASE_URL))
    return {
      status: 'invalid_configuration',
      code: 'PUBLIC_CALLBACK_URL_INVALID',
    };

  // Use the same native fetch path as existing public setup probes. The OpenAI
  // proxy setting is intentionally scoped to OpenAI and is not applied here.
  const fetcher = options.fetch || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs))
    : MAX_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<PublicReadinessResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(UNREACHABLE);
    }, timeoutMs);
  });
  const probe = async (): Promise<PublicReadinessResult> => {
    try {
      const response = await fetcher(
        new URL('/api/health', config.PUBLIC_BASE_URL),
        { method: 'GET', redirect: 'error', signal: controller.signal },
      );
      if (response.status !== 200) {
        response.body?.cancel().catch(() => {});
        return UNREACHABLE;
      }
      if (!response.body) return WRONG_SERVICE;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Consume a bounded stream sequentially.
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BODY_BYTES) {
            reader.cancel().catch(() => {});
            return WRONG_SERVICE;
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return WRONG_SERVICE;
      }
      return body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (body as { appId?: unknown }).appId === 'ai-phone-solo'
        ? { status: 'ready', code: 'PUBLIC_CALLBACK_READY' }
        : WRONG_SERVICE;
    } catch {
      return UNREACHABLE;
    }
  };
  try {
    // The race bounds headers and body reads, even if an injected fetch ignores
    // AbortSignal. Native fetch is also aborted to release its network request.
    return await Promise.race([probe(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
