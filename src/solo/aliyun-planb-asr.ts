import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import type { CallContextSnapshot } from './call-context';
import { createPlanBWebSocket } from './aliyun-planb-network';
import type {
  PlanBAsrClient,
  PlanBAsrDiagnostic,
  PlanBAsrDiagnosticDecision,
  PlanBAsrDiagnosticFieldState,
  PlanBAsrDiagnosticSnapshot,
  PlanBAsrDiagnosticTextState,
  PlanBAsrOptions,
  PlanBAsrSource,
  PlanBEvidence,
} from './aliyun-planb-types';

const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_APPEND_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_SOURCE_CHARACTERS = 4096;
const MAX_RETAINED_SOURCES = 128;
const MAX_UNFINISHED_SOURCES = 32;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

type Source = PlanBAsrSource & {
  begin: number;
  providerEnd?: number;
  acceptedDiagnostic: PlanBAsrDiagnosticSnapshot;
  /** One payload before the last accepted start revision; never exported. */
  previousRefinement?: { begin: number; text: string };
  /** One known start alias after finalization; never permits another source. */
  finalBeginAlias?: number;
};

function diagnosticFieldState(
  value: unknown,
  valid: boolean,
): PlanBAsrDiagnosticFieldState {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  return valid ? 'valid' : 'invalid';
}

function diagnosticTextState(value: unknown): PlanBAsrDiagnosticTextState {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value !== 'string') return 'invalid';
  if (value.length > MAX_SOURCE_CHARACTERS) return 'too-long';
  if (!value.length) return 'empty';
  return value.trim() ? 'nonempty' : 'whitespace';
}

/** Read only scalar field shapes; raw objects and strings never escape. */
function diagnosticSnapshot(
  sentence: any,
  arrivalSequence: number,
): PlanBAsrDiagnosticSnapshot {
  const id = sentence?.sentence_id;
  const begin = sentence?.begin_time;
  const end = sentence?.end_time;
  const final = sentence?.sentence_end;
  const sentenceBegin = sentence?.sentence_begin;
  const heartbeat = sentence?.heartbeat;
  const idValid = integer(id) && id !== Number.MAX_SAFE_INTEGER;
  return {
    arrivalSequence,
    providerSentenceId: idValid ? id : null,
    sourceSequence: idValid ? id + 1 : null,
    idState: diagnosticFieldState(id, idValid),
    beginState: diagnosticFieldState(begin, integer(begin)),
    endState: diagnosticFieldState(end, integer(end)),
    finalState: diagnosticFieldState(final, typeof final === 'boolean'),
    sentenceBeginState: diagnosticFieldState(
      sentenceBegin,
      typeof sentenceBegin === 'boolean',
    ),
    heartbeatState: diagnosticFieldState(
      heartbeat,
      typeof heartbeat === 'boolean',
    ),
    beginMs: integer(begin) ? begin : null,
    endMs: integer(end) ? end : null,
    final: typeof final === 'boolean' ? final : null,
    sentenceBegin: typeof sentenceBegin === 'boolean' ? sentenceBegin : null,
    heartbeat: typeof heartbeat === 'boolean' ? heartbeat : null,
    textState: diagnosticTextState(sentence?.text),
  };
}

type RawContext = {
  role: 'user';
  content: { type: 'input_text'; text: string }[];
};

/** Formal Fun-ASR context: sourced raw text only; never cut a number mid-source. */
function rawContext(
  snapshot: CallContextSnapshot | undefined,
  role: string,
): RawContext[] {
  if (!snapshot || !Array.isArray(snapshot.entries)) return [];
  return snapshot.entries
    .filter(
      (entry) =>
        entry.role === role &&
        (entry.sourceKind === 'asr' || entry.sourceKind === 'native_source') &&
        !entry.generated &&
        !entry.provisional &&
        typeof entry.text === 'string' &&
        entry.text.trim() &&
        entry.text.length <= 400 &&
        integer(entry.at) &&
        integer(entry.order),
    )
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .slice(-5)
    .map((entry) => ({
      role: 'user',
      content: [{ type: 'input_text', text: entry.text }],
    }));
}

/** One role, one duplex task; no retry, reconnect or total-call duration limit. */
export function createAliyunPlanBAsrClient(
  options: PlanBAsrOptions,
): PlanBAsrClient {
  const { config, role } = options;
  if (
    !['local', 'remote'].includes(role) ||
    config?.asrModel !== 'fun-asr-realtime' ||
    config?.sampleRate !== 24000
  )
    throw new Error('PLAN_B_ASR_CONFIG_INVALID');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000)
    throw new Error('PLAN_B_ASR_TIMEOUT_INVALID');
  const clock = options.now ?? Date.now;
  const taskId = randomUUID();
  const sources = new Map<number, Source>();
  // Count successfully queued PCM samples, not supplier usage or wall time.
  // BigInt avoids adding a new total-duration limit to production streaming.
  let sentPcmSamples = 0n;
  let sourceArrivalSequence = 0;
  let lastSourceArrival: PlanBAsrDiagnosticSnapshot | null = null;
  let retiredThrough = -1;
  let state: 'connecting' | 'starting' | 'ready' | 'finishing' | 'closed' =
    'connecting';
  let taskStarted = false;
  let finishRequested = false;
  let anchor = 0;
  let lastDuration = -1;
  let failure: string | undefined;
  let contextSerialized = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let finishResolve!: () => void;
  let finishReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finished = new Promise<void>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  // Callers can inspect rejected promises later without process-level rejection.
  ready.catch(() => undefined);
  finished.catch(() => undefined);
  const socket = createPlanBWebSocket(config, options.createWebSocket);
  const isClosed = () => state === 'closed';

  const evidence = (
    event: PlanBEvidence['event'],
    code?: string,
    closeCode?: number,
  ) => {
    try {
      options.onEvidence?.({
        layer: 'asr',
        event,
        role,
        region: config.region,
        sequence: 1,
        model: config.asrModel,
        sampleRate: config.sampleRate,
        ...(code ? { code } : {}),
        ...(integer(closeCode) && closeCode >= 1000 && closeCode <= 4999
          ? { closeCode }
          : {}),
      });
    } catch {
      /* Evidence callbacks cannot expose raw provider exceptions. */
    }
  };
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    sources.clear();
    socket.removeAllListeners();
    // A late transport error must not become an unhandled EventEmitter error.
    socket.on('error', () => undefined);
    try {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    } catch {
      /* Local state remains fenced even if transport teardown fails. */
    }
  };
  const fail = (code: string, closeCode?: number) => {
    if (state === 'closed') return;
    failure = code;
    state = 'closed';
    cleanup();
    readyReject(new Error(code));
    finishReject(new Error(code));
    evidence('failed', code, closeCode);
    try {
      options.onError(code);
    } catch {
      /* No provider text is rethrown. */
    }
  };
  const arm = (code: string) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fail(code), timeoutMs);
  };
  const send = (value: object | Buffer): boolean => {
    if (state === 'closed') return false;
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_PENDING_BYTES
    ) {
      fail('PLAN_B_ASR_TRANSPORT_UNAVAILABLE');
      return false;
    }
    try {
      socket.send(
        Buffer.isBuffer(value) ? value : JSON.stringify(value),
        (error) => {
          if (error) fail('PLAN_B_ASR_SEND_FAILED');
        },
      );
      return !isClosed();
    } catch {
      fail('PLAN_B_ASR_SEND_FAILED');
      return false;
    }
  };
  const currentContext = () => {
    try {
      return rawContext(options.getContext?.(), role);
    } catch {
      fail('PLAN_B_ASR_CONTEXT_FAILED');
      return [];
    }
  };
  const sendFinish = () => {
    if (!taskStarted || state === 'closed' || state === 'finishing') return;
    state = 'finishing';
    arm('PLAN_B_ASR_FINISH_TIMEOUT');
    send({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} },
    });
  };
  const usage = (value: unknown) => {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value <= lastDuration
    )
      return;
    lastDuration = value;
    try {
      options.onUsage?.({
        layer: 'asr',
        role,
        region: config.region,
        taskSequence: 1,
        durationSeconds: value,
        basis: 'provider_reported',
      });
    } catch {
      fail('PLAN_B_ASR_CALLBACK_FAILED');
    }
  };
  const receiveSource = (sentence: any) => {
    sourceArrivalSequence += 1;
    const incoming = diagnosticSnapshot(sentence, sourceArrivalSequence);
    const previousArrival = lastSourceArrival;
    lastSourceArrival = incoming;
    const diagnostic = (
      decision: PlanBAsrDiagnosticDecision,
      prior?: Source,
    ) => {
      if (!options.onSourceDiagnostic) return;
      const previousAccepted = prior?.acceptedDiagnostic ?? null;
      // Every snapshot given to an observer is a separate scalar-only copy.
      const value: PlanBAsrDiagnostic = {
        arrivalSequence: incoming.arrivalSequence,
        decision,
        incoming: { ...incoming },
        previousAccepted: previousAccepted ? { ...previousAccepted } : null,
        previousArrival: previousArrival ? { ...previousArrival } : null,
        beginChanged:
          previousAccepted?.beginMs !== undefined &&
          previousAccepted.beginMs !== null &&
          incoming.beginMs !== null
            ? previousAccepted.beginMs !== incoming.beginMs
            : null,
        endRegressed:
          previousAccepted?.endMs !== undefined &&
          previousAccepted.endMs !== null &&
          incoming.endMs !== null
            ? incoming.endMs < previousAccepted.endMs
            : null,
        textChanged:
          prior && typeof sentence?.text === 'string'
            ? prior.text !== sentence.text
            : null,
      };
      try {
        options.onSourceDiagnostic(value);
      } catch {
        /* Diagnostic observers cannot alter source decisions or teardown. */
      }
    };
    if (sentence?.heartbeat === true) {
      diagnostic('heartbeat_ignored');
      return;
    }
    if (
      !sentence ||
      !integer(sentence.sentence_id) ||
      sentence.sentence_id === Number.MAX_SAFE_INTEGER ||
      !integer(sentence.begin_time) ||
      typeof sentence.text !== 'string' ||
      sentence.text.length > MAX_SOURCE_CHARACTERS ||
      typeof sentence.sentence_end !== 'boolean' ||
      (sentence.end_time !== undefined &&
        sentence.end_time !== null &&
        (!integer(sentence.end_time) ||
          sentence.end_time < sentence.begin_time)) ||
      (sentence.sentence_end && !integer(sentence.end_time))
    ) {
      diagnostic('invalid_source');
      fail('PLAN_B_ASR_SOURCE_INVALID');
      return;
    }
    const id: number = sentence.sentence_id;
    if (id <= retiredThrough) {
      diagnostic('retired_source_ignored');
      return;
    }
    const prior = sources.get(id);
    const providerEnd = integer(sentence.end_time)
      ? sentence.end_time
      : undefined;
    const noStartFlag = (shape: PlanBAsrDiagnosticSnapshot) =>
      shape.sentenceBeginState !== 'invalid' &&
      shape.sentenceBegin !== true &&
      shape.heartbeatState !== 'invalid' &&
      shape.heartbeat !== true;
    const respectsFinalBounds = (begin: number, end: number) => {
      if (
        end < Math.max(begin, prior?.begin ?? begin) ||
        BigInt(end) * 24n > sentPcmSamples
      )
        return false;
      for (const [otherId, other] of sources) {
        if (
          (otherId < id && begin < (other.providerEnd ?? other.begin)) ||
          (otherId > id && end > other.begin)
        )
          return false;
      }
      return true;
    };
    let beginRefined = false;
    let beginAliasRevised = false;
    let finalBeginAliased = false;
    if (prior) {
      if (sentence.begin_time !== prior.begin) {
        finalBeginAliased =
          !prior.final &&
          sentence.sentence_end &&
          prior.previousRefinement?.begin === sentence.begin_time &&
          noStartFlag(prior.acceptedDiagnostic) &&
          noStartFlag(incoming) &&
          respectsFinalBounds(sentence.begin_time, providerEnd!);
        const knownFinalAlias =
          prior.final &&
          prior.finalBeginAlias === sentence.begin_time &&
          noStartFlag(incoming) &&
          (providerEnd === undefined ||
            respectsFinalBounds(sentence.begin_time, providerEnd));
        const nullEndPartial = (shape: PlanBAsrDiagnosticSnapshot) =>
          shape.final === false &&
          shape.endState === 'null' &&
          shape.textState === 'nonempty' &&
          noStartFlag(shape);
        const refiningPartial =
          !prior.final &&
          nullEndPartial(prior.acceptedDiagnostic) &&
          nullEndPartial(incoming);
        if (
          refiningPartial &&
          prior.previousRefinement?.begin === sentence.begin_time &&
          prior.previousRefinement.text === sentence.text
        ) {
          diagnostic('partial_begin_replay_ignored', prior);
          return;
        }
        const respectsNeighbors = () => {
          for (const [otherId, other] of sources) {
            if (
              (otherId < id &&
                sentence.begin_time < (other.providerEnd ?? other.begin)) ||
              (otherId > id && sentence.begin_time >= other.begin)
            )
              return false;
          }
          return true;
        };
        beginRefined =
          refiningPartial &&
          sentence.begin_time >
            Math.max(
              prior.begin,
              prior.previousRefinement?.begin ?? prior.begin,
            ) &&
          // Fixed 24kHz PCM contains 24 samples per provider millisecond.
          BigInt(sentence.begin_time) * 24n <= sentPcmSamples &&
          respectsNeighbors();
        beginAliasRevised =
          refiningPartial &&
          prior.previousRefinement?.begin === sentence.begin_time &&
          prior.previousRefinement.text !== sentence.text &&
          BigInt(sentence.begin_time) * 24n <= sentPcmSamples &&
          respectsNeighbors();
        if (
          !beginRefined &&
          !beginAliasRevised &&
          !finalBeginAliased &&
          !knownFinalAlias
        ) {
          diagnostic('begin_conflict', prior);
          fail('PLAN_B_ASR_SOURCE_ID_CONFLICT');
          return;
        }
      }
      if (prior.final) {
        if (sentence.text !== prior.text || !sentence.sentence_end) {
          diagnostic('final_revision_ignored', prior);
          if (isClosed()) return;
          evidence('correction', 'PLAN_B_ASR_LATE_SOURCE_IGNORED');
        } else diagnostic('final_duplicate_ignored', prior);
        return;
      }
      if (
        prior.providerEnd !== undefined &&
        (providerEnd === undefined || providerEnd < prior.providerEnd)
      ) {
        diagnostic('endpoint_regression_ignored', prior);
        return;
      }
      if (
        !beginRefined &&
        !beginAliasRevised &&
        prior.text === sentence.text &&
        prior.final === sentence.sentence_end &&
        prior.providerEnd === providerEnd
      ) {
        diagnostic('duplicate_ignored', prior);
        return;
      }
    }
    if (!sentence.text.trim() && !prior) {
      diagnostic('empty_new_source_ignored');
      return;
    }
    let finalBeginAlias: number | undefined;
    if (
      sentence.sentence_end &&
      prior?.previousRefinement &&
      noStartFlag(prior.acceptedDiagnostic) &&
      noStartFlag(incoming) &&
      respectsFinalBounds(prior.previousRefinement.begin, providerEnd!)
    )
      finalBeginAlias = finalBeginAliased
        ? prior.begin
        : prior.previousRefinement.begin;
    let previousRefinement: Source['previousRefinement'];
    if (beginRefined || beginAliasRevised)
      previousRefinement = { begin: prior!.begin, text: prior!.text };
    else if (!sentence.sentence_end && prior?.previousRefinement)
      previousRefinement = prior.previousRefinement;
    const source: Source = {
      // Preserve provider order, including defensive non-heartbeat ID 0 support.
      sequence: id + 1,
      revision: (prior?.revision ?? 0) + 1,
      text: sentence.text,
      final: sentence.sentence_end,
      // An accepted source keeps its identity/time across bounded start edits.
      at: prior?.at ?? anchor + sentence.begin_time,
      begin: sentence.begin_time,
      acceptedDiagnostic: incoming,
      ...(previousRefinement ? { previousRefinement } : {}),
      ...(finalBeginAlias === undefined ? {} : { finalBeginAlias }),
      ...(providerEnd === undefined ? {} : { providerEnd }),
      ...(sentence.sentence_end ? { endAt: anchor + providerEnd! } : {}),
    };
    if (
      !Number.isSafeInteger(source.at) ||
      (source.endAt !== undefined && !Number.isSafeInteger(source.endAt))
    ) {
      diagnostic('invalid_source_time', prior);
      fail('PLAN_B_ASR_SOURCE_TIME_INVALID');
      return;
    }
    sources.set(id, source);
    if (
      [...sources.values()].filter((entry) => !entry.final).length >
      MAX_UNFINISHED_SOURCES
    ) {
      diagnostic('source_backlog', prior);
      fail('PLAN_B_ASR_SOURCE_BACKLOG');
      return;
    }
    while (sources.size > MAX_RETAINED_SOURCES) {
      const oldest = Math.min(...sources.keys());
      if (!sources.get(oldest)!.final) {
        diagnostic('source_backlog', prior);
        fail('PLAN_B_ASR_SOURCE_BACKLOG');
        return;
      }
      sources.delete(oldest);
      retiredThrough = Math.max(retiredThrough, oldest);
    }
    let decision: PlanBAsrDiagnosticDecision = 'accepted';
    if (beginRefined) decision = 'partial_begin_refined';
    else if (beginAliasRevised) decision = 'partial_begin_alias_revised';
    else if (finalBeginAliased) decision = 'final_begin_alias_accepted';
    diagnostic(decision, prior);
    if (isClosed()) return;
    try {
      options.onSource({
        sequence: source.sequence,
        revision: source.revision,
        text: source.text,
        final: source.final,
        at: source.at,
        ...(source.endAt === undefined ? {} : { endAt: source.endAt }),
      });
    } catch {
      fail('PLAN_B_ASR_CALLBACK_FAILED');
    }
  };

  socket.on('open', () => {
    if (state !== 'connecting') return;
    state = 'starting';
    const context = currentContext();
    if (isClosed()) return;
    contextSerialized = JSON.stringify(context);
    send({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: config.asrModel,
        parameters: {
          format: 'pcm',
          sample_rate: 24000,
          language_hints: [role === 'local' ? 'zh' : 'en'],
          // Official Fun-ASR silence keepalive; genuine close/error still fails
          // this task and no automatic reconnect or provider fallback exists.
          heartbeat: true,
        },
        input: context.length ? { context } : {},
      },
    });
  });
  socket.on('message', (raw: WebSocket.RawData, isBinary?: boolean) => {
    if (state === 'closed') return;
    if (isBinary) {
      fail('PLAN_B_ASR_UNEXPECTED_BINARY');
      return;
    }
    const bytes = Buffer.isBuffer(raw)
      ? raw
      : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
    if (bytes.length > MAX_EVENT_BYTES) {
      fail('PLAN_B_ASR_EVENT_TOO_LARGE');
      return;
    }
    let event: any;
    try {
      event = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('PLAN_B_ASR_EVENT_INVALID');
      return;
    }
    if (!event?.header || event.header.task_id !== taskId) return;
    const name = event.header.event;
    if (name === 'task-failed') {
      fail('PLAN_B_ASR_PROVIDER_FAILED');
      return;
    }
    if (name === 'task-started') {
      if (taskStarted) return;
      if (state !== 'starting') {
        fail('PLAN_B_ASR_TASK_STATE_INVALID');
        return;
      }
      const now = clock();
      if (!integer(now)) {
        fail('PLAN_B_ASR_CLOCK_INVALID');
        return;
      }
      anchor = now;
      taskStarted = true;
      state = 'ready';
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      evidence('ready');
      readyResolve();
      if (finishRequested) sendFinish();
      return;
    }
    if (!taskStarted) {
      fail('PLAN_B_ASR_TASK_NOT_STARTED');
      return;
    }
    if (name === 'result-generated') {
      usage(event.payload?.usage?.duration);
      if (!isClosed()) receiveSource(event.payload?.output?.sentence);
    } else if (name === 'task-finished') {
      if (state !== 'finishing') {
        fail('PLAN_B_ASR_UNEXPECTED_FINISH');
        return;
      }
      usage(event.payload?.usage?.duration);
      if (isClosed()) return;
      if (lastDuration < 0) {
        try {
          options.onUsage?.({
            layer: 'asr',
            role,
            region: config.region,
            taskSequence: 1,
            basis: 'unknown',
          });
        } catch {
          fail('PLAN_B_ASR_CALLBACK_FAILED');
          return;
        }
      }
      state = 'closed';
      cleanup();
      evidence('completed');
      finishResolve();
    }
  });
  socket.on('error', () => fail('PLAN_B_ASR_TRANSPORT_FAILED'));
  socket.on('close', (closeCode: number) =>
    fail('PLAN_B_ASR_DISCONNECTED', closeCode),
  );
  evidence('configured');
  arm('PLAN_B_ASR_START_TIMEOUT');

  return {
    ready,
    append(pcm24k) {
      if (state === 'closed') throw new Error(failure ?? 'PLAN_B_ASR_CLOSED');
      if (state !== 'ready' || finishRequested)
        throw new Error('PLAN_B_ASR_NOT_READY');
      if (
        !Buffer.isBuffer(pcm24k) ||
        pcm24k.length % 2 ||
        pcm24k.length > MAX_APPEND_BYTES
      ) {
        fail('PLAN_B_ASR_PCM_INVALID');
        throw new Error('PLAN_B_ASR_PCM_INVALID');
      }
      if (!pcm24k.length) return;
      const context = currentContext();
      if (isClosed()) return;
      const serialized = JSON.stringify(context);
      if (serialized !== contextSerialized) {
        contextSerialized = serialized;
        if (
          !send({
            header: {
              action: 'continue-task',
              task_id: taskId,
              streaming: 'duplex',
            },
            payload: { input: { context } },
          })
        )
          return;
      }
      if (send(Buffer.from(pcm24k)))
        sentPcmSamples += BigInt(pcm24k.length / 2);
    },
    finish() {
      finishRequested = true;
      sendFinish();
      return finished;
    },
    abort() {
      if (state === 'closed') return;
      failure = 'PLAN_B_ASR_CANCELLED';
      state = 'closed';
      cleanup();
      readyReject(new Error(failure));
      finishReject(new Error(failure));
      evidence('cancelled');
    },
  };
}
