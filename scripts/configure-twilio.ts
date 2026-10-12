import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient';
import { ConfigStore, checkConfig } from '../src/solo/config';
import { verifyProviders } from '../src/solo/provider-checks';

// Explicit setup command. It never buys a number or places a call.
const apply = process.argv.includes('--apply');
const prepare = process.argv.includes('--prepare');
const store = new ConfigStore({ generateToken: false });
let config = store.value;
const needed = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_CALLER_NUMBER',
  'PUBLIC_BASE_URL',
];
const missing = checkConfig(config).filter(
  (check) => needed.includes(check.name) && check.status !== 'ready',
);
if (missing.length) {
  console.log(
    JSON.stringify({
      status: 'blocked',
      missing: missing.map((check) => check.name),
    }),
  );
  process.exit(1);
}
try {
  const localApi = async (path: string, input?: object) => {
    const response = await fetch(`http://127.0.0.1:${config.API_PORT}${path}`, {
      method: input ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('LOCAL_SERVICE_NOT_READY');
    return response.json();
  };
  const liveStatus = await localApi('/api/status');
  if (liveStatus.activeSession) throw new Error('CALL_IN_PROGRESS');
  const probe = await fetch(`${config.PUBLIC_BASE_URL}/api/health`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!probe.ok || (await probe.json()).appId !== 'ai-phone-solo')
    throw new Error('PUBLIC_SERVICE_UNREACHABLE');
  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN, {
    httpClient: new RequestClient({ timeout: 15000, autoRetry: false }),
    autoRetry: false,
  });
  const numbers = await client.incomingPhoneNumbers.list({
    phoneNumber: config.TWILIO_CALLER_NUMBER,
    limit: 2,
  });
  const number = numbers.find(
    (item) =>
      item.phoneNumber === config.TWILIO_CALLER_NUMBER &&
      item.capabilities.voice,
  );
  if (!number) throw new Error('OWNED_VOICE_NUMBER_NOT_FOUND');
  if (
    Boolean(config.TWILIO_API_KEY_SID) !== Boolean(config.TWILIO_API_KEY_SECRET)
  )
    throw new Error('INCOMPLETE_KEY_PAIR');
  const plan = {
    number: config.TWILIO_CALLER_NUMBER,
    applicationVoiceUrl: `${config.PUBLIC_BASE_URL}/voice/client`,
    incomingVoiceUrl: `${config.PUBLIC_BASE_URL}/voice/incoming`,
    createKey: !config.TWILIO_API_KEY_SID,
    createApplication: !config.TWILIO_TWIML_APP_SID,
    changesVoiceRouting: true,
    clearsPreviousVoiceFallbackAndStatusCallback: true,
    changesSmsRouting: false,
    buysResources: false,
    placesCalls: false,
  };
  if (!apply && !prepare) {
    console.log(JSON.stringify({ status: 'review', plan }, null, 2));
    process.exit(0);
  }
  const runtimeDir = resolve('.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    resolve(runtimeDir, `twilio-voice-backup-${Date.now()}.json`),
    JSON.stringify(
      {
        numberSid: number.sid,
        voiceUrl: number.voiceUrl,
        voiceMethod: number.voiceMethod,
        voiceApplicationSid: number.voiceApplicationSid,
        voiceFallbackUrl: number.voiceFallbackUrl,
        voiceFallbackMethod: number.voiceFallbackMethod,
        statusCallback: number.statusCallback,
        statusCallbackMethod: number.statusCallbackMethod,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (!config.TWILIO_API_KEY_SID) {
    const key = await client.newKeys.create({
      friendlyName: 'AI Phone local desktop',
    });
    await localApi('/api/settings', {
      TWILIO_API_KEY_SID: key.sid,
      TWILIO_API_KEY_SECRET: key.secret,
    });
    config = new ConfigStore({ generateToken: false }).value;
  }
  if (!config.TWILIO_TWIML_APP_SID) {
    const app = await client.applications.create({
      friendlyName: 'AI Phone local desktop',
      voiceUrl: plan.applicationVoiceUrl,
      voiceMethod: 'POST',
    });
    await localApi('/api/settings', { TWILIO_TWIML_APP_SID: app.sid });
    config = new ConfigStore({ generateToken: false }).value;
  } else {
    await client
      .applications(config.TWILIO_TWIML_APP_SID)
      .update({ voiceUrl: plan.applicationVoiceUrl, voiceMethod: 'POST' });
  }
  if (!apply) {
    console.log(
      JSON.stringify({
        status: 'prepared',
        applicationSid: config.TWILIO_TWIML_APP_SID,
        numberRoutingChanged: false,
      }),
    );
    process.exit(0);
  }
  const configuredStatus = await localApi('/api/status');
  if (!configuredStatus.configured || configuredStatus.activeSession)
    throw new Error('LOCAL_SERVICE_NOT_READY');
  const verifiedProviders = await verifyProviders(config);
  if (!verifiedProviders.checks.every((check) => check.status === 'passed')) {
    console.log(
      JSON.stringify({
        status: 'blocked_before_number_switch',
        verification: verifiedProviders,
        numberRoutingChanged: false,
      }),
    );
    process.exit(1);
  }
  // Switching the owned number is last, after settings are live and both providers answer.
  await client
    .incomingPhoneNumbers(number.sid)
    .update({
      voiceApplicationSid: '',
      voiceUrl: plan.incomingVoiceUrl,
      voiceMethod: 'POST',
      voiceFallbackUrl: '',
      statusCallback: '',
    });
  const currentNumber = await client.incomingPhoneNumbers(number.sid).fetch();
  const currentApp = await client
    .applications(config.TWILIO_TWIML_APP_SID)
    .fetch();
  const verified =
    currentNumber.voiceUrl === plan.incomingVoiceUrl &&
    currentNumber.voiceMethod === 'POST' &&
    !currentNumber.voiceApplicationSid &&
    !currentNumber.voiceFallbackUrl &&
    !currentNumber.statusCallback &&
    currentApp.voiceUrl === plan.applicationVoiceUrl;
  console.log(
    JSON.stringify({
      status: verified ? 'configured' : 'verification_failed',
      applicationSid: currentApp.sid,
      numberSid: number.sid,
      realCallTested: false,
    }),
  );
  process.exitCode = verified ? 0 : 1;
} catch (error) {
  const known = [
    'PUBLIC_SERVICE_UNREACHABLE',
    'OWNED_VOICE_NUMBER_NOT_FOUND',
    'INCOMPLETE_KEY_PAIR',
    'LOCAL_SERVICE_NOT_READY',
    'CALL_IN_PROGRESS',
  ];
  console.error(
    JSON.stringify({
      status: 'failed',
      code: known.includes(error?.message)
        ? error.message
        : 'TWILIO_SETUP_FAILED',
      note: 'Review private configuration; no credentials are printed.',
    }),
  );
  process.exitCode = 1;
}
