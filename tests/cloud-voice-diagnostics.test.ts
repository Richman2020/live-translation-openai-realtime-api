import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudVoiceRoute,
  reportCloudVoiceClientRejection,
  reportCloudVoiceRejection,
  type CloudVoiceRoute,
} from '../src/solo/cloud-voice-diagnostics';

test('voice diagnostics log only a fixed route and failure enum, never arbitrary input', (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: string) => logs.push(value));
  reportCloudVoiceClientRejection('INVALID_SESSION');
  reportCloudVoiceClientRejection('unknown exception with private parameters');
  assert.deepEqual(
    logs.map((value) => JSON.parse(value)),
    [
      {
        event: 'CLOUD_VOICE_CLIENT_REJECTED',
        route: '/voice/client',
        reason: 'INVALID_SESSION',
      },
      {
        event: 'CLOUD_VOICE_CLIENT_REJECTED',
        route: '/voice/client',
        reason: 'REQUEST_FORBIDDEN',
      },
    ],
  );
  assert.ok(!logs.join('').includes('private parameters'));
});

test('a diagnostic sink failure cannot change callback authorization handling', (t) => {
  t.mock.method(console, 'error', () => {
    throw new Error('offline failed logger');
  });
  assert.doesNotThrow(() =>
    reportCloudVoiceClientRejection('INVALID_VOICE_JOIN'),
  );
});

test('callback classifications keep only the five fixed paths and never query values', () => {
  for (const route of [
    '/voice/connect',
    '/voice/status',
    '/voice/stream-status',
  ])
    assert.equal(
      cloudVoiceRoute('POST', `${route}?nonce=private-query`),
      route,
    );
  assert.equal(cloudVoiceRoute('POST', '/voice/client'), '/voice/client');
  assert.equal(cloudVoiceRoute('GET', '/voice/media'), '/voice/media');
  for (const [method, target] of [
    ['POST', '/voice/client?nonce=private-query'],
    ['GET', '/voice/media?nonce=private-query'],
    ['POST', '/voice/incoming'],
    ['POST', '/voice/unknown'],
    ['GET', '/voice/connect'],
    ['GET', '/api/events'],
    ['POST', '//voice/status'],
    ['POST', '/voice/%73tatus'],
  ])
    assert.equal(cloudVoiceRoute(method, target), undefined);
});

test('every fixed callback logs safe failure classifications and ignores arbitrary routes', (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: string) => logs.push(value));
  for (const route of [
    '/voice/client',
    '/voice/connect',
    '/voice/status',
    '/voice/stream-status',
    '/voice/media',
  ] as const) {
    reportCloudVoiceRejection(route, 'INGRESS_DUPLICATE_HEADER');
    reportCloudVoiceRejection(route, 'private exception nonce=private-query');
  }
  for (const route of [
    '/voice/status?nonce=private-query',
    '/voice/unknown',
    undefined,
    42,
    { private: 'query' },
  ])
    reportCloudVoiceRejection(
      route as unknown as CloudVoiceRoute,
      'INVALID_SESSION',
    );
  assert.equal(logs.length, 10);
  assert.ok(!logs.join('').includes('private'));
  const parsed = logs.map((value) => JSON.parse(value));
  assert.deepEqual(
    [...new Set(parsed.map((value) => value.route))],
    [
      '/voice/client',
      '/voice/connect',
      '/voice/status',
      '/voice/stream-status',
      '/voice/media',
    ],
  );
  assert.ok(parsed.every((value) => Object.keys(value).length === 3));
  assert.ok(
    parsed.every(
      (value, index) =>
        value.reason ===
        (index % 2 ? 'REQUEST_FORBIDDEN' : 'INGRESS_DUPLICATE_HEADER'),
    ),
  );
});
