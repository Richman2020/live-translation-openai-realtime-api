import WebSocket from 'ws';
import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient';

import { checkConfig, type SoloConfig, type SettingName } from './config';

type Check = {
  name: string;
  status: 'passed' | 'failed' | 'missing';
  code: string;
};
export type ProviderReport = {
  checkedAt: string;
  realCallTested: false;
  checks: Check[];
};

// Verify an actual Realtime session, without submitting audio or generating a response.
export function checkRealtime(
  config: SoloConfig,
  createSocket: (url: string, options: object) => WebSocket = (url, options) =>
    new WebSocket(url, options),
  timeoutMs = 15000,
): Promise<Check> {
  return new Promise((resolve) => {
    let finished = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (status: Check['status'], code: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      else if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
      resolve({ name: 'openaiRealtime', status, code });
    };
    try {
      socket = createSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.OPENAI_REALTIME_MODEL)}`,
        {
          headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
          handshakeTimeout: timeoutMs,
        },
      );
      timer = setTimeout(() => finish('failed', 'SESSION_TIMEOUT'), timeoutMs);
      socket.on('error', () => finish('failed', 'CONNECTION_FAILED'));
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        finish('failed', `HTTP_${response.statusCode}`);
      });
      socket.on('close', () => finish('failed', 'CLOSED_BEFORE_READY'));
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions:
                'Translate speech accurately between Mandarin Chinese and English.',
              output_modalities: ['audio'],
              audio: {
                input: {
                  format: { type: 'audio/pcmu' },
                  transcription: { model: 'whisper-1' },
                  turn_detection: {
                    type: 'server_vad',
                    create_response: false,
                  },
                },
                output: { format: { type: 'audio/pcmu' } },
              },
            },
          }),
        );
      });
      socket.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          if (event.type === 'session.updated')
            finish('passed', 'SESSION_UPDATED');
          if (event.type === 'error') finish('failed', 'SESSION_REJECTED');
        } catch {
          finish('failed', 'INVALID_RESPONSE');
        }
      });
    } catch {
      finish('failed', 'CONNECTION_FAILED');
    }
  });
}

export async function verifyProviders(
  config: SoloConfig,
): Promise<ProviderReport> {
  const missing = new Set(
    checkConfig(config)
      .filter((item) => item.status !== 'ready')
      .map((item) => item.name),
  );
  const has = (...names: SettingName[]) =>
    names.every((name) => !missing.has(name));
  const checks: Check[] = [];
  const run = async (name: string, action: () => Promise<boolean>) => {
    try {
      const passed = await action();
      checks.push({
        name,
        status: passed ? 'passed' : 'failed',
        code: passed ? 'VERIFIED_RESOURCE' : 'RESOURCE_MISMATCH',
      });
    } catch (error) {
      // Provider errors can include request details. Only preserve numeric status codes.
      const status = Number((error as { status?: number })?.status);
      checks.push({
        name,
        status: 'failed',
        code:
          Number.isInteger(status) && status >= 400 && status <= 599
            ? `HTTP_${status}`
            : 'CONNECTION_OR_RESOURCE_FAILED',
      });
    }
  };
  if (has('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN')) {
    const accountClient = twilio(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      {
        httpClient: new RequestClient({ timeout: 15000, autoRetry: false }),
        autoRetry: false,
      },
    );
    await run(
      'twilioAccount',
      async () =>
        (await accountClient.api.accounts(config.TWILIO_ACCOUNT_SID).fetch())
          .status === 'active',
    );
  } else
    checks.push({
      name: 'twilioAccount',
      status: 'missing',
      code: 'CONFIGURATION_REQUIRED',
    });
  if (
    has(
      'TWILIO_ACCOUNT_SID',
      'TWILIO_API_KEY_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_CALLER_NUMBER',
      'TWILIO_TWIML_APP_SID',
      'PUBLIC_BASE_URL',
    )
  ) {
    const voiceClient = twilio(
      config.TWILIO_API_KEY_SID,
      config.TWILIO_API_KEY_SECRET,
      {
        accountSid: config.TWILIO_ACCOUNT_SID,
        httpClient: new RequestClient({ timeout: 15000, autoRetry: false }),
        autoRetry: false,
      },
    );
    await run('twilioNumber', async () => {
      const numbers = await voiceClient.incomingPhoneNumbers.list({
        phoneNumber: config.TWILIO_CALLER_NUMBER,
        limit: 2,
      });
      return numbers.some(
        (number) =>
          number.capabilities.voice &&
          number.phoneNumber === config.TWILIO_CALLER_NUMBER,
      );
    });
    await run('twilioApplication', async () => {
      const application = await voiceClient
        .applications(config.TWILIO_TWIML_APP_SID)
        .fetch();
      return (
        application.voiceUrl === `${config.PUBLIC_BASE_URL}/voice/client` &&
        application.voiceMethod === 'POST'
      );
    });
  } else {
    checks.push(
      {
        name: 'twilioNumber',
        status: 'missing',
        code: 'CONFIGURATION_REQUIRED',
      },
      {
        name: 'twilioApplication',
        status: 'missing',
        code: 'CONFIGURATION_REQUIRED',
      },
    );
  }
  checks.push(
    has('OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL')
      ? await checkRealtime(config)
      : {
          name: 'openaiRealtime',
          status: 'missing',
          code: 'CONFIGURATION_REQUIRED',
        },
  );
  return { checkedAt: new Date().toISOString(), realCallTested: false, checks };
}
