import assert from 'node:assert/strict';
import { test } from 'node:test';
import createHttpsProxyAgent from 'https-proxy-agent';
import type WebSocket from 'ws';
import {
  createOpenAIWebSocket,
  validOpenAIProxyUrl,
} from '../src/solo/openai-websocket';

test('OpenAI socket proxy is explicit and direct mode preserves socket options', () => {
  const options = {
    headers: { Authorization: 'Bearer synthetic-test-key' },
    handshakeTimeout: 15000,
  };
  const socket = {} as WebSocket;
  const endpoint = 'wss://api.openai.com/v1/realtime?model=fixture';
  assert.equal(
    createOpenAIWebSocket(endpoint, options, '', (url, received) => {
      assert.equal(url, endpoint);
      assert.equal(received, options);
      assert.equal('agent' in received, false);
      return socket;
    }),
    socket,
  );
  createOpenAIWebSocket(
    endpoint,
    options,
    'http://127.0.0.1:8080',
    (url, received: WebSocket.ClientOptions) => {
      assert.equal(url, endpoint);
      assert.equal(received.headers, options.headers);
      assert.equal(received.handshakeTimeout, options.handshakeTimeout);
      assert.ok(
        received.agent instanceof createHttpsProxyAgent.HttpsProxyAgent,
      );
      assert.equal(received.rejectUnauthorized, undefined);
      return socket;
    },
  );
  assert.equal('agent' in options, false);
});

test('proxy validation rejects unsupported schemes and non-root URLs without exposing credentials', () => {
  for (const value of [
    'http://127.0.0.1:8080',
    'https://proxy.example.com/',
    'http://fixture-user:fixture-password@proxy.example.com:8080',
  ])
    assert.equal(validOpenAIProxyUrl(value), true);
  for (const value of [
    '',
    'socks5://127.0.0.1:8080',
    'file:///proxy',
    'http://proxy.example.com/tunnel',
    'http://proxy.example.com/?key=fixture-password',
    'https://proxy.example.com/#fixture-password',
    'http://fixture-user:fixture-password@proxy.example.com/private',
  ])
    assert.equal(validOpenAIProxyUrl(value), false);
  assert.throws(
    () =>
      createOpenAIWebSocket(
        'wss://api.openai.com/v1/realtime',
        {},
        'http://fixture-user:fixture-password@proxy.example.com/private',
        () => {
          throw new Error('Must not create a socket with an invalid proxy');
        },
      ),
    { message: 'INVALID_OPENAI_PROXY_URL' },
  );
  assert.throws(
    () =>
      createOpenAIWebSocket(
        'wss://api.openai.com/v1/realtime',
        {},
        'http://fixture-user:fixture-password@proxy.example.com',
        () => {
          throw new Error('Proxy failure containing fixture-password');
        },
      ),
    { message: 'OPENAI_PROXY_CONNECTION_FAILED' },
  );
});
