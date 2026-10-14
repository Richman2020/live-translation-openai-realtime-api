/* eslint-disable no-await-in-loop -- Playback credits are consumed in order and released by matching marks. */
import type WebSocket from 'ws';

import { createCallContext } from './call-context';
import {
  ContinuousTranslationBridge,
  type ContinuousTranslationBridgeOptions,
} from './continuous-translation-bridge';
import {
  createAliyunPlanBPipeline,
  type AliyunPlanBPipeline,
  type AliyunPlanBPipelineOptions,
  type PlanBAudioMetadata,
  type PlanBSourceCorrection,
} from './aliyun-planb-pipeline';
import type {
  AliyunPlanBConfig,
  PlanBEvidence,
  PlanBUsage,
} from './aliyun-planb-types';
import type {
  TranslationAudioDiagnostic,
  TranslationRole,
  TranscriptEvent,
} from './translation-bridge';

export type AliyunPlanBBridgeSelection = {
  config: AliyunPlanBConfig;
  deps?: Pick<
    AliyunPlanBPipelineOptions,
    'createAsr' | 'translate' | 'createTts' | 'createWebSocket' | 'fetch'
  >;
  onUsage?: (usage: PlanBUsage) => void;
  onEvidence?: (event: PlanBEvidence) => void;
  /** Trusted explicit test evidence sink; never an ordinary server log. */
  onCorrection?: (event: PlanBSourceCorrection) => void;
};
type Playback = { pending: Set<string>; sealed: boolean; seen: boolean };
type Waiter = { resolve: () => void; reject: (error: Error) => void };

/** Selected explicitly once per call. Original OpenAI factories stay intact. */
export function createAliyunPlanBBridge(
  options: ContinuousTranslationBridgeOptions,
  selection: AliyunPlanBBridgeSelection,
): {
  attach(role: TranslationRole, socket: WebSocket, streamSid: string): void;
  close(): void;
} {
  if (
    !selection?.config ||
    selection.config.voice !== 'loongandy_v3' ||
    selection.config.sampleRate !== 24000 ||
    options.localVoice ||
    options.outgoingPrefixes ||
    options.remoteCaptions === false
  )
    throw new Error('PLANB_BRIDGE_INVALID_SELECTION');
  // All fields are scalars; a copied frozen object prevents a mid-call switch.
  const config = Object.freeze({ ...selection.config });
  const dependencies = Object.freeze({ ...selection.deps });
  const context = createCallContext();
  const sourceOrders = new Map<string, number>();
  const playback = new Map<string, Playback>();
  const deliveries = new Map<string, number>();
  const waiters = new Set<Waiter>();
  let sourceOrder = 0;
  let outstanding = 0;
  let closed = false;
  let local: AliyunPlanBPipeline | undefined;
  let remote: AliyunPlanBPipeline | undefined;
  const notify = <T>(callback: ((value: T) => void) | undefined, value: T) => {
    try {
      callback?.(value);
    } catch {
      // Diagnostic subscribers cannot prevent teardown or change providers.
    }
  };
  const outgoingState = (state: 'connecting' | 'ready' | 'failed') =>
    notify(options.onOutgoingCaptionState, {
      role: 'local',
      state,
      translationSource: 'independent_text',
    });
  const fence = () => {
    if (closed) return;
    closed = true;
    context.close();
    for (const waiter of waiters)
      waiter.reject(new Error('PLANB_BRIDGE_CLOSED'));
    waiters.clear();
    playback.clear();
    deliveries.clear();
    sourceOrders.clear();
    outstanding = 0;
  };
  const wake = () => {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };
  const acknowledge = (id: string) => {
    const record = playback.get(id);
    if (!record || !record.sealed || !record.seen || record.pending.size)
      return;
    local?.acknowledgeAudio(id);
    playback.delete(id);
  };
  const diagnostic = (event: TranslationAudioDiagnostic) => {
    if (
      !closed &&
      event.role === 'local' &&
      event.utteranceId &&
      event.deliveryId
    ) {
      let record = playback.get(event.utteranceId);
      if (event.stage === 'generated') {
        record ||= { pending: new Set(), sealed: false, seen: true };
        record.seen = true;
        playback.set(event.utteranceId, record);
        if (!deliveries.has(event.deliveryId)) {
          deliveries.set(event.deliveryId, event.generatedBytes);
          record.pending.add(event.deliveryId);
          outstanding += event.generatedBytes;
        }
      } else if (event.stage === 'playback_confirmed') {
        const bytes = deliveries.get(event.deliveryId);
        if (bytes !== undefined) {
          deliveries.delete(event.deliveryId);
          record?.pending.delete(event.deliveryId);
          outstanding = Math.max(0, outstanding - bytes);
          wake();
          acknowledge(event.utteranceId);
        }
      }
    }
    notify(options.onAudioDiagnostic, event);
  };
  const beforeAudio = async (
    bytes: number,
    _metadata: PlanBAudioMetadata,
    signal: AbortSignal,
  ) => {
    // Leave a two-second margin below the shared phone bridge's 8s ceiling.
    while (
      !closed &&
      !signal.aborted &&
      outstanding + Math.ceil(bytes / 6) > 48000
    ) {
      await new Promise<void>((resolve, reject) => {
        let waiter: Waiter;
        const abort = () => {
          waiters.delete(waiter);
          reject(new Error('PLANB_BRIDGE_CANCELLED'));
        };
        const cleanup = () => signal.removeEventListener('abort', abort);
        waiter = {
          resolve: () => {
            cleanup();
            resolve();
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        };
        waiters.add(waiter);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (closed || signal.aborted) throw new Error('PLANB_BRIDGE_CLOSED');
  };
  const transcript = (event: TranscriptEvent) => {
    if (closed) return;
    // Valid speech from the opposite source seals only a display/text section;
    // it never cancels already confirmed local voice or blocks remote original.
    if (event.kind === 'original' && event.text.trim()) {
      if (event.role === 'local') remote?.breakSection();
      else local?.breakSection();
    }
    notify(options.onTranscript, event);
  };
  const shared = (
    role: TranslationRole,
  ): Pick<
    AliyunPlanBPipelineOptions,
    | 'config'
    | 'role'
    | 'now'
    | 'timeoutMs'
    | 'getContext'
    | 'onUsage'
    | 'onEvidence'
    | 'onCorrection'
  > => ({
    config,
    role,
    now: options.now,
    timeoutMs: options.sessionTimeoutMs,
    getContext: (query) => context.snapshot(query),
    onUsage: selection.onUsage,
    onEvidence: selection.onEvidence,
    onCorrection: selection.onCorrection,
  });
  const inner = new ContinuousTranslationBridge({
    ...options,
    callContext: context,
    remoteCaptions: true,
    outgoingCaptions: false,
    captionFailureEndsCall: true,
    onAudioDiagnostic: diagnostic,
    onFailure: (code) => {
      outgoingState('failed');
      fence();
      local?.abort();
      remote?.abort();
      notify(options.onFailure, code);
    },
    createClient: (settings) => {
      if (closed || settings.targetLanguage !== 'en')
        throw new Error('PLANB_BRIDGE_ROLE_INVALID');
      outgoingState('connecting');
      local = createAliyunPlanBPipeline({
        ...shared('local'),
        ...dependencies,
        createWebSocket:
          dependencies.createWebSocket || settings.createWebSocket,
        waitForPlayback: true,
        beforeAudio,
        onTranscript: transcript,
        onSource: (source) => {
          if (closed) return;
          let order = sourceOrders.get(source.sourceId);
          if (order === undefined) {
            sourceOrder += 1;
            order = sourceOrder;
            sourceOrders.set(source.sourceId, order);
            if (sourceOrders.size > 1024)
              sourceOrders.delete(sourceOrders.keys().next().value!);
          }
          context.observe({ ...source, order });
        },
        onAudio: (pcm, metadata) => {
          if (!closed) settings.onAudio(pcm, metadata);
        },
        onAudioComplete: (metadata) => {
          if (closed) return;
          const record = playback.get(metadata.utteranceId);
          if (
            !record ||
            !inner.completeOutgoingUtterance(metadata.utteranceId)
          ) {
            settings.onError?.('PLANB_PLAYBACK_IDENTITY_MISSING');
            return;
          }
          record.sealed = true;
          acknowledge(metadata.utteranceId);
        },
        onError: (code) => {
          outgoingState('failed');
          settings.onError?.(code);
        },
      });
      local.ready
        .then(() => {
          if (!closed) outgoingState('ready');
        })
        .catch(() => {});
      if (closed) local.abort();
      return local;
    },
    createCaptionClient: (settings) => {
      if (closed) throw new Error('PLANB_BRIDGE_CLOSED');
      remote = createAliyunPlanBPipeline({
        ...shared('remote'),
        ...dependencies,
        createWebSocket:
          dependencies.createWebSocket || settings.createWebSocket,
        onTranscript: (event) => {
          if (closed) return;
          if (event.kind === 'original' && event.text.trim())
            local?.breakSection();
          settings.onTranscript(event);
        },
        onError: (code) => settings.onError(code),
      });
      if (closed) remote.abort();
      return remote;
    },
  });
  return {
    attach: (role, socket, streamSid) => inner.attach(role, socket, streamSid),
    close: () => {
      fence();
      inner.close();
      local?.abort();
      remote?.abort();
    },
  };
}
