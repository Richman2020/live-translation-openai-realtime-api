import createHttpsProxyAgent from 'https-proxy-agent';
import WebSocket from 'ws';

export function validOpenAIProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      Boolean(url.hostname) &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** ws supplies createConnection, so it needs an explicit proxy agent. */
export function createOpenAIWebSocket<Options extends WebSocket.ClientOptions>(
  url: string,
  options: Options,
  proxyUrl = '',
  createSocket: (address: string, settings: Options) => WebSocket = (
    address,
    settings,
  ) => new WebSocket(address, settings),
): WebSocket {
  if (!proxyUrl) return createSocket(url, options);
  if (!validOpenAIProxyUrl(proxyUrl))
    throw new Error('INVALID_OPENAI_PROXY_URL');
  try {
    return createSocket(url, {
      ...options,
      agent: createHttpsProxyAgent(proxyUrl),
    });
  } catch {
    // Proxy URLs may contain authentication. Do not expose parser/agent errors.
    throw new Error('OPENAI_PROXY_CONNECTION_FAILED');
  }
}
