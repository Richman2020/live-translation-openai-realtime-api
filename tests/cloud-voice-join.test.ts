import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_CSRF_HEADER,
  CLOUD_SESSION_COOKIE,
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import {
  CloudVoiceJoin,
  CloudVoiceJoinError,
  type CloudVoiceAdmission,
  type CloudVoiceGrant,
  type CloudVoiceReservation,
  type CloudVoiceSigner,
} from '../src/solo/cloud-voice-join';
import { CloudControllerLeases } from '../src/solo/controller-lease';

// All identities, cookies, Voice tokens and budget/intent behavior are TEST ONLY.
// There is no JWT, supplier connection, secret/config read, or durable store.
const applicationSid = `AP${'a'.repeat(32)}`;
const tokenA = Buffer.alloc(32, 1).toString('base64url');
const tokenB = Buffer.alloc(32, 2).toString('base64url');
const csrf = Buffer.alloc(32, 3).toString('base64url');
const sidA = `CA${'a'.repeat(32)}`;
const sidB = `CA${'b'.repeat(32)}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  options: {
    noSigner?: boolean;
    noAdmission?: boolean;
    noApplication?: boolean;
    signer?: CloudVoiceSigner;
    admission?: CloudVoiceAdmission;
    ttlMs?: number;
    maxTokenLifetimeMs?: number;
    maxCalls?: number;
  } = {},
) {
  let now = 10000;
  const make = (id: string): CloudAuthSession => ({
    authSessionId: `session-${id}`,
    principalId: 'single-account',
    browserOwnerId: `owner-${id}`,
    epoch: 1,
    issuedAt: 1000,
    absoluteExpiresAt: 100000,
    idleExpiresAt: 90000,
    revoked: false,
    csrfToken: csrf,
  });
  const session = make('a');
  const otherSession = make('b');
  const sessions = new Map([
    [tokenA, session],
    [tokenB, otherSession],
  ]);
  const policy = new CloudAccessPolicy({
    publicOrigin: 'https://phone.example.com',
    now: () => now,
    resolveSession: (token) => sessions.get(token),
  });
  const headers = (other = false) => ({
    host: 'phone.example.com',
    origin: 'https://phone.example.com',
    cookie: `${CLOUD_SESSION_COOKIE}=${other ? tokenB : tokenA}`,
    [CLOUD_CSRF_HEADER]: csrf,
  });
  const context = policy.authenticate(headers(), 'mutate', {
    surface: 'http',
    method: 'POST',
  });
  const otherContext = policy.authenticate(headers(true), 'mutate', {
    surface: 'http',
    method: 'POST',
  });
  const leases = new CloudControllerLeases({
    policy,
    now: () => now,
    ttlMs: options.ttlMs ?? 30000,
  });
  const proof = leases.acquire(context, 'tab-a');
  const bound = leases.authorize(context, proof);
  const effects = {
    reserves: 0,
    signs: 0,
    releases: 0,
    reservationLive: true,
    releaseFails: false,
  };
  const grants: CloudVoiceGrant[] = [];
  const held: CloudVoiceReservation = {
    assertCurrent: () => {
      if (!effects.reservationLive) throw new Error('synthetic budget revoked');
    },
    release: async () => {
      effects.releases += 1;
      if (effects.releaseFails)
        throw new Error('synthetic journal release failed');
    },
  };
  const signer: CloudVoiceSigner = async (grant) => {
    effects.signs += 1;
    grants.push(grant);
    return `fake.offline.voice.${grant.callId}`;
  };
  const admission: CloudVoiceAdmission = {
    reserve: async () => {
      effects.reserves += 1;
      return held;
    },
  };
  const voice = new CloudVoiceJoin({
    policy,
    now: () => now,
    signer: options.noSigner ? undefined : (options.signer ?? signer),
    admission: options.noAdmission
      ? undefined
      : (options.admission ?? admission),
    outgoingApplicationSid: options.noApplication ? undefined : applicationSid,
    maxTokenLifetimeMs: options.maxTokenLifetimeMs,
    maxCalls: options.maxCalls,
  });
  const call = {
    callId: 'call-a',
    identity: 'phone_random_identity_a',
    nonce: 'local_nonce_a',
  };
  policy.registerCall(context, call.callId);
  const dispose = voice.registerCall(context, call, () =>
    leases.authorizeCurrent(bound),
  );
  return {
    policy,
    context,
    otherContext,
    headers,
    session,
    otherSession,
    leases,
    proof,
    bound,
    effects,
    grants,
    held,
    voice,
    call,
    dispose,
    advance: (value: number) => {
      now = value;
    },
    fields: (join: string, CallSid = sidA) => ({
      sessionId: call.callId,
      nonce: call.nonce,
      From: `client:${call.identity}`,
      CallSid,
      join,
    }),
  };
}
function voiceError(code: CloudVoiceJoinError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof CloudVoiceJoinError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}
function accessError(code: CloudAccessError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof CloudAccessError);
    assert.equal(error.code, code);
    return true;
  };
}

test('Voice connection has no signer, durable admission or application fallback', async () => {
  for (const options of [
    { noSigner: true },
    { noAdmission: true },
    { noApplication: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      f.voice.prepareGrant(f.context, f.call.callId),
      voiceError('VOICE_CONNECTION_NOT_READY'),
    );
    assert.deepEqual([f.effects.reserves, f.effects.signs], [0, 0]);
  }
});

test('minimal immutable Voice grant binds verified login, controller tab/epoch and one server call', async () => {
  const f = fixture();
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  assert.deepEqual(prepared.grant, {
    version: 1,
    authSessionId: 'session-a',
    principalId: 'single-account',
    browserOwnerId: 'owner-a',
    authEpoch: 1,
    controller: {
      leaseId: f.proof.leaseId,
      tabId: 'tab-a',
      epoch: f.proof.epoch,
    },
    callId: f.call.callId,
    identity: f.call.identity,
    issuedAt: 10000,
    expiresAt: 40000,
    incomingAllow: false,
    outgoingApplicationSid: applicationSid,
    outgoing: { callId: f.call.callId, identity: f.call.identity },
  });
  assert.ok(
    Object.isFrozen(prepared) &&
      Object.isFrozen(prepared.grant) &&
      Object.isFrozen(prepared.grant.controller),
  );
  assert.deepEqual(prepared.params, {
    sessionId: f.call.callId,
    nonce: f.call.nonce,
    join: prepared.join,
  });
  assert.match(prepared.join, /^[A-Za-z0-9_-]{43}$/);
  assert.match(prepared.token, /^fake\.offline\.voice\./);
  assert.deepEqual([f.effects.reserves, f.effects.signs], [1, 1]);
  assert.equal(await f.voice.prepareGrant(f.context, f.call.callId), prepared);
  assert.deepEqual([f.effects.reserves, f.effects.signs], [1, 1]);
});

test('grant deadline cannot exceed current login expiry, lease expiry or configured short lifetime', async () => {
  const f = fixture({ maxTokenLifetimeMs: 15000 });
  f.session.idleExpiresAt = 18000;
  assert.equal(
    (await f.voice.prepareGrant(f.context, f.call.callId)).grant.expiresAt,
    18000,
  );
  const short = fixture({ ttlMs: 2000 });
  assert.equal(
    (await short.voice.prepareGrant(short.context, short.call.callId)).grant
      .expiresAt,
    12000,
  );
});

test('missing login, foreign call owner and read-only request cannot prepare Voice permission', async () => {
  const f = fixture();
  await assert.rejects(
    f.voice.prepareGrant({ ...f.context }, f.call.callId),
    accessError('UNAUTHORIZED'),
  );
  await assert.rejects(
    f.voice.prepareGrant(f.otherContext, f.call.callId),
    accessError('NOT_FOUND'),
  );
  const read = f.policy.authenticate(f.headers(), 'read', {
    surface: 'http',
    method: 'GET',
  });
  await assert.rejects(
    f.voice.prepareGrant(read, f.call.callId),
    accessError('FORBIDDEN'),
  );
  assert.deepEqual([f.effects.reserves, f.effects.signs], [0, 0]);
});

test('a replaced lease epoch cannot prepare the old call even for the same verified login', async () => {
  const f = fixture();
  f.leases.revoke(f.context, f.proof);
  f.leases.acquire(f.context, 'tab-a');
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    accessError('FORBIDDEN'),
  );
  assert.equal(f.effects.reserves, 0);
});

test('one call has only one concurrent preparation and one budget reservation', async () => {
  const reserve = deferred<CloudVoiceReservation>();
  let reserves = 0;
  const f = fixture({
    admission: {
      reserve: () => {
        reserves += 1;
        return reserve.promise;
      },
    },
  });
  const pending = f.voice.prepareGrant(f.context, f.call.callId);
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    voiceError('VOICE_PREPARATION_IN_PROGRESS'),
  );
  reserve.resolve(f.held);
  await pending;
  assert.equal(reserves, 1);
});

test('login revocation during awaited admission rolls back without starting the signer', async () => {
  const reserve = deferred<CloudVoiceReservation>();
  const f = fixture({ admission: { reserve: () => reserve.promise } });
  const pending = f.voice.prepareGrant(f.context, f.call.callId);
  f.session.revoked = true;
  reserve.resolve(f.held);
  await assert.rejects(pending, accessError('UNAUTHORIZED'));
  assert.deepEqual([f.effects.signs, f.effects.releases], [0, 1]);
  assert.equal(f.voice.cleanupUnconfirmed, false);
});

test('controller revocation during awaited signing delivers no token and releases the reservation', async () => {
  const signed = deferred<string>();
  const f = fixture({ signer: () => signed.promise });
  const pending = f.voice.prepareGrant(f.context, f.call.callId);
  await Promise.resolve();
  f.leases.revoke(f.context, f.proof);
  signed.resolve('fake.offline.token');
  await assert.rejects(pending, accessError('FORBIDDEN'));
  assert.equal(f.effects.releases, 1);
});

test('a signer finishing beyond the initial deadline cannot obtain a renewed join ticket', async () => {
  const signed = deferred<string>();
  const f = fixture({ signer: () => signed.promise, maxTokenLifetimeMs: 1000 });
  const pending = f.voice.prepareGrant(f.context, f.call.callId);
  await Promise.resolve();
  f.advance(11000);
  f.leases.renew(f.context, f.proof);
  signed.resolve('fake.offline.token');
  await assert.rejects(pending, voiceError('INVALID_VOICE_JOIN'));
  assert.equal(f.effects.releases, 1);
});

test('signer rejection fails closed, rolls back safely and does not expose the provider error', async () => {
  const f = fixture({
    signer: async () => {
      throw new Error('fixture private signing material');
    },
  });
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    voiceError('VOICE_CONNECTION_NOT_READY'),
  );
  assert.equal(f.effects.releases, 1);
  assert.equal(f.voice.cleanupUnconfirmed, false);
});

test('callback validates exact call, identity, nonce, canonical ticket and SID before consuming anything', async () => {
  const f = fixture();
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  const fields = f.fields(prepared.join);
  for (const change of [
    { sessionId: 'other-call' },
    { nonce: 'wrong' },
    { From: 'client:ai-phone' },
    { From: 'client:other_identity' },
    { CallSid: 'invalid' },
    { join: 'invalid' },
    { join: Buffer.alloc(32, 5).toString('base64url') },
  ])
    assert.throws(
      () => f.voice.consume({ ...fields, ...change }),
      voiceError('INVALID_VOICE_JOIN'),
    );
  assert.equal(f.voice.consume(fields), 'join');
});

test('a call ticket cannot be used on another owned call or spend on a second SDK connection', async () => {
  const f = fixture();
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  const other = {
    callId: 'call-b',
    identity: 'phone_random_identity_b',
    nonce: 'nonce_b',
  };
  f.policy.registerCall(f.context, other.callId);
  f.voice.registerCall(f.context, other, () =>
    f.leases.authorizeCurrent(f.bound),
  );
  const preparedOther = await f.voice.prepareGrant(f.context, other.callId);
  assert.throws(
    () =>
      f.voice.consume({
        ...f.fields(prepared.join),
        sessionId: other.callId,
        nonce: other.nonce,
        From: `client:${other.identity}`,
      }),
    voiceError('INVALID_VOICE_JOIN'),
  );
  assert.notEqual(preparedOther.join, prepared.join);
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'join');
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'replay');
  assert.throws(
    () => f.voice.consume(f.fields(prepared.join, sidB)),
    voiceError('INVALID_VOICE_JOIN'),
  );
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    voiceError('INVALID_VOICE_JOIN'),
  );
  assert.equal(f.effects.reserves, 2);
});

test('a legitimate late callback after login revocation becomes cleanup only and cannot spend a second SID', async () => {
  const f = fixture();
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  f.session.revoked = true;
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'cleanup');
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'cleanup');
  assert.throws(
    () => f.voice.consume(f.fields(prepared.join, sidB)),
    voiceError('INVALID_VOICE_JOIN'),
  );
});

test('an unused expired ticket is cleanup only even when the controller lease was explicitly renewed', async () => {
  const f = fixture({ maxTokenLifetimeMs: 1000 });
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  f.advance(11000);
  f.leases.renew(f.context, f.proof);
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'cleanup');
});

test('a joined call can renew its lease without refreshing its single-use ticket or budget', async () => {
  const f = fixture({ maxTokenLifetimeMs: 1000, ttlMs: 2000 });
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'join');
  f.advance(11000);
  f.leases.renew(f.context, f.proof);
  f.voice.assertJoinedCurrent(f.call.callId);
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'replay');
  assert.deepEqual([f.effects.reserves, f.effects.signs], [1, 1]);
  f.advance(13000);
  assert.throws(
    () => f.voice.assertJoinedCurrent(f.call.callId),
    accessError('FORBIDDEN'),
  );
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'cleanup');
});

test('final HTTP delivery rechecks exact response, current lease and initial ticket deadline', async () => {
  const f = fixture({ maxTokenLifetimeMs: 1000 });
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  f.voice.assertPreparedCurrent(f.context, f.call.callId, prepared);
  assert.throws(
    () =>
      f.voice.assertPreparedCurrent(f.context, f.call.callId, { ...prepared }),
    voiceError('INVALID_VOICE_JOIN'),
  );
  f.advance(11000);
  f.leases.renew(f.context, f.proof);
  assert.throws(
    () => f.voice.assertPreparedCurrent(f.context, f.call.callId, prepared),
    voiceError('INVALID_VOICE_JOIN'),
  );
});

test('current budget revocation prevents both delivery and every joined-call admission', async () => {
  const f = fixture();
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  f.effects.reservationLive = false;
  assert.throws(
    () => f.voice.assertPreparedCurrent(f.context, f.call.callId, prepared),
    voiceError('VOICE_CONNECTION_NOT_READY'),
  );
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'cleanup');
  assert.throws(
    () => f.voice.assertJoinedCurrent(f.call.callId),
    voiceError('VOICE_CONNECTION_NOT_READY'),
  );
});

test('pending or failed intent release blocks new permission until explicit safe cleanup succeeds', async () => {
  const f = fixture();
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  f.effects.releaseFails = true;
  await assert.rejects(f.voice.releaseCall(f.call.callId));
  assert.equal(f.voice.cleanupUnconfirmed, true);
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    voiceError('VOICE_CONNECTION_NOT_READY'),
  );
  f.effects.releaseFails = false;
  await f.voice.releaseCall(f.call.callId);
  assert.equal(f.voice.cleanupUnconfirmed, false);
  assert.equal(f.voice.consume(f.fields(prepared.join)), 'cleanup');
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    voiceError('INVALID_VOICE_JOIN'),
  );
  assert.equal(f.effects.releases, 2);
});

test('a malformed reservation with a safe release rolls back; boolean or asynchronous assertions never grant', async () => {
  for (const assertCurrent of [async () => {}, () => true]) {
    let releases = 0;
    const f = fixture({
      admission: {
        reserve: async () => ({
          assertCurrent,
          release: async () => {
            releases += 1;
          },
        }),
      },
    });
    await assert.rejects(
      f.voice.prepareGrant(f.context, f.call.callId),
      voiceError('VOICE_CONNECTION_NOT_READY'),
    );
    assert.equal(f.effects.signs, 0);
    assert.equal(releases, 1);
    assert.equal(f.voice.cleanupUnconfirmed, false);
  }
});

test('an uncertain reserve failure or malformed result cannot be treated as a clean rollback', async () => {
  for (const reserve of [
    async () => {
      throw new Error('unknown transaction');
    },
    async () => ({}),
  ]) {
    const f = fixture({
      // Deliberately violate the injected port contract to verify fail-closed behavior.
      admission: {
        reserve: reserve as unknown as CloudVoiceAdmission['reserve'],
      },
    });
    await assert.rejects(
      f.voice.prepareGrant(f.context, f.call.callId),
      voiceError('VOICE_CONNECTION_NOT_READY'),
    );
    assert.equal(f.voice.cleanupUnconfirmed, true);
    await f.voice.releaseCall(f.call.callId);
    assert.equal(f.voice.cleanupUnconfirmed, true);
    await assert.rejects(
      f.voice.prepareGrant(f.context, f.call.callId),
      voiceError('VOICE_CONNECTION_NOT_READY'),
    );
    assert.equal(f.effects.signs, 0);
  }
});

test('an unpublished rollback during preparation invalidates the result and releases its budget', async () => {
  const reserve = deferred<CloudVoiceReservation>();
  const f = fixture({ admission: { reserve: () => reserve.promise } });
  const pending = f.voice.prepareGrant(f.context, f.call.callId);
  f.dispose();
  reserve.resolve(f.held);
  await assert.rejects(pending, voiceError('INVALID_VOICE_JOIN'));
  assert.equal(f.effects.releases, 1);
  assert.equal(f.voice.cleanupUnconfirmed, false);
});

test('record admission is bounded, forbids global local identity and pins controller epoch', () => {
  const f = fixture({ maxCalls: 1 });
  const other = {
    callId: 'call-b',
    identity: 'per_call_identity_b',
    nonce: 'nonce_b',
  };
  f.policy.registerCall(f.context, other.callId);
  assert.throws(
    () =>
      f.voice.registerCall(f.context, other, () =>
        f.leases.authorizeCurrent(f.bound),
      ),
    voiceError('VOICE_CONNECTION_NOT_READY'),
  );
  assert.throws(
    () =>
      f.voice.registerCall(f.context, { ...other, identity: 'ai-phone' }, () =>
        f.leases.authorizeCurrent(f.bound),
      ),
    voiceError('INVALID_VOICE_JOIN'),
  );
});

test('an injected validator cannot revoke login and then deliver a cached permission', async () => {
  let invalidate = () => {};
  const f = fixture({
    admission: {
      reserve: async () => ({
        assertCurrent: () => {
          invalidate();
        },
        release: async () => {},
      }),
    },
  });
  await f.voice.prepareGrant(f.context, f.call.callId);
  invalidate = () => {
    f.session.revoked = true;
  };
  await assert.rejects(
    f.voice.prepareGrant(f.context, f.call.callId),
    accessError('UNAUTHORIZED'),
  );
});

test('explicit reservation methods keep their original receiver for current state and safe release', async () => {
  const held = {
    current: true,
    releases: 0,
    assertCurrent() {
      if (!this.current) throw new Error('synthetic reservation was revoked');
    },
    async release() {
      this.releases += 1;
    },
  };
  const f = fixture({ admission: { reserve: async () => held } });
  const prepared = await f.voice.prepareGrant(f.context, f.call.callId);
  held.current = false;
  assert.throws(
    () => f.voice.assertPreparedCurrent(f.context, f.call.callId, prepared),
    voiceError('VOICE_CONNECTION_NOT_READY'),
  );
  await f.voice.releaseCall(f.call.callId);
  assert.equal(held.releases, 1);
  assert.equal(f.voice.cleanupUnconfirmed, false);
});
