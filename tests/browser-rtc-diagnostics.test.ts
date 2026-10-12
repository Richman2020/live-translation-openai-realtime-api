import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRtcDiagnostics, validatedTwilioEdge } from '../public/rtc-diagnostics.js';

function fixture(windowMs = 5000) {
  let time = 0;
  const rtc = createRtcDiagnostics({ now: () => time, windowMs });
  return { rtc, at(value: number) { time = value; } };
}

test('edge observation accepts geographic SDK enums without inferring a route from roaming or private values', () => {
  for (const edge of ['tokyo', 'ashburn', 'sao-paulo', 'singapore-ix', 'san-jose-ix']) assert.equal(validatedTwilioEdge(edge), edge);
  const neverRead = { toString() { throw new Error('must not inspect unknown objects'); } };
  for (const value of [undefined, null, '', 'roaming', 'gll', 'us1', 'TOKYO', ' tokyo ', 'https://private-edge.example',
    'ashburn\nprivate-token', '192.0.2.1', 1, ['tokyo'], neverRead]) assert.equal(validatedTwilioEdge(value), undefined);
});

test('RTC reports a separately validated edge only at window emission and never copies raw sample routing fields', () => {
  const f = fixture();
  f.at(1000); f.rtc.addSample({ packetsSent: 1 }, 'tokyo');
  f.at(5000);
  const result = f.rtc.addSample({ packetsSent: 2, edge: 'private-edge', edgeAtWindowEnd: 'private-token', ip: 'private-ip' }, 'ashburn');
  assert.deepEqual(result, { elapsedMs: 5000, windowDurationMs: 5000, sampleCount: 2, edgeAtWindowEnd: 'ashburn', packetsSent: 3 });
  f.at(10000);
  assert.deepEqual(f.rtc.addSample({ packetsSent: 4, edge: 'tokyo' }, 'roaming'), {
    elapsedMs: 10000, windowDurationMs: 5000, sampleCount: 1, packetsSent: 4,
  }, 'an unknown current edge must not reuse the prior window edge or raw sample edge');
  f.rtc.reset(); f.at(15000);
  assert.equal('edgeAtWindowEnd' in f.rtc.addSample({ packetsSent: 0 }), false);
});

test('all five one-second deltas contribute, including the boundary sample', () => {
  const f = fixture();
  for (let i = 1; i <= 5; i += 1) {
    f.at(i * 1000);
    const result = f.rtc.addSample({ bytesSent: i * 10, bytesReceived: 20, packetsSent: 4, packetsReceived: 9, packetsLost: 1 });
    if (i < 5) assert.equal(result, null);
    else assert.deepEqual(result, {
      elapsedMs: 5000, windowDurationMs: 5000, sampleCount: 5,
      bytesSent: 150, bytesReceived: 100, packetsSent: 20, packetsReceived: 45, packetsLost: 5,
      packetLossPercent: 10, packetLossSampleCount: 5, packetLossPacketsExpected: 50,
    });
  }
  f.at(9999);
  assert.equal(f.rtc.addSample({ bytesSent: 3 }), null);
  f.at(10000);
  assert.deepEqual(f.rtc.addSample({ bytesSent: 7 }), {
    elapsedMs: 10000, windowDurationMs: 5000, sampleCount: 2, bytesSent: 10,
  });
});

test('packet loss weights matched counters and labels denominator-free samples separately', () => {
  const f = fixture();
  f.rtc.addSample({ packetsReceived: 9, packetsLost: 1, packetsLostFraction: 10 });
  f.rtc.addSample({ packetsReceived: 81, packetsLost: 9, packetsLostFraction: 10 });
  f.rtc.addSample({ packetsReceived: 100, packetsLost: 0, packetsLostFraction: 0 });
  f.rtc.addSample({ packetsLostFraction: 20 });
  f.rtc.addSample({ packetsReceived: 5, packetsLostFraction: 40 });
  f.at(5000);
  const result = f.rtc.addSample({ packetsReceived: 0, packetsLost: 0, packetsLostFraction: 0 });
  assert.equal(result.packetLossPercent, 5);
  assert.equal(result.packetLossSampleCount, 3);
  assert.equal(result.packetLossPacketsExpected, 200);
  assert.equal(result.packetLossUnweightedPercentAvg, 30);
  assert.equal(result.packetLossUnweightedSampleCount, 2);
  assert.equal(result.packetsReceived, 195);
  assert.equal(result.packetsLost, 10);
});

test('RTT/jitter retain SDK millisecond units, MOS averages valid values, and levels retain peaks', () => {
  const f = fixture();
  f.rtc.addVolume(0, 0.2);
  f.rtc.addVolume(0.7, 0.1);
  f.rtc.addSample({ rtt: 10, jitter: 5, mos: 4, audioInputLevel: 20, audioOutputLevel: 100 });
  f.at(5000);
  const result = f.rtc.addSample({ rtt: 30, jitter: 15, mos: 2, audioInputLevel: 100, audioOutputLevel: 25 });
  assert.deepEqual(result, {
    elapsedMs: 5000, windowDurationMs: 5000, sampleCount: 2,
    rttAvgMs: 20, rttMaxMs: 30, jitterAvgMs: 10, jitterMaxMs: 15,
    mosAvg: 3, mosMin: 2, inputVolumePeak: 0.7, outputVolumePeak: 0.2,
    audioInputLevelPeak: 100, audioOutputLevelPeak: 100,
  });
  f.at(10000);
  assert.deepEqual(f.rtc.addSample({ mos: null }), { elapsedMs: 10000, windowDurationMs: 5000, sampleCount: 1 });
});

test('valid zeros survive, while zero inbound traffic does not invent a measured loss percentage', () => {
  const f = fixture();
  f.rtc.addVolume(0, 0);
  f.at(5000);
  assert.deepEqual(f.rtc.addSample({
    bytesSent: 0, bytesReceived: 0, packetsSent: 0, packetsReceived: 0, packetsLost: 0,
    packetsLostFraction: 0, rtt: 0, jitter: 0, mos: 1, audioInputLevel: 0, audioOutputLevel: 0,
  }), {
    elapsedMs: 5000, windowDurationMs: 5000, sampleCount: 1,
    bytesSent: 0, bytesReceived: 0, packetsSent: 0, packetsReceived: 0, packetsLost: 0,
    rttAvgMs: 0, rttMaxMs: 0, jitterAvgMs: 0, jitterMaxMs: 0, mosAvg: 1, mosMin: 1,
    inputVolumePeak: 0, outputVolumePeak: 0, audioInputLevelPeak: 0, audioOutputLevelPeak: 0,
  });
});

test('nonfinite, malformed, out-of-range, inherited, and sensitive values are never copied', () => {
  const f = fixture();
  for (const sample of [null, undefined, 'secret-token', 4, [], true]) assert.equal(f.rtc.addSample(sample), null);
  for (const value of [NaN, Infinity, -Infinity, -1, null, '7']) {
    f.rtc.addVolume(value, value);
    f.rtc.addSample({ bytesSent: value, rtt: value, jitter: value, mos: value, audioInputLevel: value });
  }
  const sample = Object.assign(Object.create({ bytesReceived: 120, rtt: 40 }), {
    bytesSent: 0.5, packetsReceived: Number.MAX_SAFE_INTEGER + 1, packetsLost: -5,
    packetsLostFraction: 100.1, audioInputLevel: 32768, audioOutputLevel: 32768, mos: 5.1,
    remoteAddress: '198.51.100.1', localAddress: '192.0.2.1', token: 'secret', sdp: 'private', totals: { bytesSent: 999 },
  });
  Object.defineProperty(sample, 'jitter', { get() { throw new Error('Never invoke an accessor'); } });
  Object.defineProperty(sample, 'rawStats', { get() { throw new Error('Never read raw stats'); } });
  f.rtc.addVolume(1.1, Number.MAX_VALUE);
  f.at(5000);
  const result = f.rtc.addSample(sample);
  assert.deepEqual(result, { elapsedMs: 5000, windowDurationMs: 5000, sampleCount: 7 });
  assert.ok(Object.values(result).every(value => typeof value === 'number' && Number.isFinite(value)));
});

test('invalid individual values do not overwrite other valid measurements or become zeros', () => {
  const f = fixture();
  f.rtc.addSample({ bytesSent: 9, mos: 4, rtt: 20, packetsLostFraction: 5 });
  f.rtc.addSample({ bytesSent: '10', mos: null, rtt: Infinity, packetsLostFraction: NaN });
  f.at(5000);
  const result = f.rtc.addSample({ bytesReceived: 7 });
  assert.equal(result.bytesSent, 9);
  assert.equal(result.bytesReceived, 7);
  assert.equal(result.mosAvg, 4);
  assert.equal(result.rttAvgMs, 20);
  assert.equal(result.packetLossUnweightedPercentAvg, 5);
  assert.equal(result.packetLossUnweightedSampleCount, 1);
  assert.equal('packetsLost' in result, false);
});

test('delayed samples report actual duration and reset clears time, counters, and volume peaks', () => {
  const f = fixture();
  f.rtc.addVolume(1, 1);
  f.at(1000);
  f.rtc.addSample({ bytesSent: 123 });
  f.at(2200);
  f.rtc.reset();
  f.at(7199);
  assert.equal(f.rtc.addSample({ bytesSent: 1 }), null);
  f.at(12000);
  assert.deepEqual(f.rtc.addSample({ bytesSent: 2 }), {
    elapsedMs: 9800, windowDurationMs: 9800, sampleCount: 2, bytesSent: 3,
  });
});

test('counter overflow omits the affected total and loss ratio rather than returning a partial value', () => {
  const f = fixture();
  f.rtc.addSample({ bytesSent: Number.MAX_SAFE_INTEGER, packetsReceived: Number.MAX_SAFE_INTEGER, packetsLost: 0 });
  f.at(5000);
  const result = f.rtc.addSample({ bytesSent: 1, bytesReceived: 3, packetsReceived: 1, packetsLost: 1 });
  assert.equal('bytesSent' in result, false);
  assert.equal('packetsReceived' in result, false);
  assert.equal('packetLossPercent' in result, false);
  assert.equal(result.bytesReceived, 3);
  assert.ok(Object.values(result).every(value => typeof value === 'number' && Number.isFinite(value)));
});

test('long streams keep fixed summary shape and do not retain sample references across windows', () => {
  const f = fixture();
  const sample = { bytesSent: 1, bytesReceived: 2, rtt: 100, rawStats: { privateValue: 'not retained' } };
  let windows = 0;
  let totalBytes = 0;
  for (let i = 1; i <= 100000; i += 1) {
    f.at(i * 1000);
    const result = f.rtc.addSample(sample);
    if (result) {
      windows += 1;
      totalBytes += result.bytesSent;
      assert.equal(Object.keys(result).length, 7);
      assert.equal(result.sampleCount, 5);
      assert.equal(result.bytesReceived, 10);
      assert.equal(result.rttAvgMs, 100);
    }
  }
  assert.equal(windows, 20000);
  assert.equal(totalBytes, 100000);
  sample.bytesSent = 99;
  f.at(100005000);
  assert.equal(f.rtc.addSample({ bytesSent: 7 }).bytesSent, 7);
  assert.deepEqual(Object.keys(f.rtc).sort(), ['addSample', 'addVolume', 'reset']);
});

test('invalid or backwards clock values cannot produce negative or nonfinite timing', () => {
  const f = fixture(10);
  f.at(8);
  f.rtc.addSample({ bytesSent: 1 });
  f.at(2);
  f.rtc.addSample({ bytesSent: 1 });
  f.at(NaN);
  f.rtc.addSample({ bytesSent: 1 });
  f.at(10);
  assert.deepEqual(f.rtc.addSample({ bytesSent: 1 }), { elapsedMs: 10, windowDurationMs: 10, sampleCount: 4, bytesSent: 4 });
});
