/* eslint-disable no-await-in-loop -- Ordered PCM consumer waits once per frame. */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { assertAliyunPlanBConfig } from './aliyun-planb-config';
import { createPlanBWebSocket } from './aliyun-planb-network';
import type { PlanBTtsClient, PlanBTtsOptions } from './aliyun-planb-types';

type Waiter = {
  resolve: (value: IteratorResult<Buffer>) => void;
  reject: (error: Error) => void;
};

/** An isolated task/socket per segment; never reconnects, retries or changes voice. */
export function createAliyunPlanBTts(options: PlanBTtsOptions): PlanBTtsClient {
  let closed = false;
  let activeStop: ((code: string) => void) | undefined;
  let lastSequence = 0;
  return {
    async *synthesize(text, sequence, signal) {
      if (closed || signal?.aborted) throw new Error('PLANB_TTS_CANCELLED');
      if (!options.config.apiKey?.trim()) throw new Error('PLANB_KEY_REQUIRED');
      if (activeStop) throw new Error('PLANB_TTS_ALREADY_ACTIVE');
      if (
        options.config.ttsModel !== 'cosyvoice-v3-flash' ||
        options.config.voice !== 'loongandy_v3' ||
        options.config.sampleRate !== 24000 ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 4096 ||
        /[\u3400-\u9fff]/u.test(text) ||
        !Number.isSafeInteger(sequence) ||
        sequence <= lastSequence ||
        (options.timeoutMs !== undefined &&
          (!Number.isSafeInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > 120000))
      )
        throw new Error('PLANB_TTS_INPUT_INVALID');
      assertAliyunPlanBConfig(options.config);
      lastSequence = sequence;
      const taskId = randomUUID();
      let socket: WebSocket | undefined;
      let ready = false;
      let terminal = false;
      let providerFinished = false;
      let consumerCancelled = false;
      let stoppedCode = '';
      let sentenceIndex = -1;
      let audioPermitted = false;
      let characters: number | undefined;
      let usageReported = false;
      let queuedBytes = 0;
      let audioBytes = 0;
      let timer: NodeJS.Timeout | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      const queue: Buffer[] = [];
      let waiter: Waiter | undefined;
      const waitForAudio = () =>
        new Promise<IteratorResult<Buffer>>((resolve, reject) => {
          waiter = { resolve, reject };
        });
      const eventIds = new Set<string>();
      const evidence = (
        event: 'configured' | 'ready' | 'completed' | 'cancelled' | 'failed',
        code?: string,
      ) => {
        try {
          options.onEvidence?.({
            layer: 'tts',
            event,
            role: 'local',
            region: options.config.region,
            sequence,
            model: options.config.ttsModel,
            voice: options.config.voice,
            sampleRate: 24000,
            ...(code ? { code } : {}),
          });
        } catch {
          // Observer exceptions must not keep an active synthesis alive.
        }
      };
      const closeSocket = () => {
        if (!socket) return;
        try {
          socket.close(1000);
          if (socket.readyState !== WebSocket.CLOSED) {
            closeTimer = setTimeout(() => {
              try {
                socket?.terminate();
              } catch {
                // State is already fenced; never reconnect on cleanup errors.
              }
            }, 250);
          }
        } catch {
          try {
            socket.terminate();
          } catch {
            // No network retry or secret-bearing exception reporting.
          }
        }
      };
      const reportUsage = () => {
        if (usageReported) return;
        usageReported = true;
        try {
          options.onUsage?.({
            layer: 'tts',
            role: 'local',
            taskSequence: sequence,
            region: options.config.region,
            ...(characters === undefined ? {} : { characters }),
            basis: characters === undefined ? 'unknown' : 'provider_reported',
          });
        } catch {
          // Usage is diagnostic evidence, never a reason to skip cleanup.
        }
      };
      const directive = (action: string, input: Record<string, unknown>) => ({
        header: { action, task_id: taskId, streaming: 'duplex' },
        payload: { input },
      });
      const stop = (code: string) => {
        if (
          consumerCancelled ||
          (terminal && !providerFinished) ||
          (providerFinished && code !== 'PLANB_TTS_CANCELLED')
        )
          return;
        // A provider terminal event does not mean buffered PCM was consumed.
        // Cancel the consumer even after task-finished, without resubmitting a
        // cancellation to a finished task or counting its usage a second time.
        const alreadyFinished = providerFinished;
        consumerCancelled = true;
        terminal = true;
        stoppedCode = code;
        audioPermitted = false;
        queue.length = 0;
        queuedBytes = 0;
        clearTimeout(timer);
        // Beijing supports a server cancel directive. Singapore does not.
        if (
          !alreadyFinished &&
          ready &&
          socket?.readyState === WebSocket.OPEN &&
          options.config.region === 'beijing'
        ) {
          try {
            socket.send(
              JSON.stringify(directive('finish-task', { directive: 'cancel' })),
            );
          } catch {
            // Cancellation cannot promise zero already-generated charges.
          }
        }
        if (!alreadyFinished) reportUsage();
        evidence(code === 'PLANB_TTS_CANCELLED' ? 'cancelled' : 'failed', code);
        const pending = waiter;
        waiter = undefined;
        pending?.reject(new Error(code));
        if (!alreadyFinished) closeSocket();
      };
      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => stop('PLANB_TTS_TIMEOUT'),
          options.timeoutMs ?? 20000,
        );
      };
      const send = (value: unknown) => {
        if (terminal || socket?.readyState !== WebSocket.OPEN) {
          stop('PLANB_TTS_SEND_FAILED');
          return;
        }
        try {
          socket.send(JSON.stringify(value), (error?: Error) => {
            if (error) stop('PLANB_TTS_SEND_FAILED');
          });
        } catch {
          stop('PLANB_TTS_SEND_FAILED');
        }
      };
      const externalAbort = () => stop('PLANB_TTS_CANCELLED');
      activeStop = stop;
      signal?.addEventListener('abort', externalAbort, { once: true });
      try {
        socket = createPlanBWebSocket(options.config, options.createWebSocket);
        socket.on('open', () => {
          if (terminal) return;
          evidence('configured');
          send({
            header: {
              action: 'run-task',
              task_id: taskId,
              streaming: 'duplex',
            },
            payload: {
              task_group: 'audio',
              task: 'tts',
              function: 'SpeechSynthesizer',
              model: 'cosyvoice-v3-flash',
              parameters: {
                text_type: 'PlainText',
                voice: 'loongandy_v3',
                format: 'pcm',
                sample_rate: 24000,
                language_hints: ['en'],
              },
              input: {},
            },
          });
        });
        socket.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
          if (terminal) return;
          try {
            let bytes: Buffer;
            if (Buffer.isBuffer(raw)) bytes = raw;
            else if (Array.isArray(raw)) bytes = Buffer.concat(raw);
            else bytes = Buffer.from(raw);
            if (bytes.length > 1024 * 1024)
              throw new Error('PLANB_TTS_EVENT_LIMIT');
            if (isBinary) {
              if (
                !ready ||
                !audioPermitted ||
                !bytes.length ||
                bytes.length % 2
              )
                throw new Error('PLANB_TTS_AUDIO_UNBOUND');
              // Official protocol: sentence-synthesis JSON followed by binary.
              audioPermitted = false;
              audioBytes += bytes.length;
              queuedBytes += bytes.length;
              if (queuedBytes > 16 * 1024 * 1024)
                throw new Error('PLANB_TTS_QUEUE_LIMIT');
              if (waiter) {
                const pending = waiter;
                waiter = undefined;
                queuedBytes -= bytes.length;
                pending.resolve({ value: Buffer.from(bytes), done: false });
              } else queue.push(Buffer.from(bytes));
              armTimeout();
              return;
            }
            const message = JSON.parse(bytes.toString('utf8'));
            if (message.header?.task_id !== taskId) return;
            const eventId = message.header.event_id;
            if (eventId !== undefined) {
              if (typeof eventId !== 'string' || eventId.length > 256)
                throw new Error('PLANB_TTS_EVENT_INVALID');
              if (eventIds.has(eventId)) return;
              if (eventIds.size >= 8192)
                throw new Error('PLANB_TTS_EVENT_LIMIT');
              eventIds.add(eventId);
            }
            const usage = message.payload?.usage?.characters;
            if (usage !== undefined) {
              if (!Number.isSafeInteger(usage) || usage < 0)
                throw new Error('PLANB_TTS_USAGE_INVALID');
              characters = Math.max(characters ?? 0, usage);
            }
            const event = message.header?.event;
            if (event === 'task-started') {
              if (ready) return;
              ready = true;
              evidence('ready');
              send(directive('continue-task', { text }));
              send(directive('finish-task', {}));
            } else if (event === 'result-generated') {
              if (!ready) throw new Error('PLANB_TTS_EVENT_INVALID');
              const output = message.payload?.output;
              const index = output?.sentence?.index;
              if (
                !Number.isSafeInteger(index) ||
                index < 0 ||
                index < sentenceIndex ||
                (sentenceIndex !== -1 && index > sentenceIndex + 1)
              )
                throw new Error('PLANB_TTS_SENTENCE_ORDER');
              if (output?.type === 'sentence-synthesis') {
                if (audioPermitted) throw new Error('PLANB_TTS_AUDIO_UNBOUND');
                sentenceIndex = index;
                audioPermitted = true;
              } else if (
                !['sentence-begin', 'sentence-end'].includes(output?.type)
              )
                throw new Error('PLANB_TTS_EVENT_INVALID');
              else {
                if (audioPermitted) throw new Error('PLANB_TTS_AUDIO_UNBOUND');
                sentenceIndex = index;
              }
            } else if (event === 'task-failed')
              throw new Error('PLANB_TTS_PROVIDER_FAILED');
            else if (event === 'task-finished') {
              if (!ready || audioPermitted)
                throw new Error('PLANB_TTS_EVENT_INVALID');
              if (!audioBytes) throw new Error('PLANB_TTS_EMPTY_AUDIO');
              terminal = true;
              providerFinished = true;
              clearTimeout(timer);
              reportUsage();
              evidence('completed');
              const pending = waiter;
              waiter = undefined;
              pending?.resolve({ value: undefined, done: true });
              closeSocket();
              return;
            } else throw new Error('PLANB_TTS_EVENT_INVALID');
            armTimeout();
          } catch (error) {
            stop(
              error instanceof Error &&
                /^PLANB_TTS_[A-Z_]+$/.test(error.message)
                ? error.message
                : 'PLANB_TTS_EVENT_INVALID',
            );
          }
        });
        socket.on('error', () => stop('PLANB_TTS_CONNECTION_FAILED'));
        socket.on('close', () => {
          clearTimeout(closeTimer);
          if (!terminal) stop('PLANB_TTS_CONNECTION_CLOSED');
        });
        armTimeout();
        while (true) {
          if (closed || signal?.aborted) stop('PLANB_TTS_CANCELLED');
          if (stoppedCode) throw new Error(stoppedCode);
          if (queue.length) {
            const pcm = queue.shift()!;
            queuedBytes -= pcm.length;
            yield pcm;
          } else if (terminal) break;
          else {
            const next = await waitForAudio();
            if (closed || signal?.aborted) stop('PLANB_TTS_CANCELLED');
            if (consumerCancelled) throw new Error(stoppedCode);
            if (next.done) break;
            if (terminal && !providerFinished) throw new Error(stoppedCode);
            yield next.value;
          }
        }
      } catch (error) {
        const code =
          stoppedCode ||
          (error instanceof Error && /^PLANB_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'PLANB_TTS_CONNECTION_FAILED');
        stop(code);
        throw new Error(code);
      } finally {
        if (!terminal) stop('PLANB_TTS_CANCELLED');
        queue.length = 0;
        queuedBytes = 0;
        clearTimeout(timer);
        signal?.removeEventListener('abort', externalAbort);
        activeStop = undefined;
      }
    },
    abort() {
      closed = true;
      activeStop?.('PLANB_TTS_CANCELLED');
    },
  };
}
