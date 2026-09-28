import WebSocket from 'ws';
import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient';

import {
  checkConfig,
  validTranscriptionModel,
  type SoloConfig,
  type SettingName,
} from './config';
import { createOpenAIWebSocket } from './openai-websocket';
import {
  createContinuousTranslationClient,
  type ContinuousTranslationClient,
} from './continuous-translation-client';
import type { TranslationEngine } from './translation-engine';
import { checkNanoVoice } from './nano-runtime';
import { checkRemoteCaption } from './remote-caption-client';

type Check = {
  name: string;
  status: 'passed' | 'failed' | 'missing';
  code: string;
};
export type ProviderReport = {
  checkedAt: string;
  realCallTested: false;
  translationEngine?: TranslationEngine;
  checks: Check[];
};

type CreateSocket = (
  url: string,
  options: WebSocket.ClientOptions,
) => WebSocket;

const continuousFailureCodes: Record<string, string> = {
  PROVIDER_READY_TIMEOUT: 'SESSION_TIMEOUT',
  PROVIDER_SESSION_MISMATCH: 'SESSION_MISMATCH',
  PROVIDER_CONNECTION_FAILED: 'CONNECTION_FAILED',
  PROVIDER_HANDSHAKE_REJECTED: 'HANDSHAKE_REJECTED',
  PROVIDER_CLOSED_UNEXPECTEDLY: 'CLOSED_BEFORE_READY',
  PROVIDER_SESSION_REJECTED: 'SESSION_REJECTED',
  PROVIDER_SEND_FAILED: 'CONNECTION_FAILED',
  PROVIDER_SEND_UNAVAILABLE: 'CONNECTION_FAILED',
  INVALID_PROVIDER_EVENT: 'INVALID_RESPONSE',
  PROVIDER_OUTPUT_BEFORE_READY: 'INVALID_RESPONSE',
};

/** Verify both target languages without sending audio or generating speech. */
export async function checkContinuousRealtime(
  config: SoloConfig,
  createSocket: CreateSocket = (url, options) => new WebSocket(url, options),
  timeoutMs = 15000,
  targetLanguages: ('en' | 'zh')[] = ['en', 'zh'],
): Promise<Check> {
  const clients: ContinuousTranslationClient[] = [];
  try {
    for (const targetLanguage of targetLanguages)
      clients.push(
        createContinuousTranslationClient({
          apiKey: config.OPENAI_API_KEY,
          proxyUrl: config.OPENAI_PROXY_URL,
          targetLanguage,
          onAudio: () => {},
          createWebSocket: createSocket,
          timeoutMs,
        }),
      );
    await Promise.all(clients.map((client) => client.ready));
    return {
      name: 'openaiContinuous',
      status: 'passed',
      code:
        targetLanguages.length === 2
          ? 'SESSION_UPDATED_BOTH_LANGUAGES'
          : 'SESSION_UPDATED_ENGLISH',
    };
  } catch (error) {
    // Never surface provider payloads, credential-bearing transport errors,
    // or arbitrary exception messages in a local verification response.
    const code =
      error instanceof Error &&
      Object.prototype.hasOwnProperty.call(
        continuousFailureCodes,
        error.message,
      )
        ? continuousFailureCodes[error.message]
        : 'CONNECTION_FAILED';
    return { name: 'openaiContinuous', status: 'failed', code };
  } finally {
    for (const client of clients) client.abort();
  }
}

// Verify an actual Realtime session, without submitting audio or generating a response.
export function checkRealtime(
  config: SoloConfig,
  createSocket: (url: string, options: object) => WebSocket = (url, options) =>
    new WebSocket(url, options),
  timeoutMs = 15000,
): Promise<Check> {
  if (!validTranscriptionModel(config.OPENAI_TRANSCRIPTION_MODEL))
    return Promise.resolve({
      name: 'openaiRealtime',
      status: 'failed',
      code: 'INVALID_OPENAI_TRANSCRIPTION_MODEL',
    });
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
      socket = createOpenAIWebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.OPENAI_REALTIME_MODEL)}`,
        {
          headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
          handshakeTimeout: timeoutMs,
        },
        config.OPENAI_PROXY_URL,
        createSocket,
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
                  transcription: { model: config.OPENAI_TRANSCRIPTION_MODEL },
                  turn_detection: {
                    type: 'server_vad',
                    create_response: false,
                    interrupt_response: false,
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
          if (event.type === 'session.updated') {
            const input = event.session?.audio?.input;
            const matches =
              event.session?.type === 'realtime' &&
              input?.format?.type === 'audio/pcmu' &&
              event.session?.audio?.output?.format?.type === 'audio/pcmu' &&
              input?.transcription?.model ===
                config.OPENAI_TRANSCRIPTION_MODEL &&
              input?.turn_detection?.create_response === false &&
              input?.turn_detection?.interrupt_response === false;
            finish(
              matches ? 'passed' : 'failed',
              matches ? 'SESSION_UPDATED' : 'SESSION_MISMATCH',
            );
          }
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

export async function checkTranslationEngine(
  config: SoloConfig,
  engine: TranslationEngine,
  createSocket?: CreateSocket,
  timeoutMs = 15000,
): Promise<Check> {
  if (engine === 'nano-captions') {
    const local = await checkNanoVoice();
    if (local.status !== 'passed') return local;
    const [translation, caption] = await Promise.all([
      checkContinuousRealtime(config, createSocket, timeoutMs, ['en']),
      checkRemoteCaption(config, createSocket, timeoutMs),
    ]);
    if (translation.status !== 'passed') return translation;
    if (caption.status !== 'passed') return caption;
    return {
      name: 'nanoCaptions',
      status: 'passed',
      code: 'NANO_CAPTIONS_READY',
    };
  }
  if (engine === 'continuous-nano') {
    const local = await checkNanoVoice();
    if (local.status !== 'passed') return local;
    const translation = await checkContinuousRealtime(
      config,
      createSocket,
      timeoutMs,
    );
    return translation.status === 'passed'
      ? {
          name: 'nanoTranslation',
          status: 'passed',
          code: 'NANO_AND_CONTINUOUS_READY',
        }
      : translation;
  }
  if (engine === 'continuous')
    return checkContinuousRealtime(config, createSocket, timeoutMs);
  if (engine === 'legacy')
    return checkRealtime(config, createSocket, timeoutMs);
  return Promise.resolve({
    name: 'openaiTranslation',
    status: 'failed',
    code: 'INVALID_TRANSLATION_ENGINE',
  });
}

export async function verifyProviders(
  config: SoloConfig,
  engine: TranslationEngine = 'legacy',
  checkEngine: typeof checkTranslationEngine = checkTranslationEngine,
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
    (
      engine !== 'legacy'
        ? has('OPENAI_API_KEY')
        : has(
            'OPENAI_API_KEY',
            'OPENAI_REALTIME_MODEL',
            'OPENAI_TRANSCRIPTION_MODEL',
          )
    )
      ? await checkEngine(config, engine)
      : {
          name: {
            'nano-captions': 'nanoCaptions',
            'continuous-nano': 'nanoTranslation',
            continuous: 'openaiContinuous',
            legacy: 'openaiRealtime',
          }[engine],
          status: 'missing',
          code: 'CONFIGURATION_REQUIRED',
        },
  );
  return {
    checkedAt: new Date().toISOString(),
    realCallTested: false,
    translationEngine: engine,
    checks,
  };
}
