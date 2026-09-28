const COUNTERS = ['bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'packetsLost'];
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const inRange = (value, min = 0, max = MAX_NUMBER) => Number.isFinite(value) && value >= min && value <= max;
const counter = value => Number.isSafeInteger(value) && value >= 0;

// Read only named data properties: never traverse totals/raw stats or retain SDK objects.
function field(sample, name) {
  try { return Object.getOwnPropertyDescriptor(sample, name)?.value; } catch { return undefined; }
}

function addTotal(totals, name, value) {
  if (totals[name] === null) return;
  const next = (totals[name] ?? 0) + value;
  // An overflowing window is unavailable, rather than a clipped or partial total.
  totals[name] = Number.isSafeInteger(next) ? next : null;
}

function addReading(readings, name, value) {
  const previous = readings[name];
  if (!previous) readings[name] = { count: 1, mean: value, min: value, max: value };
  else {
    previous.count += 1;
    previous.mean += (value - previous.mean) / previous.count;
    previous.min = Math.min(previous.min, value);
    previous.max = Math.max(previous.max, value);
  }
}

/**
 * Aggregate SDK one-second deltas into bounded numeric windows, without timers.
 * The sample reaching the boundary belongs to the window returned by addSample.
 * elapsedMs starts at construction/reset; windowDurationMs is actual elapsed time,
 * so a delayed sample does not fabricate intervening five-second windows.
 * Missing/invalid metrics are omitted. sampleCount counts object sample events,
 * including events whose individual metrics are unavailable.
 *
 * Optional output: counter sums; weighted packetLossPercent with paired-sample
 * count and packetLossPacketsExpected; packetLossUnweightedPercentAvg/count for
 * samples lacking a valid packet denominator; rttAvgMs/rttMaxMs,
 * jitterAvgMs/jitterMaxMs, mosAvg/mosMin; audioInputLevelPeak/audioOutputLevelPeak
 * (0..32767), and inputVolumePeak/outputVolumePeak (0..1).
 */
export function createRtcDiagnostics({ now = () => performance.now(), windowMs = 5000 } = {}) {
  const duration = inRange(windowMs, 1, 60000) ? windowMs : 5000;
  let lastNow = 0;
  const time = () => {
    const value = now();
    if (inRange(value)) lastNow = Math.max(lastNow, value);
    return lastNow;
  };
  let startedAt = time();
  let windowStartedAt = startedAt;
  let sampleCount = 0;
  let totals = {};
  let readings = {};
  let peaks = {};

  function clearWindow(at) {
    windowStartedAt = at;
    sampleCount = 0;
    totals = {};
    readings = {};
    peaks = {};
  }

  function addVolume(input, output) {
    if (inRange(input, 0, 1)) peaks.inputVolumePeak = Math.max(peaks.inputVolumePeak ?? 0, input);
    if (inRange(output, 0, 1)) peaks.outputVolumePeak = Math.max(peaks.outputVolumePeak ?? 0, output);
  }

  function addSample(sample) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
    const at = time();
    sampleCount += 1;
    for (const name of COUNTERS) {
      const value = field(sample, name);
      if (counter(value)) addTotal(totals, name, value);
    }

    // statsMonitor's percentage is lost / (received + lost) * 100, not 0..1.
    // Only matched valid counters can contribute to the weighted percentage.
    const lost = field(sample, 'packetsLost');
    const received = field(sample, 'packetsReceived');
    if (counter(lost) && counter(received) && Number.isSafeInteger(lost + received)) {
      if (lost + received > 0) {
        addTotal(totals, 'lossNumerator', lost);
        addTotal(totals, 'packetLossPacketsExpected', lost + received);
        addTotal(totals, 'packetLossSampleCount', 1);
      }
    } else {
      const percent = field(sample, 'packetsLostFraction');
      if (inRange(percent, 0, 100)) addReading(readings, 'unweightedLoss', percent);
    }

    // The SDK converts WebRTC seconds to milliseconds before emitting a sample.
    for (const name of ['rtt', 'jitter']) {
      const value = field(sample, name);
      if (inRange(value)) addReading(readings, name, value);
    }
    const mos = field(sample, 'mos');
    if (inRange(mos, 1, 5)) addReading(readings, 'mos', mos);
    for (const name of ['audioInputLevel', 'audioOutputLevel']) {
      const value = field(sample, name);
      if (inRange(value, 0, 32767)) peaks[`${name}Peak`] = Math.max(peaks[`${name}Peak`] ?? 0, value);
    }

    if (at - windowStartedAt < duration) return null;
    const summary = { elapsedMs: at - startedAt, windowDurationMs: at - windowStartedAt, sampleCount };
    for (const name of COUNTERS) if (counter(totals[name])) summary[name] = totals[name];
    if (counter(totals.lossNumerator) && counter(totals.packetLossPacketsExpected)
      && totals.packetLossPacketsExpected > 0) {
      summary.packetLossPercent = 100 * (totals.lossNumerator / totals.packetLossPacketsExpected);
      summary.packetLossSampleCount = totals.packetLossSampleCount;
      summary.packetLossPacketsExpected = totals.packetLossPacketsExpected;
    }
    if (readings.unweightedLoss) {
      summary.packetLossUnweightedPercentAvg = readings.unweightedLoss.mean;
      summary.packetLossUnweightedSampleCount = readings.unweightedLoss.count;
    }
    for (const name of ['rtt', 'jitter']) if (readings[name]) {
      summary[`${name}AvgMs`] = readings[name].mean;
      summary[`${name}MaxMs`] = readings[name].max;
    }
    if (readings.mos) { summary.mosAvg = readings.mos.mean; summary.mosMin = readings.mos.min; }
    Object.assign(summary, peaks);
    clearWindow(at);
    return summary;
  }

  function reset() {
    startedAt = time();
    clearWindow(startedAt);
  }

  return { addSample, addVolume, reset };
}
