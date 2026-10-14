import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';

import { assertAliyunPlanBConfig } from './aliyun-planb-config';
import type {
  AliyunPlanBConfig,
  PlanBSocketFactory,
} from './aliyun-planb-types';
import { validOpenAIProxyUrl } from './openai-websocket';

function proxyAgent(config: AliyunPlanBConfig) {
  const proxy =
    config.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!proxy) return undefined;
  if (!validOpenAIProxyUrl(proxy)) throw new Error('PLAN_B_PROXY_INVALID');
  try {
    return createHttpsProxyAgent(proxy);
  } catch {
    throw new Error('PLAN_B_PROXY_INVALID');
  }
}

/** Called only for an explicitly selected call. Never changes proxy or TLS rules. */
export function createPlanBWebSocket(
  config: AliyunPlanBConfig,
  factory: PlanBSocketFactory = (url, settings) => new WebSocket(url, settings),
): WebSocket {
  assertAliyunPlanBConfig(config);
  try {
    return factory(config.webSocketUrl, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
      agent: proxyAgent(config),
    });
  } catch {
    throw new Error('PLAN_B_SOCKET_CREATE_FAILED');
  }
}

/** Fixed endpoint streaming fetch using existing HTTPS proxy support. No retries,
 * redirect following, credential discovery or direct-route fallback. */
export function createPlanBFetch(
  config: AliyunPlanBConfig,
  request: typeof httpsRequest = httpsRequest,
): typeof fetch {
  assertAliyunPlanBConfig(config);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (
      String(input) !== config.translationUrl ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new Error('PLAN_B_HTTP_REQUEST_INVALID');
    if (init.signal?.aborted) throw new Error('PLAN_B_HTTP_ABORTED');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const agent = proxyAgent(config);
    return new Promise<Response>((resolve, reject) => {
      try {
        const outgoing = request(
          config.translationUrl,
          {
            method: 'POST',
            headers,
            agent,
            signal: init.signal ?? undefined,
          },
          (incoming) => {
            try {
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(incoming.headers))
                if (value !== undefined)
                  responseHeaders.set(
                    name,
                    Array.isArray(value) ? value.join(', ') : value,
                  );
              resolve(
                new Response(Readable.toWeb(incoming) as ReadableStream, {
                  status: incoming.statusCode ?? 502,
                  headers: responseHeaders,
                }),
              );
            } catch {
              incoming.destroy();
              reject(new Error('PLAN_B_HTTP_FAILED'));
            }
          },
        );
        outgoing.on('error', () => reject(new Error('PLAN_B_HTTP_FAILED')));
        outgoing.end(init.body);
      } catch {
        reject(new Error('PLAN_B_HTTP_FAILED'));
      }
    });
  }) as typeof fetch;
}
