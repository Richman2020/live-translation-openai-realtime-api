import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportCloudVoiceClientRejection } from '../src/solo/cloud-voice-diagnostics';

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
