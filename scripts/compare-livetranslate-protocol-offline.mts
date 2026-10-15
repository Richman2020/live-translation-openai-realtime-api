import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type WebSocket from 'ws';

import { createLiveTranslateClient } from '../src/experiments/livetranslate-client';

if (process.argv[2] !== '--baseline-source' || !process.argv[3])
  throw new Error('OFFLINE_COMPARISON_BASELINE_SOURCE_REQUIRED');
const baselinePath = resolve(process.argv[3]);
const baseline = await import(pathToFileURL(baselinePath).href);
const contractPath = new URL(
  '../fixtures/livetranslate-protocol/synthetic-official-contract.json',
  import.meta.url,
);
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

class Peer extends EventEmitter {
  readyState = 1;

  bufferedAmount = 0;

  sent: any[] = [];

  constructor(readonly emitClose: boolean) {
    super();
  }

  send(raw: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }

  close() {
    if (!this.emitClose) return;
    this.readyState = 3;
    this.emit('close', 1000);
  }

  terminate() {
    if (!this.emitClose) return;
    this.readyState = 3;
    this.emit('close', 1006);
  }
}

async function replay(create: typeof createLiveTranslateClient, scenario: any) {
  const peer = new Peer(scenario.autoEmitClose !== false);
  const errors: string[] = [];
  const diagnostics: any[] = [];
  let ready = false;
  let finished = false;
  let fakeClockMs = 0;
  let actionException = false;
  const client = create({
    enabled: true,
    role: 'local',
    workspaceId: 'offline-workspace',
    apiKey: 'synthetic-offline-unused',
    now: () => fakeClockMs,
    createWebSocket: () => peer as unknown as WebSocket,
    onError: (code) => errors.push(code),
    onProtocolDiagnostic: (item) => diagnostics.push(item),
  });
  client.ready.then(
    () => {
      ready = true;
    },
    () => {},
  );
  const markFinished = () => {
    finished = true;
  };
  try {
    for (const action of scenario.actions) {
      fakeClockMs += 10;
      try {
        if (action.kind === 'open') peer.emit('open');
        else if (action.kind === 'receive')
          peer.emit(
            'message',
            Buffer.from(JSON.stringify(action.event)),
            false,
          );
        else if (action.kind === 'raw')
          peer.emit('message', Buffer.from(action.raw), false);
        else if (action.kind === 'binary')
          peer.emit('message', Buffer.from('{}'), true);
        else if (action.kind === 'oversize')
          peer.emit('message', Buffer.alloc(1024 * 1024 + 1, 32), false);
        else if (action.kind === 'invalidUtf8')
          peer.emit('message', Buffer.from([0xc3, 0x28]), false);
        else if (action.kind === 'append') client.append(Buffer.alloc(640));
        else if (action.kind === 'finish')
          client.finish().then(markFinished, () => {});
        else if (action.kind === 'probeBeforeReady')
          assert.throws(() => client.append(Buffer.alloc(640)));
        else if (action.kind === 'close') {
          peer.readyState = 3;
          peer.emit('close', action.code);
        } else throw new Error('OFFLINE_UNKNOWN_ACTION');
      } catch {
        actionException = true;
        break;
      }
      // Ordered artificial delivery only; no real-time or model latency claim.
      // eslint-disable-next-line no-await-in-loop -- Each fixture event observes the preceding event's microtasks.
      await Promise.resolve();
      if (errors.length) break;
    }
    return {
      ready,
      finishResolved: finished,
      appendCount: peer.sent.filter(
        (item) => item.type === 'input_audio_buffer.append',
      ).length,
      fatalCode: errors[0] ?? null,
      fatalPath: diagnostics[0]?.validationPath ?? null,
      actionException,
    };
  } finally {
    client.abort();
  }
}

async function compare(scenario: any) {
  const old = await replay(baseline.createLiveTranslateClient, scenario);
  const candidate = await replay(createLiveTranslateClient, scenario);
  const { expected } = scenario;
  const candidateMatchesContract =
    !candidate.actionException &&
    candidate.ready === expected.ready &&
    candidate.appendCount === expected.appendCount &&
    candidate.finishResolved === expected.finishResolved &&
    candidate.fatalCode === expected.fatalCode &&
    candidate.fatalPath === expected.fatalPath;
  const outcome = (item: typeof old) => ({
    ready: item.ready,
    appendCount: item.appendCount,
    finishResolved: item.finishResolved,
    fatalCode: item.fatalCode,
    actionException: item.actionException,
  });
  return {
    scenario: scenario.id,
    provenance: scenario.source,
    baseline: old,
    candidate,
    candidateMatchesContract,
    outcomeChanged:
      JSON.stringify(outcome(old)) !== JSON.stringify(outcome(candidate)),
    behaviorOrDiagnosticChanged:
      JSON.stringify(old) !== JSON.stringify(candidate),
  };
}

// A second artificial pass removes the old ASCII identifier restriction as an early
// confounder, so later tail/binding defects can be observed independently.
const identifierKeys = new Set([
  'event_id',
  'session_id',
  'id',
  'response_id',
  'item_id',
  'previous_item_id',
]);
function normalizeSyntheticIdentifiers(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeSyntheticIdentifiers);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      identifierKeys.has(key) && typeof item === 'string' && item
        ? `id_${createHash('sha256').update(item).digest('hex').slice(0, 24)}`
        : normalizeSyntheticIdentifiers(item),
    ]),
  );
}
const cases: any[] = [];
const identifierNormalizedCases: any[] = [];
for (const scenario of contract.scenarios) {
  // eslint-disable-next-line no-await-in-loop -- Keep original and normalized replay scenarios in deterministic order.
  cases.push(await compare(scenario));
  identifierNormalizedCases.push(
    // eslint-disable-next-line no-await-in-loop -- Complete the matching normalized scenario before advancing.
    await compare({
      ...scenario,
      actions: scenario.actions.map((action: any) =>
        action.kind === 'receive'
          ? { ...action, event: normalizeSyntheticIdentifiers(action.event) }
          : action,
      ),
    }),
  );
}
const result = {
  evidenceKind: 'differential_synthetic_replay_not_actual_failure_payload',
  realCapturedEvents: 0,
  realConnections: 0,
  timingBasis: 'ordered_fake_clock_not_model_latency',
  baselineSource: baselinePath,
  baselineSourceSha256: createHash('sha256')
    .update(readFileSync(baselinePath))
    .digest('hex'),
  candidateSourceSha256: createHash('sha256')
    .update(
      readFileSync(
        new URL('../src/experiments/livetranslate-client.ts', import.meta.url),
      ),
    )
    .digest('hex'),
  allCandidateContractsMatch: [...cases, ...identifierNormalizedCases].every(
    (item) => item.candidateMatchesContract,
  ),
  cases,
  identifierNormalizedCases,
  identifierNormalizedPassProvenance:
    'Additional artificial transformation of identifier strings only; not captured traffic and not an inferred real failure payload.',
};
const output = process.env.LIVETRANSLATE_PROTOCOL_DIFFERENTIAL_REPORT;
if (output)
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(
  `${JSON.stringify({
    scenarios: cases.length,
    identifierNormalizedScenarios: identifierNormalizedCases.length,
    normalizedOutcomeChanges: identifierNormalizedCases.filter(
      (item) => item.outcomeChanged,
    ).length,
    allCandidateContractsMatch: result.allCandidateContractsMatch,
    realConnections: 0,
  })}\n`,
);
assert.equal(result.allCandidateContractsMatch, true);
