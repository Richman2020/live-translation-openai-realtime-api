import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const MODEL = 'gpt-realtime-2.1';
const VOICE = 'echo';
const INPUT_LIMIT = 24 * 24000 * 2;
const TOKEN_CAP = 512;
const MAX_EVENT = 4 * 1024 * 1024;

type SocketFactory = (
  address: string,
  settings: WebSocket.ClientOptions,
) => WebSocket;
export type AuditionUsage = {
  source: 'response' | 'transcription';
  sequence: number;
  providerStatus?: string;
  basis: 'tokens' | 'duration' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  audioInputTokens?: number;
  textInputTokens?: number;
  cachedInputTokens?: number;
  cachedAudioInputTokens?: number;
  cachedTextInputTokens?: number;
  audioOutputTokens?: number;
  textOutputTokens?: number;
  seconds?: number;
};
export type AuditionTransportSnapshot = {
  state: 'idle' | 'connecting' | 'ready' | 'stopping' | 'closed';
  reason?: string;
  connections: number;
  commits: number;
  responses: number;
  appendBytes: number;
  inlineBytes: number;
  sessionCapConfirmed: boolean;
  sessionInstructionBytes: number;
  asrPromptBytes: number;
  responseCapConfirmed: number;
  requestAccounting: {
    request: number;
    sourceSequence: number;
    inputTextBytes: number;
    instructionBytes: number;
    audioBytes: number;
    contextChars: number;
    sourceChars: number;
    priorAudioBytes: 0;
  }[];
  usage: AuditionUsage[];
  cancellations: { response: number; sent: boolean; terminal: boolean }[];
  unknownUsage: boolean;
  allClosed: boolean;
};
export type AuditionTransportOptions = {
  createWebSocket: SocketFactory;
  onStop?: (reason: string) => void;
  now?: () => number;
  cleanupTimeoutMs?: number;
  readyTimeoutMs?: number;
  progressTimeoutMs?: number;
  wallTimeoutMs?: number;
};

type Source = {
  sequence: number;
  audio: Buffer;
  itemId?: string;
  raw?: string;
  usage: boolean;
  requested: boolean;
};
type Response = {
  sequence: number;
  key: string;
  source: Source;
  id?: string;
  cap: boolean;
  done: boolean;
  status?: string;
  cancel?: { response: number; sent: boolean; terminal: boolean };
};

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(value);
}
function pcm(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('AUDITION_INVALID_AUDIO');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== value)
    throw new Error('AUDITION_INVALID_AUDIO');
  return bytes;
}
function parse(value: unknown): Record<string, any> {
  if (!(typeof value === 'string' || Buffer.isBuffer(value)))
    throw new Error('AUDITION_INVALID_EVENT');
  if (Buffer.byteLength(value) > MAX_EVENT)
    throw new Error('AUDITION_INVALID_EVENT');
  const event = JSON.parse(value.toString());
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('AUDITION_INVALID_EVENT');
  return event;
}
function format(value: any) {
  return value?.type === 'audio/pcm' && value.rate === 24000;
}
function boundedTimer(
  value: number | undefined,
  fallback: number,
  max: number,
) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > max)
    throw new Error('AUDITION_INVALID_OPTIONS');
  return selected;
}

/** Explicitly injected, one-shot transport. This module never constructs a real socket. */
export function createAuditionTransport(options: AuditionTransportOptions) {
  if (typeof options.createWebSocket !== 'function')
    throw new Error('AUDITION_INVALID_OPTIONS');
  const cleanupMs = boundedTimer(options.cleanupTimeoutMs, 3000, 3000);
  const readyMs = boundedTimer(options.readyTimeoutMs, 10000, 10000);
  const progressMs = boundedTimer(options.progressTimeoutMs, 15000, 15000);
  const wallMs = boundedTimer(options.wallTimeoutMs, 120000, 120000);
  const now = options.now ?? Date.now;
  if (!Number.isFinite(now())) throw new Error('AUDITION_INVALID_OPTIONS');
  const data: AuditionTransportSnapshot = {
    state: 'idle',
    connections: 0,
    commits: 0,
    responses: 0,
    appendBytes: 0,
    inlineBytes: 0,
    sessionCapConfirmed: false,
    sessionInstructionBytes: 0,
    asrPromptBytes: 0,
    responseCapConfirmed: 0,
    requestAccounting: [],
    usage: [],
    cancellations: [],
    unknownUsage: false,
    allClosed: true,
  };
  const facade = new EventEmitter();
  facade.on('error', () => {});
  let raw: WebSocket | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let sessionSent = false;
  let sessionCreated = false;
  let instructions = '';
  let asrPrompt = '';
  let append: Buffer[] = [];
  let appendLength = 0;
  let active: Response | undefined;
  const sources: Source[] = [];
  const responses = new Map<string, Response>();
  const sourceItems = new Map<string, Source>();
  const earlyAsr = new Map<string, Record<string, any>[]>();
  const seen = new Set<string>();
  const responseKeys = new Set<string>();
  const running = () => data.state === 'ready' || data.state === 'connecting';
  const clearWorkTimers = () => {
    clearTimeout(readyTimer);
    clearTimeout(progressTimer);
    clearTimeout(wallTimer);
  };
  const finalize = () => {
    if (data.state === 'closed') return;
    clearWorkTimers();
    clearTimeout(cleanupTimer);
    data.state = 'closed';
    data.allClosed = !raw || raw.readyState === WebSocket.CLOSED;
    append = [];
    appendLength = 0;
    for (const source of sources) {
      source.audio = Buffer.alloc(0);
      source.raw = undefined;
    }
    earlyAsr.clear();
    resolveClosed();
  };
  const closeRaw = () => {
    if (data.state === 'closed') return;
    try {
      raw?.terminate();
    } catch {
      // Local fences and promise settlement must survive transport cleanup errors.
    }
    finalize();
  };
  const sendCancel = (response: Response) => {
    if (!response.id || response.done || response.cancel) return;
    const entry = { response: response.sequence, sent: false, terminal: false };
    response.cancel = entry;
    data.cancellations.push(entry);
    if (raw?.readyState === WebSocket.OPEN) {
      try {
        entry.sent = true;
        raw.send(
          JSON.stringify({
            type: 'response.cancel',
            response_id: response.id,
          }),
          (error?: Error) => {
            if (error) entry.sent = false;
          },
        );
      } catch {
        entry.sent = false;
      }
    }
  };
  const stop = (reason: string): Promise<void> => {
    if (data.state === 'closed') return closed;
    if (data.state === 'stopping') {
      if (active) sendCancel(active);
      return closed;
    }
    const fixed = /^AUDITION_[A-Z0-9_]+$/.test(reason)
      ? reason
      : 'AUDITION_STOP_REQUESTED';
    data.state = 'stopping';
    data.reason = fixed;
    clearWorkTimers();
    // This timer is armed before callbacks/cancel sends, both of which can reenter.
    cleanupTimer = setTimeout(closeRaw, cleanupMs);
    if (active) sendCancel(active);
    try {
      if (fixed !== 'AUDITION_COMPLETE') options.onStop?.(fixed);
    } catch {
      // Observer failures cannot reopen the request gate.
    }
    if (
      (!active && sources.every((source) => source.usage)) ||
      !raw ||
      raw.readyState === WebSocket.CLOSED
    )
      closeRaw();
    return closed;
  };
  const touch = () => {
    if (!running()) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      stop('AUDITION_PROGRESS_TIMEOUT');
    }, progressMs);
  };
  const captureUsage = (
    source: AuditionUsage['source'],
    sequence: number,
    value: any,
    providerStatus?: string,
  ) => {
    const entry: AuditionUsage = { source, sequence, basis: 'unknown' };
    if (providerStatus) entry.providerStatus = providerStatus;
    if (value && (source === 'response' || value.type === 'tokens')) {
      const pairs = [
        ['inputTokens', value.input_tokens],
        ['outputTokens', value.output_tokens],
        ['totalTokens', value.total_tokens],
        ['audioInputTokens', value.input_token_details?.audio_tokens],
        ['textInputTokens', value.input_token_details?.text_tokens],
        ['cachedInputTokens', value.input_token_details?.cached_tokens],
        [
          'cachedAudioInputTokens',
          value.input_token_details?.cached_tokens_details?.audio_tokens,
        ],
        [
          'cachedTextInputTokens',
          value.input_token_details?.cached_tokens_details?.text_tokens,
        ],
        ['audioOutputTokens', value.output_token_details?.audio_tokens],
        ['textOutputTokens', value.output_token_details?.text_tokens],
      ] as const;
      for (const [key, count] of pairs)
        if (Number.isSafeInteger(count) && count >= 0) {
          entry[key] = count;
          entry.basis = 'tokens';
        }
    } else if (
      value?.type === 'duration' &&
      typeof value.seconds === 'number' &&
      Number.isFinite(value.seconds) &&
      value.seconds >= 0
    ) {
      entry.basis = 'duration';
      entry.seconds = value.seconds;
    }
    const count = (amount: unknown): amount is number =>
      Number.isSafeInteger(amount) && (amount as number) >= 0;
    const completeTotals =
      count(entry.inputTokens) &&
      count(entry.outputTokens) &&
      count(entry.totalTokens) &&
      entry.inputTokens + entry.outputTokens === entry.totalTokens;
    const completeResponseDetails =
      source !== 'response' ||
      (count(entry.audioInputTokens) &&
        count(entry.textInputTokens) &&
        count(entry.audioOutputTokens) &&
        count(entry.textOutputTokens) &&
        count(entry.cachedInputTokens) &&
        entry.audioInputTokens + entry.textInputTokens === entry.inputTokens &&
        entry.audioOutputTokens + entry.textOutputTokens ===
          entry.outputTokens &&
        (entry.cachedInputTokens === 0 ||
          (count(entry.cachedAudioInputTokens) &&
            count(entry.cachedTextInputTokens) &&
            entry.cachedAudioInputTokens + entry.cachedTextInputTokens ===
              entry.cachedInputTokens &&
            entry.cachedAudioInputTokens <= entry.audioInputTokens &&
            entry.cachedTextInputTokens <= entry.textInputTokens)));
    if (
      entry.basis === 'unknown' ||
      (entry.basis === 'tokens' &&
        (!completeTotals || !completeResponseDetails))
    )
      data.unknownUsage = true;
    data.usage.push(entry);
  };
  const validateSession = (session: any, effective: boolean) => {
    if (
      session?.type !== 'realtime' ||
      (effective && session.model !== MODEL) ||
      (!effective && session.model !== undefined) ||
      session.audio?.output?.voice !== VOICE ||
      !format(session.audio?.input?.format) ||
      !format(session.audio?.output?.format) ||
      JSON.stringify(session.output_modalities) !== '["audio"]' ||
      session.audio?.input?.transcription?.model !== 'gpt-4o-transcribe' ||
      session.audio?.input?.transcription?.language !== 'zh' ||
      session.audio?.input?.turn_detection !== null ||
      JSON.stringify(session.tools) !== '[]' ||
      session.tool_choice !== 'none' ||
      session.tracing !== null ||
      typeof session.instructions !== 'string' ||
      !session.instructions ||
      Buffer.byteLength(session.instructions) > 2048 ||
      typeof session.audio?.input?.transcription?.prompt !== 'string' ||
      Buffer.byteLength(session.audio.input.transcription.prompt) > 512 ||
      (effective &&
        (session.instructions !== instructions ||
          session.audio.input.transcription.prompt !== asrPrompt ||
          session.max_output_tokens !== TOKEN_CAP))
    )
      throw new Error('AUDITION_SESSION_MISMATCH');
  };
  const acceptOutbound = (event: Record<string, any>) => {
    if (!running()) throw new Error('AUDITION_STOPPED');
    if (event.type === 'session.update') {
      if (sessionSent || data.state !== 'connecting')
        throw new Error('AUDITION_EXTRA_SESSION_UPDATE');
      validateSession(event.session, false);
      if (
        event.session.max_output_tokens !== undefined &&
        event.session.max_output_tokens !== TOKEN_CAP
      )
        throw new Error('AUDITION_OUTPUT_CAP_MISMATCH');
      sessionSent = true;
      instructions = event.session.instructions;
      asrPrompt = event.session.audio.input.transcription.prompt;
      data.sessionInstructionBytes = Buffer.byteLength(instructions);
      data.asrPromptBytes = Buffer.byteLength(asrPrompt);
      event.session.max_output_tokens = TOKEN_CAP;
      return event;
    }
    if (data.state !== 'ready' || !data.sessionCapConfirmed)
      throw new Error('AUDITION_REQUEST_BEFORE_READY');
    if (event.type === 'input_audio_buffer.append') {
      if (data.commits >= 6) throw new Error('AUDITION_COMMIT_LIMIT');
      const audio = pcm(event.audio);
      if (data.appendBytes + audio.length > INPUT_LIMIT)
        throw new Error('AUDITION_INPUT_LIMIT');
      data.appendBytes += audio.length;
      append.push(audio);
      appendLength += audio.length;
      touch();
      return event;
    }
    if (event.type === 'input_audio_buffer.commit') {
      if (data.commits >= 6) throw new Error('AUDITION_COMMIT_LIMIT');
      if (!appendLength) throw new Error('AUDITION_EMPTY_COMMIT');
      data.commits += 1;
      sources.push({
        sequence: data.commits,
        audio: Buffer.concat(append, appendLength),
        requested: false,
        usage: false,
      });
      append = [];
      appendLength = 0;
      touch();
      return event;
    }
    if (event.type === 'response.create') {
      if (data.responses >= 6) throw new Error('AUDITION_RESPONSE_LIMIT');
      if (active) throw new Error('AUDITION_OVERLAPPING_RESPONSE');
      const { response } = event;
      const source = sources.find((item) => !item.requested);
      if (
        !source ||
        !source.itemId ||
        source.raw === undefined ||
        response?.conversation !== 'none' ||
        JSON.stringify(response.output_modalities) !== '["audio"]' ||
        response.instructions !== instructions ||
        response.audio?.output?.voice !== VOICE ||
        !format(response.audio?.output?.format) ||
        JSON.stringify(response.tools) !== '[]' ||
        response.tool_choice !== 'none' ||
        !id(response.metadata?.prototype_request) ||
        responseKeys.has(response.metadata.prototype_request) ||
        !Array.isArray(response.input) ||
        response.input.length !== 1 ||
        response.input[0]?.type !== 'message' ||
        response.input[0]?.role !== 'user' ||
        !Array.isArray(response.input[0]?.content) ||
        response.input[0].content.length !== 2 ||
        response.input[0].content[0]?.type !== 'input_text' ||
        response.input[0].content[1]?.type !== 'input_audio'
      )
        throw new Error('AUDITION_RESPONSE_INPUT_MISMATCH');
      if (
        response.max_output_tokens !== undefined &&
        response.max_output_tokens !== TOKEN_CAP
      )
        throw new Error('AUDITION_OUTPUT_CAP_MISMATCH');
      const { text } = response.input[0].content[0];
      if (typeof text !== 'string' || Buffer.byteLength(text) > 2048)
        throw new Error('AUDITION_TEXT_LIMIT');
      const context = JSON.parse(text);
      if (
        !context ||
        Object.keys(context).sort().join(',') !==
          'current_asr_observation,recent_raw_call_context' ||
        context.current_asr_observation !== source.raw ||
        !Array.isArray(context.recent_raw_call_context) ||
        context.recent_raw_call_context.length > 6 ||
        context.recent_raw_call_context.some(
          (entry: any) =>
            !entry ||
            Object.keys(entry).sort().join(',') !== 'role,text' ||
            !['local', 'remote'].includes(entry.role) ||
            typeof entry.text !== 'string',
        )
      )
        throw new Error('AUDITION_CONTEXT_MISMATCH');
      const contextChars = context.recent_raw_call_context.reduce(
        (total: number, item: any) => total + item.text.length,
        0,
      );
      if (contextChars > 1600) throw new Error('AUDITION_TEXT_LIMIT');
      const audio = pcm(response.input[0].content[1].audio);
      if (!audio.equals(source.audio))
        throw new Error('AUDITION_AUDIO_BINDING_MISMATCH');
      if (data.inlineBytes + audio.length > INPUT_LIMIT)
        throw new Error('AUDITION_INLINE_LIMIT');
      response.max_output_tokens = TOKEN_CAP;
      source.requested = true;
      data.responses += 1;
      data.inlineBytes += audio.length;
      responseKeys.add(response.metadata.prototype_request);
      active = {
        sequence: data.responses,
        key: response.metadata.prototype_request,
        source,
        cap: false,
        done: false,
      };
      data.requestAccounting.push({
        request: data.responses,
        sourceSequence: source.sequence,
        inputTextBytes: Buffer.byteLength(text),
        instructionBytes: Buffer.byteLength(response.instructions),
        audioBytes: audio.length,
        contextChars,
        sourceChars: source.raw.length,
        priorAudioBytes: 0,
      });
      touch();
      return event;
    }
    if (event.type === 'conversation.item.delete') {
      const source = sourceItems.get(event.item_id);
      if (
        !source ||
        active?.source === source ||
        (!source.requested && (source.raw === undefined || source.raw.trim()))
      )
        throw new Error('AUDITION_INVALID_ITEM_DELETE');
      source.requested = true;
      return event;
    }
    if (event.type === 'response.cancel') {
      if (!active?.id || event.response_id !== active.id)
        throw new Error('AUDITION_INVALID_CANCEL');
      stop('AUDITION_CANCEL_REQUESTED');
      return undefined;
    }
    throw new Error('AUDITION_UNEXPECTED_REQUEST');
  };
  const receive = (rawEvent: unknown) => {
    if (data.state === 'closed') return;
    let event: Record<string, any>;
    try {
      event = parse(rawEvent);
      if (!id(event.event_id) || typeof event.type !== 'string')
        throw new Error('AUDITION_INVALID_EVENT');
      if (seen.has(event.event_id)) return;
      if (seen.size >= 8192) throw new Error('AUDITION_EVENT_LIMIT');
      seen.add(event.event_id);
      if (event.type === 'error') {
        stop('AUDITION_PROVIDER_REJECTED');
        return;
      }
      if (event.type === 'session.updated') {
        if (data.state !== 'connecting' || !sessionSent)
          throw new Error('AUDITION_EXTRA_SESSION_ACK');
        validateSession(event.session, true);
        data.sessionCapConfirmed = true;
        data.state = 'ready';
        clearTimeout(readyTimer);
      } else if (event.type === 'session.created') {
        if (data.state !== 'connecting' || sessionCreated)
          throw new Error('AUDITION_EXTRA_SESSION_CREATED');
        sessionCreated = true;
      } else if (event.type === 'input_audio_buffer.committed') {
        if (sourceItems.has(event.item_id)) return;
        const source = sources.find((item) => !item.itemId);
        if (!source || !id(event.item_id))
          throw new Error('AUDITION_COMMIT_ACK_MISMATCH');
        source.itemId = event.item_id;
        sourceItems.set(event.item_id, source);
        touch();
        const queued = earlyAsr.get(event.item_id) ?? [];
        earlyAsr.delete(event.item_id);
        if (queued.length) {
          if (running()) facade.emit('message', JSON.stringify(event));
          for (const pending of queued) {
            seen.delete(pending.event_id);
            receive(JSON.stringify(pending));
          }
          return;
        }
      } else if (
        event.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        const source = sourceItems.get(event.item_id);
        if (
          !source &&
          id(event.item_id) &&
          sources.some((item) => !item.itemId)
        ) {
          const queued = earlyAsr.get(event.item_id) ?? [];
          if (earlyAsr.size >= 6 || queued.length >= 8)
            throw new Error('AUDITION_EVENT_LIMIT');
          queued.push(event);
          earlyAsr.set(event.item_id, queued);
          return;
        }
        if (
          !source ||
          event.content_index !== 0 ||
          typeof event.transcript !== 'string'
        )
          throw new Error('AUDITION_ASR_MISMATCH');
        const unchanged = source.raw === event.transcript;
        source.raw = event.transcript;
        if (!source.usage) {
          source.usage = true;
          captureUsage('transcription', source.sequence, event.usage);
        }
        if (
          data.state === 'stopping' &&
          !active &&
          sources.every((item) => item.usage)
        ) {
          closeRaw();
          return;
        }
        if (unchanged) return;
        touch();
      } else if (event.type === 'response.created') {
        const { response } = event;
        if (responses.has(response?.id)) return;
        if (
          !active ||
          active.id ||
          !id(response?.id) ||
          response.metadata?.prototype_request !== active.key
        )
          throw new Error('AUDITION_RESPONSE_ACK_MISMATCH');
        active.id = response.id;
        responses.set(active.id!, active);
        if (response.max_output_tokens !== TOKEN_CAP)
          throw new Error('AUDITION_OUTPUT_CAP_UNCONFIRMED');
        active.cap = true;
        data.responseCapConfirmed += 1;
        touch();
        if (data.state === 'stopping') sendCancel(active);
      } else if (event.type === 'response.done') {
        const response = responses.get(event.response?.id);
        if (!response || response.done) return;
        response.done = true;
        if (response.cancel) response.cancel.terminal = true;
        const status = [
          'completed',
          'cancelled',
          'failed',
          'incomplete',
        ].includes(event.response.status)
          ? event.response.status
          : 'unknown';
        response.status = status;
        captureUsage(
          'response',
          response.sequence,
          event.response.usage,
          status,
        );
        if (active === response) active = undefined;
        if (data.state === 'stopping') {
          if (sources.every((source) => source.usage)) closeRaw();
          return;
        }
        if (status !== 'completed') {
          stop('AUDITION_RESPONSE_NOT_COMPLETED');
          return;
        }
        if (
          event.response.usage?.output_tokens !== undefined &&
          (!Number.isSafeInteger(event.response.usage.output_tokens) ||
            event.response.usage.output_tokens > TOKEN_CAP)
        )
          throw new Error('AUDITION_OUTPUT_CAP_VIOLATED');
        touch();
      } else if (event.type.startsWith('response.output_audio')) {
        if (!active?.id || !active.cap || event.response_id !== active.id)
          throw new Error('AUDITION_AUDIO_BEFORE_CAP_ACK');
        touch();
      } else if (
        event.type === 'conversation.item.input_audio_transcription.failed'
      ) {
        stop('AUDITION_ASR_FAILED');
        return;
      }
      if (running()) facade.emit('message', JSON.stringify(event));
    } catch (error) {
      const code =
        error instanceof Error && /^AUDITION_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'AUDITION_INVALID_EVENT';
      stop(code);
    }
  };
  const socket = facade as unknown as WebSocket;
  Object.defineProperties(facade, {
    readyState: {
      get: () => {
        if (data.state === 'closed') return WebSocket.CLOSED;
        if (data.state === 'stopping') return WebSocket.CLOSING;
        return raw?.readyState ?? WebSocket.CONNECTING;
      },
    },
    bufferedAmount: { get: () => raw?.bufferedAmount ?? 0 },
  });
  socket.send = ((value: unknown, callback?: (error?: Error) => void) => {
    if (!running()) {
      callback?.(new Error('AUDITION_STOPPED'));
      return;
    }
    try {
      const event = acceptOutbound(parse(value));
      if (!event || !running()) {
        callback?.(new Error('AUDITION_STOPPED'));
        return;
      }
      if (raw?.readyState !== WebSocket.OPEN)
        throw new Error('AUDITION_SEND_UNAVAILABLE');
      raw.send(JSON.stringify(event), (error?: Error) => {
        if (error) stop('AUDITION_SEND_FAILED');
        callback?.(error ? new Error('AUDITION_SEND_FAILED') : undefined);
      });
    } catch (error) {
      const code =
        error instanceof Error && /^AUDITION_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'AUDITION_INVALID_REQUEST';
      stop(code);
      callback?.(new Error(code));
    }
  }) as WebSocket['send'];
  const clean = () =>
    data.state === 'ready' &&
    data.sessionCapConfirmed &&
    !active &&
    !appendLength &&
    sources.every((source) => source.usage && source.requested) &&
    data.responses === responses.size &&
    [...responses.values()].every(
      (response) => response.done && response.status === 'completed',
    );
  socket.terminate = () => {
    if (data.state === 'stopping' || data.state === 'closed') return;
    stop(
      clean() && data.responses > 0
        ? 'AUDITION_COMPLETE'
        : 'AUDITION_PARENT_TERMINATED',
    );
  };
  socket.close = () => socket.terminate();
  return {
    createWebSocket(address: string, settings: WebSocket.ClientOptions) {
      if (data.connections || data.state !== 'idle') {
        stop('AUDITION_CONNECTION_LIMIT');
        throw new Error('AUDITION_CONNECTION_LIMIT');
      }
      if (address !== `wss://api.openai.com/v1/realtime?model=${MODEL}`) {
        stop('AUDITION_MODEL_ENDPOINT_MISMATCH');
        throw new Error('AUDITION_MODEL_ENDPOINT_MISMATCH');
      }
      data.connections = 1;
      data.state = 'connecting';
      data.allClosed = false;
      try {
        raw = options.createWebSocket(address, settings);
      } catch {
        stop('AUDITION_CONNECT_FAILED');
        throw new Error('AUDITION_CONNECT_FAILED');
      }
      raw.on('open', () => {
        if (data.state === 'connecting') facade.emit('open');
      });
      raw.on('message', receive);
      raw.on('error', () => {
        stop('AUDITION_TRANSPORT_ERROR');
      });
      raw.on('close', () => {
        if (data.state === 'closed') {
          data.allClosed = true;
          return;
        }
        if (data.state !== 'stopping') {
          stop('AUDITION_TRANSPORT_CLOSED');
        }
        finalize();
        data.allClosed = true;
      });
      readyTimer = setTimeout(() => {
        stop('AUDITION_READY_TIMEOUT');
      }, readyMs);
      wallTimer = setTimeout(() => {
        stop('AUDITION_WALL_TIMEOUT');
      }, wallMs);
      return socket;
    },
    stop,
    closeSuccess() {
      if (!clean()) return stop('AUDITION_INCOMPLETE_CLOSE');
      return stop('AUDITION_COMPLETE');
    },
    snapshot(): AuditionTransportSnapshot {
      const copy = JSON.parse(
        JSON.stringify(data),
      ) as AuditionTransportSnapshot;
      copy.unknownUsage =
        copy.unknownUsage ||
        sources.some((source) => !source.usage) ||
        [...responses.values()].some((response) => !response.done) ||
        Boolean(active);
      return copy;
    },
    closed,
  };
}
