/* eslint-disable no-continue -- A bounded stdout scan skips unrelated/non-JSON records without retaining them. */
/** Offline numeric telemetry only. This module neither opens sockets nor handles audio. */
export type MediaTraceChunk = {
  availableAtMs: number;
  generatedAtMs: number;
  durationMs: number;
  rms: number;
  sentAtMs?: number;
  acknowledgedAtMs?: number;
  unconfirmed: boolean;
};

export type MediaTrace = {
  chunks: MediaTraceChunk[];
  inputWindows: {
    startedAtMs: number;
    endedAtMs: number;
    durationMs: number;
  }[];
};

const MAX_TIME = 7 * 24 * 60 * 60 * 1000;
const MAX_CHUNKS = 100000;
const MAX_FRAMES = 1000000;
const numeric = (value: unknown, max = MAX_TIME): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;
const rounded = (value: number) => Math.round(value * 1000) / 1000;

export function traceStatistics(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const count = sorted.length;
  if (!count) return { count: 0 };
  return {
    count,
    min: rounded(sorted[0]),
    median: rounded(
      count % 2
        ? sorted[(count - 1) / 2]
        : (sorted[count / 2 - 1] + sorted[count / 2]) / 2,
    ),
    p95: rounded(sorted[Math.ceil(count * 0.95) - 1]),
    max: rounded(sorted[count - 1]),
  };
}

/** Keep IDs only in this parser's local map; returned records contain no strings. */
export function parseMediaTrace(log: string, pipelineId: string): MediaTrace {
  if (!/^[a-f0-9-]{36}$/i.test(pipelineId) || log.length > 128 * 1024 * 1024)
    throw new Error('INVALID_MEDIA_TRACE_INPUT');
  const deliveries = new Map<string, Map<string, Record<string, any>>>();
  const inputWindows: MediaTrace['inputWindows'] = [];
  for (const line of log.split(/\r?\n/)) {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // Server stdout also contains non-JSON startup messages.
    }
    if (
      !event ||
      event.pipelineId !== pipelineId ||
      event.role !== 'local' ||
      !['translation-input', 'translation-audio'].includes(event.event)
    )
      continue;
    if (event.clock !== 'bridge_monotonic')
      throw new Error('INVALID_MEDIA_TRACE_CLOCK');
    if (event.event === 'translation-input') {
      if (
        !numeric(event.windowStartedAtMs) ||
        !numeric(event.windowEndedAtMs) ||
        event.windowEndedAtMs < event.windowStartedAtMs ||
        !numeric(event.audioDurationMs, 200) ||
        event.audioDurationMs === 0
      )
        throw new Error('INVALID_MEDIA_TRACE_INPUT_WINDOW');
      inputWindows.push({
        startedAtMs: event.windowStartedAtMs,
        endedAtMs: event.windowEndedAtMs,
        durationMs: event.audioDurationMs,
      });
      if (inputWindows.length > MAX_CHUNKS)
        throw new Error('MEDIA_TRACE_TOO_LARGE');
      continue;
    }
    if (
      event.recipientRole !== 'remote' ||
      !/^continuous_[1-9]\d{0,11}$/.test(event.deliveryId) ||
      !['generated', 'sent', 'playback_confirmed', 'unconfirmed'].includes(
        event.stage,
      ) ||
      !numeric(event.createdAtMs) ||
      !numeric(event.observedAtMs) ||
      event.observedAtMs < event.createdAtMs ||
      !Number.isSafeInteger(event.generatedBytes) ||
      event.generatedBytes < 1 ||
      event.generatedBytes > 1600 ||
      !numeric(event.rms, 32768)
    )
      throw new Error('INVALID_MEDIA_TRACE_DELIVERY');
    if (!deliveries.has(event.deliveryId))
      deliveries.set(event.deliveryId, new Map());
    const stages = deliveries.get(event.deliveryId)!;
    if (stages.has(event.stage)) throw new Error('DUPLICATE_MEDIA_TRACE_STAGE');
    stages.set(event.stage, event);
    if (deliveries.size > MAX_CHUNKS) throw new Error('MEDIA_TRACE_TOO_LARGE');
  }
  const chunks: MediaTraceChunk[] = [];
  for (const stages of deliveries.values()) {
    const generated = stages.get('generated');
    const sent = stages.get('sent');
    const ack = stages.get('playback_confirmed');
    if (!generated) throw new Error('INCOMPLETE_MEDIA_TRACE_DELIVERY');
    for (const event of stages.values())
      if (
        event.createdAtMs !== generated.createdAtMs ||
        event.generatedBytes !== generated.generatedBytes ||
        event.rms !== generated.rms ||
        (event.audioDurationMs !== undefined &&
          event.audioDurationMs !== generated.generatedBytes / 8) ||
        !Number.isSafeInteger(event.sentBytes) ||
        event.sentBytes < 0 ||
        event.sentBytes > generated.generatedBytes
      )
        throw new Error('INCONSISTENT_MEDIA_TRACE_DELIVERY');
    if (
      (sent &&
        (!numeric(sent.sentAtMs) ||
          sent.sentAtMs < generated.observedAtMs ||
          sent.sentBytes !== generated.generatedBytes)) ||
      (ack &&
        (!sent ||
          !numeric(ack.acknowledgedAtMs) ||
          ack.acknowledgedAtMs < sent.sentAtMs ||
          ack.sentBytes !== generated.generatedBytes ||
          ack.sentAtMs !== sent.sentAtMs ||
          stages.has('unconfirmed')))
    )
      throw new Error('INVALID_MEDIA_TRACE_COMPLETION');
    chunks.push({
      availableAtMs: generated.createdAtMs,
      generatedAtMs: generated.observedAtMs,
      durationMs: generated.generatedBytes / 8,
      rms: generated.rms,
      ...(sent ? { sentAtMs: sent.sentAtMs } : {}),
      ...(ack ? { acknowledgedAtMs: ack.acknowledgedAtMs } : {}),
      unconfirmed: stages.has('unconfirmed'),
    });
  }
  if (!chunks.length) throw new Error('MEDIA_TRACE_EMPTY');
  // Preserve stream order, including tied timestamps. Never sort corrupted
  // backwards arrivals into a plausible-looking trace.
  for (let index = 1; index < chunks.length; index += 1)
    if (chunks[index].availableAtMs < chunks[index - 1].availableAtMs)
      throw new Error('NON_MONOTONIC_MEDIA_TRACE');
  return { chunks, inputWindows };
}

export type FifoSchedule = {
  mode: 'immediate' | 'paced';
  frameMs?: number;
  lookaheadMs?: number;
  startupDelayMs?: number;
};

/** An ideal, ordered, one-speed player with no network or adaptive buffering.
 * A delayed sender cannot beat immediate FIFO for the same available samples.
 */
export function simulateMediaFifo(
  chunks: Pick<MediaTraceChunk, 'availableAtMs' | 'durationMs'>[],
  schedule: FifoSchedule,
) {
  const frameMs = schedule.frameMs ?? 20;
  const lookaheadMs = schedule.lookaheadMs ?? 0;
  const startupDelayMs = schedule.startupDelayMs ?? 0;
  if (
    !chunks.length ||
    chunks.length > MAX_CHUNKS ||
    !['immediate', 'paced'].includes(schedule.mode) ||
    !numeric(frameMs, 200) ||
    frameMs < 1 ||
    !numeric(lookaheadMs, 2000) ||
    !numeric(startupDelayMs, 2000) ||
    (schedule.mode === 'immediate' && (lookaheadMs || startupDelayMs))
  )
    throw new Error('INVALID_MEDIA_FIFO_OPTIONS');
  let expectedFrames = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const { availableAtMs, durationMs } = chunks[index];
    if (
      !numeric(availableAtMs) ||
      !numeric(durationMs, 10000) ||
      durationMs === 0 ||
      (index && availableAtMs < chunks[index - 1].availableAtMs)
    )
      throw new Error('INVALID_MEDIA_FIFO_CHUNK');
    expectedFrames += Math.ceil(durationMs / frameMs);
    if (expectedFrames > MAX_FRAMES) throw new Error('MEDIA_FIFO_TOO_LARGE');
  }
  const changes = new Map<
    number,
    { arrived: number; sent: number; playing: number }
  >();
  const change = (
    at: number,
    arrived: number,
    sent: number,
    playing: number,
  ) => {
    const current = changes.get(at) || { arrived: 0, sent: 0, playing: 0 };
    current.arrived += arrived;
    current.sent += sent;
    current.playing += playing;
    changes.set(at, current);
  };
  const completions: number[] = [];
  const localLastFrameWait: number[] = [];
  let frameCount = 0;
  let totalAudioMs = 0;
  let playbackCursor = chunks[0].availableAtMs;
  let pacingCursor = playbackCursor + startupDelayMs;
  let firstPlaybackAtMs: number | undefined;
  for (let index = 0; index < chunks.length; index += 1) {
    const { availableAtMs, durationMs } = chunks[index];
    totalAudioMs += durationMs;
    let lastSend = availableAtMs;
    for (let offset = 0; offset < durationMs; offset += frameMs) {
      frameCount += 1;
      if (frameCount > MAX_FRAMES) throw new Error('MEDIA_FIFO_TOO_LARGE');
      const frameDuration = Math.min(frameMs, durationMs - offset);
      const sendAt =
        schedule.mode === 'immediate'
          ? availableAtMs
          : Math.max(
              availableAtMs,
              chunks[0].availableAtMs + startupDelayMs,
              pacingCursor - lookaheadMs,
            );
      pacingCursor = Math.max(pacingCursor, sendAt) + frameDuration;
      const playAt = Math.max(sendAt, playbackCursor);
      playbackCursor = playAt + frameDuration;
      firstPlaybackAtMs ??= playAt;
      change(availableAtMs, frameDuration, 0, 0);
      change(sendAt, 0, frameDuration, 0);
      change(playAt, 0, 0, 1);
      change(playbackCursor, 0, 0, -1);
      lastSend = sendAt;
    }
    completions.push(playbackCursor);
    localLastFrameWait.push(lastSend - availableAtMs);
  }
  let arrived = 0;
  let sent = 0;
  let played = 0;
  let playing = 0;
  let previousAt = chunks[0].availableAtMs;
  let maxLocalAudioMs = 0;
  let maxDownstreamAudioMs = 0;
  let maxCombinedAudioMs = 0;
  for (const [at, delta] of [...changes].sort(([a], [b]) => a - b)) {
    played += (at - previousAt) * playing;
    arrived += delta.arrived;
    sent += delta.sent;
    playing += delta.playing;
    maxLocalAudioMs = Math.max(maxLocalAudioMs, arrived - sent);
    maxDownstreamAudioMs = Math.max(maxDownstreamAudioMs, sent - played);
    maxCombinedAudioMs = Math.max(maxCombinedAudioMs, arrived - played);
    previousAt = at;
  }
  return {
    completions,
    summary: {
      chunks: chunks.length,
      frames: frameCount,
      totalAudioMs: rounded(totalAudioMs),
      firstAvailabilityToPlaybackMs: rounded(
        firstPlaybackAtMs! - chunks[0].availableAtMs,
      ),
      firstAvailabilityToAllCompleteMs: rounded(
        playbackCursor - chunks[0].availableAtMs,
      ),
      modeledPlaybackIdleMs: rounded(
        playbackCursor - chunks[0].availableAtMs - totalAudioMs,
      ),
      availabilityToCompletionMs: traceStatistics(
        completions.map((at, index) => at - chunks[index].availableAtMs),
      ),
      localWaitForLastFrameMs: traceStatistics(localLastFrameWait),
      maxLocalAudioMs: rounded(maxLocalAudioMs),
      maxDownstreamAudioMs: rounded(maxDownstreamAudioMs),
      maxCombinedAudioMs: rounded(maxCombinedAudioMs),
    },
  };
}

export function analyzeMediaTrace(trace: MediaTrace) {
  const { chunks, inputWindows } = trace;
  const immediate = simulateMediaFifo(chunks, { mode: 'immediate' });
  const firstAt = chunks[0].availableAtMs;
  const lastAt = chunks[chunks.length - 1].availableAtMs;
  const observed = (items: MediaTraceChunk[]) => ({
    chunks: items.length,
    generatedToSentMs: traceStatistics(
      items.flatMap((c) =>
        c.sentAtMs === undefined ? [] : [c.sentAtMs - c.generatedAtMs],
      ),
    ),
    sentToMarkMs: traceStatistics(
      items.flatMap((c) =>
        c.acknowledgedAtMs === undefined || c.sentAtMs === undefined
          ? []
          : [c.acknowledgedAtMs - c.sentAtMs],
      ),
    ),
  });
  const observedAndModeled = (indices: number[]) => ({
    ...observed(indices.map((index) => chunks[index])),
    selectionStartAfterFirstOutputMs: indices.length
      ? rounded(chunks[indices[0]].availableAtMs - firstAt)
      : null,
    selectionEndAfterFirstOutputMs: indices.length
      ? rounded(chunks[indices[indices.length - 1]].availableAtMs - firstAt)
      : null,
    idealAvailabilityToCompletionMs: traceStatistics(
      indices.map(
        (index) => immediate.completions[index] - chunks[index].availableAtMs,
      ),
    ),
    availabilityToMarkMs: traceStatistics(
      indices.flatMap((index) =>
        chunks[index].acknowledgedAtMs === undefined
          ? []
          : [chunks[index].acknowledgedAtMs! - chunks[index].availableAtMs],
      ),
    ),
    modelResidualMarkMinusIdealCompletionMs: traceStatistics(
      indices.flatMap((index) =>
        chunks[index].acknowledgedAtMs === undefined
          ? []
          : [chunks[index].acknowledgedAtMs! - immediate.completions[index]],
      ),
    ),
  });
  const energyIndices = chunks.flatMap((c, index) =>
    c.rms >= 300 ? [index] : [],
  );
  const confirmedChunks = chunks.filter(
    (c) => c.acknowledgedAtMs !== undefined,
  );
  const firstInputStart = inputWindows[0]?.startedAtMs;
  const firstInputEnd = inputWindows[0]?.endedAtMs;
  const lastInputEnd = inputWindows[inputWindows.length - 1]?.endedAtMs;
  const inputAudioMs = inputWindows.reduce((sum, w) => sum + w.durationMs, 0);
  const gaps: number[] = [];
  const bursts: { audioMs: number; spanMs: number }[] = [];
  let burstStart = firstAt;
  let burstAudio = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const c = chunks[index];
    if (index) {
      const gap = c.availableAtMs - chunks[index - 1].availableAtMs;
      gaps.push(gap);
      if (gap > 20) {
        bursts.push({
          audioMs: burstAudio,
          spanMs: chunks[index - 1].availableAtMs - burstStart,
        });
        burstStart = c.availableAtMs;
        burstAudio = 0;
      }
    }
    burstAudio += c.durationMs;
  }
  bursts.push({ audioMs: burstAudio, spanMs: lastAt - burstStart });
  const bins = [];
  let cumulativeAudioMs = 0;
  const occupiedBins = new Map<number, MediaTraceChunk[]>();
  for (const chunk of chunks) {
    const start =
      firstAt + Math.floor((chunk.availableAtMs - firstAt) / 15000) * 15000;
    const items = occupiedBins.get(start) || [];
    items.push(chunk);
    occupiedBins.set(start, items);
  }
  for (const [start, items] of occupiedBins) {
    cumulativeAudioMs += items.reduce((sum, c) => sum + c.durationMs, 0);
    const end = Math.min(start + 15000, lastAt);
    bins.push({
      startRelativeMs: rounded(start - firstAt),
      endRelativeMs: rounded(end - firstAt),
      cumulativeAudioMs: rounded(cumulativeAudioMs),
      cumulativeAudioMinusClockMs: rounded(cumulativeAudioMs - (end - firstAt)),
      ...observed(items),
    });
  }
  return {
    schema: 'offline-media-trace/1',
    evidence: 'OFFLINE_METADATA_AND_IDEAL_FIFO_SIMULATION',
    limitations: [
      'Availability is bridge delivery creation after resampling, a provider-arrival proxy, not raw provider receive time.',
      'The simulator has no network, adaptive jitter buffer, provider generation, transcript alignment or human audibility.',
      'Marks include transport, ordered playback drainage and confirmation return; they are not mouth-to-ear measurements.',
      'All audio including silence is retained. Return original batches are excluded because their first packets were already forwarded before sealing.',
      'Chunk statistics are unweighted; median averages the middle pair and p95 uses nearest rank.',
      'Model residual is observed mark minus ideal completion, not a measured decomposition of network RTT or real playback buffering.',
      'Cumulative audio minus clock includes initial chunk duration and boundary effects; it is not directly a queue measurement.',
      'Bins start at the first outgoing delivery, not call connection. Energy subsets select first/last 50 RMS>=300 chunks; energy is not speech recognition.',
      'Missing send or terminal evidence is reported separately; a truncated trace must not be interpreted as a completed call.',
    ],
    observed: {
      ...observed(chunks),
      first50GeneratedChunks: observed(chunks.slice(0, 50)),
      last50GeneratedChunks: observed(chunks.slice(-50)),
      first50ConfirmedChunks: observed(confirmedChunks.slice(0, 50)),
      last50ConfirmedChunks: observed(confirmedChunks.slice(-50)),
      energyRmsAtLeast300: {
        all: observedAndModeled(energyIndices),
        first50EnergySelectedChunks: observedAndModeled(
          energyIndices.slice(0, 50),
        ),
        last50EnergySelectedChunks: observedAndModeled(
          energyIndices.slice(-50),
        ),
      },
      missingTerminalEvidenceChunks: chunks.filter(
        (c) => c.acknowledgedAtMs === undefined && !c.unconfirmed,
      ).length,
      withoutCompletedSendChunks: chunks.filter((c) => c.sentAtMs === undefined)
        .length,
      unconfirmedChunks: chunks.filter((c) => c.unconfirmed).length,
      nonzeroUnconfirmedChunks: chunks.filter((c) => c.unconfirmed && c.rms > 0)
        .length,
      availableClockSpanMs: rounded(lastAt - firstAt),
      totalAudioMs: immediate.summary.totalAudioMs,
      cumulativeAudioMinusAvailableClockMs: rounded(
        immediate.summary.totalAudioMs - (lastAt - firstAt),
      ),
      arrivalGapMs: traceStatistics(gaps),
      gapsOver500Ms: gaps.filter((gap) => gap > 500).length,
      gapsOver1000Ms: gaps.filter((gap) => gap > 1000).length,
      burstsWithAdjacentGapAtMost20Ms: {
        count: bursts.length,
        audioMs: traceStatistics(bursts.map((b) => b.audioMs)),
        spanMs: traceStatistics(bursts.map((b) => b.spanMs)),
      },
      inputAudioMs: rounded(inputAudioMs),
      inputArrivalClock: {
        windows: inputWindows.length,
        firstReceiptToLastReceiptMs:
          firstInputStart === undefined
            ? null
            : rounded(lastInputEnd! - firstInputStart),
        firstCompletedWindowToLastCompletedWindowMs:
          firstInputEnd === undefined
            ? null
            : rounded(lastInputEnd! - firstInputEnd),
        audioAfterFirstCompletedWindowMs: inputWindows.length
          ? rounded(inputAudioMs - inputWindows[0].durationMs)
          : null,
        audioAfterFirstWindowMinusReceiptClockMs:
          firstInputEnd === undefined
            ? null
            : rounded(
                inputAudioMs -
                  inputWindows[0].durationMs -
                  (lastInputEnd! - firstInputEnd),
              ),
      },
      inputWindowReceiptSpanMs: traceStatistics(
        inputWindows.map((w) => w.endedAtMs - w.startedAtMs),
      ),
      modelResidualMarkMinusIdealCompletionMs: traceStatistics(
        chunks.flatMap((c, index) =>
          c.acknowledgedAtMs === undefined
            ? []
            : [c.acknowledgedAtMs - immediate.completions[index]],
        ),
      ),
      bins,
    },
    simulation: {
      immediate: immediate.summary,
      pacedCandidates: [0, 40, 100, 200].map((lookaheadMs) => {
        const paced = simulateMediaFifo(chunks, { mode: 'paced', lookaheadMs });
        const differences = paced.completions.map(
          (at, index) => at - immediate.completions[index],
        );
        return {
          frameMs: 20,
          lookaheadMs,
          ...paced.summary,
          completionChangeVersusImmediateMs: traceStatistics(differences),
          improvedChunks: differences.filter((value) => value < -0.001).length,
          worsenedChunks: differences.filter((value) => value > 0.001).length,
        };
      }),
      decision: 'NO_SCHEDULER_GAIN_ESTABLISHED_DO_NOT_DEPLOY_FROM_THIS_TRACE',
    },
  };
}
