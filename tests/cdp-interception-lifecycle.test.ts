import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CdpInterceptionLifecycle,
  type InterceptionRecord,
} from '../scripts/cdp-interception-lifecycle';

// These deliberately constructed CDP events exercise the fixture state machine.
// They are not a reconstruction of CI #72's still-unidentified XHR.
const origin = 'http://127.0.0.1:1';

function fixture(overrides: Record<string, unknown> = {}) {
  const faults: string[] = [];
  const lifecycle = new CdpInterceptionLifecycle({
    pageId: 'test-page',
    origin,
    cancellationWaitMs: 20,
    traceLimit: 64,
    maxRecords: 32,
    onFault: (fault) => faults.push(fault),
    ...overrides,
  });
  return { lifecycle, faults };
}

function paused(
  fetchId = 'fetch-1',
  networkId: string | undefined = 'network-1',
  url = `${origin}/fixture/cdp/request`,
) {
  return {
    requestId: fetchId,
    ...(networkId ? { networkId } : {}),
    resourceType: 'XHR',
    request: { url, method: 'GET' },
  };
}

function start(
  lifecycle: CdpInterceptionLifecycle,
  networkId = 'network-1',
  url = `${origin}/fixture/cdp/request`,
) {
  lifecycle.observe('Network.requestWillBeSent', {
    requestId: networkId,
    request: { url, method: 'GET' },
    type: 'XHR',
  });
}

function cancel(
  lifecycle: CdpInterceptionLifecycle,
  networkId = 'network-1',
  canceled = true,
) {
  lifecycle.observe('Network.loadingFailed', {
    requestId: networkId,
    canceled,
    errorText: 'net::ERR_ABORTED',
    type: 'XHR',
  });
}

function invalidId() {
  return Object.assign(new Error('Invalid InterceptionId.'), {
    protocolCode: -32602,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function failCommand(
  lifecycle: CdpInterceptionLifecycle,
  record: InterceptionRecord,
  error: Error = invalidId(),
) {
  return lifecycle.command(record, 'Fetch.continueRequest', 1, async () => {
    throw error;
  });
}

test('CDP lifecycle: normal continue, fulfill and fail each issue exactly one terminal command', async () => {
  const { lifecycle, faults } = fixture();
  const commands: string[] = [];
  [
    'Fetch.continueRequest',
    'Fetch.fulfillRequest',
    'Fetch.failRequest',
  ].forEach((method, index) => {
    const networkId = `network-${index}`;
    start(lifecycle, networkId);
    lifecycle.run(paused(`fetch-${index}`, networkId), async (record) => {
      await lifecycle.command(record, method, index + 1, async () => {
        commands.push(method);
      });
    });
  });
  await lifecycle.drain();
  assert.deepEqual(commands, [
    'Fetch.continueRequest',
    'Fetch.fulfillRequest',
    'Fetch.failRequest',
  ]);
  assert.deepEqual(faults, []);
  assert.equal(lifecycle.snapshot().inFlight, 0);
});

test('CDP lifecycle: a handler that never settles the paused request remains a strict fault', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.run(paused(), async () => undefined);
  await lifecycle.drain();
  assert.equal(faults.length, 1);
  assert.equal(lifecycle.snapshot().records[0].state, 'fault');
});

test('CDP lifecycle: an auxiliary command alone does not settle an intercepted request', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  let auxiliaryCommands = 0;
  lifecycle.run(paused(), async (record) => {
    await lifecycle.command(record, 'Network.getCookies', 1, async () => {
      auxiliaryCommands += 1;
      return { cookies: [] };
    });
  });
  await lifecycle.drain();
  assert.equal(auxiliaryCommands, 1);
  assert.equal(faults.length, 1);
  assert.equal(lifecycle.snapshot().records[0].state, 'fault');
});

test('CDP lifecycle: same request canceled before its command does not send a stale Fetch command', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  let sent = 0;
  lifecycle.run(paused(), async (record) => {
    cancel(lifecycle);
    await lifecycle.command(record, 'Fetch.continueRequest', 1, async () => {
      sent += 1;
    });
  });
  await lifecycle.drain();
  assert.equal(sent, 0);
  assert.deepEqual(faults, []);
  assert.match(
    JSON.stringify(lifecycle.snapshot()),
    /cancelled-before-command/,
  );
});

test('CDP lifecycle: matching cancellation arriving after Invalid InterceptionId is narrowly classified', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  let sent = 0;
  lifecycle.run(paused(), async (record) => {
    await lifecycle.command(record, 'Fetch.continueRequest', 1, async () => {
      sent += 1;
      setTimeout(() => cancel(lifecycle), 1);
      throw invalidId();
    });
  });
  await lifecycle.drain();
  assert.equal(sent, 1, 'classification must not retry a command');
  assert.deepEqual(faults, []);
});

test('CDP lifecycle: an unproved Invalid InterceptionId remains a fixture fault', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.run(paused(), (record) => failCommand(lifecycle, record));
  await lifecycle.drain();
  assert.equal(faults.length, 1);
  assert.match(JSON.stringify(lifecycle.snapshot()), /INVALID_INTERCEPTION_ID/);
});

test('CDP lifecycle: a non-cancellation loading failure cannot excuse Invalid InterceptionId', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  cancel(lifecycle, 'network-1', false);
  lifecycle.run(paused(), (record) => failCommand(lifecycle, record));
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: loadingFinished is not cancellation evidence', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.observe('Network.loadingFinished', { requestId: 'network-1' });
  lifecycle.run(paused(), (record) => failCommand(lifecycle, record));
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: a different canceled request cannot excuse this invalid ID', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  start(lifecycle, 'network-other');
  cancel(lifecycle, 'network-other');
  lifecycle.run(paused(), (record) => failCommand(lifecycle, record));
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: another page cannot lend cancellation evidence even for the same Network ID', async () => {
  const first = fixture({ pageId: 'page-1' });
  const second = fixture({ pageId: 'page-2' });
  start(first.lifecycle);
  start(second.lifecycle);
  cancel(first.lifecycle);
  second.lifecycle.run(paused(), (record) =>
    failCommand(second.lifecycle, record),
  );
  await Promise.all([first.lifecycle.drain(), second.lifecycle.drain()]);
  assert.deepEqual(first.faults, []);
  assert.equal(second.faults.length, 1);
});

test('CDP lifecycle: provider requests cannot use same-origin cancellation classification', async () => {
  const { lifecycle, faults } = fixture();
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?secret=never-log';
  start(lifecycle, 'network-1', url);
  cancel(lifecycle);
  let sent = 0;
  lifecycle.run(paused('fetch-1', 'network-1', url), (record) =>
    lifecycle.command(record, 'Fetch.fulfillRequest', 1, async () => {
      sent += 1;
      throw invalidId();
    }),
  );
  await lifecycle.drain();
  assert.equal(sent, 1);
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: missing Network ID cannot prove cancellation', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  cancel(lifecycle);
  const event = paused();
  delete event.networkId;
  lifecycle.run(event, (record) => failCommand(lifecycle, record));
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: neither a different protocol error nor a generic -32602 is suppressed', async () => {
  for (const error of [
    Object.assign(new Error('Unknown protocol failure'), {
      protocolCode: -32602,
    }),
    Object.assign(new Error('Invalid InterceptionId.'), {
      protocolCode: -32000,
    }),
    new Error('Socket closed unexpectedly'),
  ]) {
    const { lifecycle, faults } = fixture();
    start(lifecycle);
    lifecycle.run(paused(), async (record) => {
      await lifecycle.command(record, 'Fetch.continueRequest', 1, async () => {
        queueMicrotask(() => cancel(lifecycle));
        throw error;
      });
    });
    await lifecycle.drain();
    assert.equal(faults.length, 1);
  }
});

test('CDP lifecycle: duplicate paused events do not repeat the handler or command', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  let handlers = 0;
  let commands = 0;
  const handler = async (record: InterceptionRecord) => {
    handlers += 1;
    await lifecycle.command(record, 'Fetch.continueRequest', 1, async () => {
      commands += 1;
    });
  };
  lifecycle.run(paused(), handler);
  lifecycle.run(paused(), handler);
  await lifecycle.drain();
  lifecycle.run(paused(), handler);
  await lifecycle.drain();
  assert.equal(handlers, 1);
  assert.equal(commands, 1);
  assert.deepEqual(faults, []);
});

test('CDP lifecycle: conflicting duplicate Fetch ID remains a fault', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  let handlers = 0;
  const handler = async (record: InterceptionRecord) => {
    handlers += 1;
    await lifecycle.command(
      record,
      'Fetch.continueRequest',
      1,
      async () => undefined,
    );
  };
  lifecycle.run(paused(), handler);
  lifecycle.run(paused('fetch-1', 'network-other'), handler);
  await lifecycle.drain();
  assert.equal(handlers, 1);
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: conflicting URL path, query or provider origin is not hidden by sanitized categories', async () => {
  const pairs = [
    [`${origin}/private-first?value=secret-first`, `${origin}/private-second?value=secret-second`],
    [`${origin}/fixture/cdp/request?value=secret-first`, `${origin}/fixture/cdp/request?value=secret-second`],
    ['https://provider-first.example/private?value=secret-first', 'https://provider-second.example/private?value=secret-second'],
  ];
  for (const [firstUrl, secondUrl] of pairs) {
    const { lifecycle, faults } = fixture();
    start(lifecycle, 'network-1', firstUrl);
    let commands = 0;
    let handlers = 0;
    const handler = async (record: InterceptionRecord) => {
      handlers += 1;
      await lifecycle.command(record, 'Fetch.continueRequest', 1, async () => { commands += 1; });
    };
    lifecycle.run(paused('fetch-1', 'network-1', firstUrl), handler);
    lifecycle.run(paused('fetch-1', 'network-1', secondUrl), handler);
    await lifecycle.drain();
    assert.equal(handlers, 1);
    assert.equal(commands, 1);
    assert.equal(faults.length, 1);
    assert.match(faults[0], /DUPLICATE_PAUSED_CONFLICT/);
    const diagnostic = JSON.stringify({ snapshot: lifecycle.snapshot(), faults });
    for (const secret of ['secret-first', 'secret-second', 'private-first', 'private-second', 'provider-first.example', 'provider-second.example', 'value=']) {
      assert.equal(diagnostic.includes(secret), false, secret);
    }
  }
});

test('CDP lifecycle: a second terminal command is rejected without sending it', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  let commands = 0;
  lifecycle.run(paused(), async (record) => {
    await lifecycle.command(record, 'Fetch.continueRequest', 1, async () => {
      commands += 1;
    });
    await lifecycle.command(record, 'Fetch.failRequest', 2, async () => {
      commands += 1;
    });
  });
  await lifecycle.drain();
  assert.equal(commands, 1);
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: navigation alone does not excuse an invalid command', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.run(paused(), async (record) => {
    lifecycle.observe('Page.frameNavigated', {
      frame: {
        id: 'frame-1',
        loaderId: 'new-loader',
        url: `${origin}/controlled`,
      },
    });
    await failCommand(lifecycle, record);
  });
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: target detachment alone does not swallow command failures', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.run(paused(), async (record) => {
    lifecycle.observe('Inspector.detached', { reason: 'target_closed' });
    await failCommand(lifecycle, record);
  });
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});

test('CDP lifecycle: drain waits for pending interception before clean fixture assertions', async () => {
  const { lifecycle, faults } = fixture();
  const pending = deferred();
  start(lifecycle);
  lifecycle.run(paused(), (record) =>
    lifecycle.command(
      record,
      'Fetch.continueRequest',
      1,
      () => pending.promise,
    ),
  );
  let drained = false;
  const drain = lifecycle.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(lifecycle.snapshot().inFlight, 1);
  pending.resolve();
  await drain;
  assert.equal(drained, true);
  assert.equal(lifecycle.snapshot().inFlight, 0);
  assert.deepEqual(faults, []);
});

test('CDP lifecycle: drain timeout is a strict failure and never retries pending commands', async () => {
  const { lifecycle, faults } = fixture();
  const pending = deferred();
  start(lifecycle);
  let commands = 0;
  lifecycle.run(paused(), (record) =>
    lifecycle.command(record, 'Fetch.continueRequest', 1, () => {
      commands += 1;
      return pending.promise;
    }),
  );
  await assert.rejects(lifecycle.drain(5), /CDP_INTERCEPTION_DRAIN_TIMEOUT/);
  assert.equal(faults.length, 1);
  assert.equal(commands, 1);
  pending.resolve();
  await lifecycle.drain();
  assert.equal(commands, 1);
});

test('CDP lifecycle: synchronous handler assertion is reported as a fault', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.run(paused(), () => {
    assert.fail('Fixture assertion detail');
  });
  await lifecycle.drain();
  assert.equal(faults.length, 1);
  assert.match(JSON.stringify(lifecycle.snapshot()), /FIXTURE_ASSERTION/);
});

test('CDP lifecycle: sanitized diagnostic records never keep request URLs, query values, headers or bodies', async () => {
  const { lifecycle, faults } = fixture();
  const request = {
    ...paused(
      'safe-fetch-id',
      'safe-network-id',
      `${origin}/auth/session/page?token=secret-query-value`,
    ),
    request: {
      url: `${origin}/auth/session/page?token=secret-query-value`,
      method: 'POST',
      headers: {
        authorization: 'secret-auth-value',
        cookie: 'secret-cookie-value',
      },
      postData: 'secret-request-body-value',
    },
  };
  start(lifecycle, 'safe-network-id', request.request.url);
  lifecycle.run(request, (record) =>
    lifecycle.command(
      record,
      'Fetch.continueRequest',
      1,
      async () => undefined,
    ),
  );
  await lifecycle.drain();
  const diagnostic = JSON.stringify({ snapshot: lifecycle.snapshot(), faults });
  assert.match(diagnostic, /safe-fetch-id/);
  assert.match(diagnostic, /safe-network-id/);
  for (const secret of [
    'secret-query-value',
    'secret-auth-value',
    'secret-cookie-value',
    'secret-request-body-value',
    'http://',
    'token=',
  ]) {
    assert.equal(diagnostic.includes(secret), false, secret);
  }
});

test('CDP lifecycle: hard request capacity fails strictly without evicting IDs or sending extra commands', async () => {
  const { lifecycle, faults } = fixture({ traceLimit: 16, maxRecords: 8 });
  let commands = 0;
  for (let index = 0; index < 40; index += 1) {
    const networkId = `network-${index}`;
    start(lifecycle, networkId);
    lifecycle.run(paused(`fetch-${index}`, networkId), (record) =>
      lifecycle.command(
        record,
        'Fetch.continueRequest',
        index + 1,
        async () => {
          commands += 1;
        },
      ),
    );
    await lifecycle.drain();
    lifecycle.observe('Network.loadingFinished', { requestId: networkId });
  }
  lifecycle.run(paused('fetch-0', 'network-0'), (record) =>
    lifecycle.command(record, 'Fetch.continueRequest', 41, async () => {
      commands += 1;
    }),
  );
  await lifecycle.drain();
  const snapshot = lifecycle.snapshot();
  assert.ok(snapshot.trace.length <= 16);
  assert.ok(snapshot.records.length <= 8);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(commands, 8);
  assert.equal(faults.length, 32);
  assert.ok(faults.every((fault) => fault.includes('INTERCEPTION_CAPACITY')));
});

test('CDP lifecycle: arbitrary exception content never appears in diagnostics', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  lifecycle.run(paused(), (record) =>
    failCommand(lifecycle, record, new Error('secret-exception-body-value')),
  );
  await lifecycle.drain();
  assert.equal(faults.length, 1);
  assert.equal(
    JSON.stringify({ snapshot: lifecycle.snapshot(), faults }).includes(
      'secret-exception-body-value',
    ),
    false,
  );
});

test('CDP lifecycle: redirected reuse of a Network ID cannot lend cancellation to its earlier pause', async () => {
  const { lifecycle, faults } = fixture();
  start(lifecycle);
  const gate = deferred();
  lifecycle.run(paused(), async (record) => {
    await gate.promise;
    await failCommand(lifecycle, record);
  });
  lifecycle.observe('Network.requestWillBeSent', {
    requestId: 'network-1',
    request: { url: `${origin}/controlled`, method: 'GET' },
    redirectResponse: { status: 302, url: `${origin}/fixture/cdp/request` },
    type: 'Document',
  });
  cancel(lifecycle);
  gate.resolve();
  await lifecycle.drain();
  assert.equal(faults.length, 1);
});
