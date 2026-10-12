import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { test } from 'node:test';
import { checkPublicReadiness } from '../src/solo/public-readiness';

const config = { PUBLIC_BASE_URL: 'https://private-callback.example' };
const ready = { status: 'ready', code: 'PUBLIC_CALLBACK_READY' };
const unreachable = {
  status: 'unreachable',
  code: 'PUBLIC_CALLBACK_UNREACHABLE',
};
const wrongService = {
  status: 'wrong_service',
  code: 'PUBLIC_CALLBACK_WRONG_SERVICE',
};
const responding = (response: Response): typeof globalThis.fetch =>
  async () => response;

test('public callback readiness requires the real application identity without sending credentials', async () => {
  let requests = 0;
  const result = await checkPublicReadiness(config, {
    fetch: async (url, options) => {
      requests++;
      assert.equal(String(url), `${config.PUBLIC_BASE_URL}/api/health`);
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.headers, undefined);
      assert.equal(options?.body, undefined);
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ appId: 'ai-phone-solo' }));
    },
  });
  assert.deepEqual(result, ready);
  assert.equal(requests, 1);
});

test('invalid or non-HTTPS callback origins are refused without issuing a request', async () => {
  for (const value of [
    '',
    'http://private-callback.example',
    'https://localhost',
    'https://private-callback.example/other',
    'https://secret@private-callback.example',
    'https://private-callback.example?secret=value',
  ]) {
    let requested = false;
    const result = await checkPublicReadiness(
      { PUBLIC_BASE_URL: value },
      {
        fetch: async () => {
          requested = true;
          throw new Error('UNEXPECTED_REQUEST');
        },
      },
    );
    assert.deepEqual(result, {
      status: 'invalid_configuration',
      code: 'PUBLIC_CALLBACK_URL_INVALID',
    });
    assert.equal(requested, false);
  }
});

test('Cloudflare and other non-200 responses are unreachable and their bodies are not disclosed', async () => {
  for (const status of [301, 401, 403, 404, 503, 530]) {
    const response = new Response('private host, account and response details', {
      status,
    });
    assert.deepEqual(
      await checkPublicReadiness(config, { fetch: responding(response) }),
      unreachable,
    );
  }
});

test('200 from an unrelated application, malformed JSON, or oversized body is the wrong service', async () => {
  for (const body of [
    '{"appId":"another-application","secret":"private-value"}',
    'null',
    '[]',
    'not JSON with private details',
    JSON.stringify({ appId: 'ai-phone-solo', padding: 'x'.repeat(4096) }),
  ]) {
    assert.deepEqual(
      await checkPublicReadiness(config, {
        fetch: responding(new Response(body)),
      }),
      wrongService,
    );
  }
});

test('network exceptions do not expose the URL or original error', async () => {
  const result = await checkPublicReadiness(config, {
    fetch: async () => {
      throw new Error(`${config.PUBLIC_BASE_URL}/secret-token`);
    },
  });
  assert.deepEqual(result, unreachable);
});

test('the deadline aborts even a fetch implementation that ignores cancellation', async () => {
  let signal: AbortSignal;
  const result = await checkPublicReadiness(config, {
    timeoutMs: 10,
    fetch: async (_url, options) => {
      signal = options.signal;
      return new Promise<Response>(() => {});
    },
  });
  assert.deepEqual(result, unreachable);
  assert.equal(signal.aborted, true);
});

test('the deadline also covers a successful response whose body never finishes', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('{"appId":'));
    },
  });
  assert.deepEqual(
    await checkPublicReadiness(config, {
      timeoutMs: 10,
      fetch: responding(new Response(body)),
    }),
    unreachable,
  );
});

test('callers cannot extend the public callback probe beyond five seconds', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const result = checkPublicReadiness(config, {
    timeoutMs: 60000,
    fetch: async () => new Promise<Response>(() => {}),
  });
  context.mock.timers.tick(5000);
  assert.deepEqual(await result, unreachable);
});
