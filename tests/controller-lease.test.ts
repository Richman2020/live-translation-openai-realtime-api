import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_CSRF_HEADER,
  CLOUD_SESSION_COOKIE,
  CloudAccessError,
  CloudAccessPolicy,
  type CloudAccessContext,
  type CloudAuthSession,
} from '../src/solo/cloud-access';
import {
  CloudControllerLeases,
  ControllerLeaseError,
  type BoundControllerLease,
  type ControllerProof,
} from '../src/solo/controller-lease';

// Synthetic sessions and time only. No login provider, token signer or network.
const publicOrigin = 'https://phone.example.com';
const tokenA = Buffer.alloc(32, 1).toString('base64url');
const tokenB = Buffer.alloc(32, 2).toString('base64url');
const csrf = Buffer.alloc(32, 3).toString('base64url');
function fixture(ttlMs = 30000) {
  let now = 10000;
  const make = (letter: string): CloudAuthSession => ({
    authSessionId: `session-${letter}`,
    principalId: 'same-single-principal',
    browserOwnerId: 'same-browser-owner',
    epoch: 1,
    issuedAt: 1000,
    absoluteExpiresAt: 180000,
    idleExpiresAt: 90000,
    revoked: false,
    csrfToken: csrf,
  });
  const sessionA = make('a');
  const sessionB = make('b');
  const sessions = new Map([
    [tokenA, sessionA],
    [tokenB, sessionB],
  ]);
  const policy = new CloudAccessPolicy({
    publicOrigin,
    now: () => now,
    resolveSession: (token) => sessions.get(token),
  });
  const leases = new CloudControllerLeases({ policy, ttlMs, now: () => now });
  const headers = (other = false) => ({
    host: 'phone.example.com',
    origin: publicOrigin,
    cookie: `${CLOUD_SESSION_COOKIE}=${other ? tokenB : tokenA}`,
    [CLOUD_CSRF_HEADER]: csrf,
  });
  const post = (other = false) =>
    policy.authenticate(headers(other), 'mutate', {
      surface: 'http',
      method: 'POST',
    });
  const read = (other = false) =>
    policy.authenticate(headers(other), 'read', {
      surface: 'http',
      method: 'GET',
    });
  return {
    policy,
    leases,
    sessionA,
    sessionB,
    post,
    read,
    headers,
    advance: (value: number) => {
      now = value;
    },
  };
}

function denied(
  action: () => unknown,
  code: CloudAccessError['code'] = 'FORBIDDEN',
) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CloudAccessError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function held(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ControllerLeaseError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'CONTROLLER_BUSY');
    assert.equal(error.message, 'CONTROLLER_BUSY');
    return true;
  });
}

test('controller leases require a real policy and a finite bounded server TTL', () => {
  const f = fixture();
  for (const ttlMs of [0, -1, 1.5, 60001, Infinity, NaN])
    denied(() => new CloudControllerLeases({ policy: f.policy, ttlMs }));
  denied(() => new CloudControllerLeases({ policy: {} as CloudAccessPolicy }));
  denied(
    () =>
      new CloudControllerLeases({
        policy: f.policy,
        now: 'request-clock' as unknown as () => number,
      }),
  );
});

test('acquire issues a frozen unpredictable capability with a server epoch and deadline', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  assert.ok(Object.isFrozen(lease));
  assert.equal(lease.tabId, 'tab-a');
  assert.equal(lease.epoch, 1);
  assert.equal(lease.expiresAt, 40000);
  assert.equal(Buffer.from(lease.leaseId, 'base64url').length, 32);
  assert.equal(
    Buffer.from(lease.leaseId, 'base64url').toString('base64url'),
    lease.leaseId,
  );
  assert.equal(f.leases.policy, f.policy);
});

test('unverified or copied authorization contexts cannot issue a controller lease', () => {
  const f = fixture();
  const context = f.post();
  denied(() => f.leases.acquire({ ...context }, 'tab-a'), 'UNAUTHORIZED');
  denied(
    () => f.leases.acquire({} as CloudAccessContext, 'tab-a'),
    'UNAUTHORIZED',
  );
  assert.equal(f.leases.status(f.read()).epoch, 0);
});

test('read-only HTTP contexts cannot acquire, renew, revoke or bind a controller', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const context = f.read();
  denied(() => f.leases.acquire(context, 'tab-b'));
  denied(() => f.leases.renew(context, lease));
  denied(() => f.leases.revoke(context, lease));
  denied(() => f.leases.authorize(context, lease));
  assert.equal(f.leases.status(context, 'tab-a').mode, 'held');
});

test('same-cookie tab claims cannot retrieve an existing lease or extend its expiry', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  f.advance(20000);
  held(() => f.leases.acquire(f.post(), 'tab-a'));
  held(() => f.leases.acquire(f.post(), 'tab-b'));
  held(() => f.leases.acquire(f.post(true), 'tab-a'));
  assert.equal(f.leases.status(f.read()).expiresAt, lease.expiresAt);
});

test('only explicit authenticated renewal extends a current lease', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  f.advance(20000);
  const renewed = f.leases.renew(f.post(), { ...lease });
  assert.ok(Object.isFrozen(renewed));
  assert.equal(renewed.leaseId, lease.leaseId);
  assert.equal(renewed.epoch, lease.epoch);
  assert.equal(renewed.expiresAt, 50000);
});

test('a lease binds all of auth session, principal, owner and authentication epoch', () => {
  for (const field of [
    'authSessionId',
    'principalId',
    'browserOwnerId',
    'epoch',
  ] as const) {
    const f = fixture();
    const lease = f.leases.acquire(f.post(), 'tab-a');
    if (field === 'epoch') f.sessionA[field] += 1;
    else f.sessionA[field] = `changed-${field}`;
    // A newly authenticated context still cannot inherit the previous binding.
    denied(() => f.leases.authorize(f.post(), lease));
  }
});

test('separate login sessions cannot share a lease even with equal principal and browser owner', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  denied(() => f.leases.authorize(f.post(true), lease));
  denied(() => f.leases.renew(f.post(true), lease));
  denied(() => f.leases.revoke(f.post(true), lease));
});

test('wrong tab, capability or control epoch cannot use a lease', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const proofs = [
    { ...lease, tabId: 'tab-b' },
    { ...lease, leaseId: Buffer.alloc(32, 4).toString('base64url') },
    { ...lease, epoch: lease.epoch + 1 },
  ];
  for (const proof of proofs) {
    denied(() => f.leases.authorize(f.post(), proof));
    denied(() => f.leases.renew(f.post(), proof));
    denied(() => f.leases.revoke(f.post(), proof));
  }
});

test('proofs use data fields and reject missing, inherited, malformed and accessor claims', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  let getters = 0;
  const accessor = Object.defineProperty({ ...lease }, 'leaseId', {
    get: () => {
      getters += 1;
      return lease.leaseId;
    },
  });
  const invalid: unknown[] = [
    null,
    [],
    {},
    Object.create(lease),
    accessor,
    { ...lease, tabId: '' },
    { ...lease, tabId: 'a'.repeat(129) },
    { ...lease, tabId: 'tab/a' },
    { ...lease, leaseId: `${lease.leaseId}=` },
    { ...lease, epoch: 0 },
    { ...lease, epoch: 1.5 },
  ];
  for (const proof of invalid)
    denied(() => f.leases.authorize(f.post(), proof as ControllerProof));
  assert.equal(getters, 0);
});

test('a server-bound handle must be issued, not constructed from public or copied fields', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), { ...lease });
  assert.ok(Object.isFrozen(bound));
  assert.equal(f.leases.authorizeCurrent(bound).leaseId, lease.leaseId);
  denied(() => f.leases.authorizeCurrent(lease), 'UNAUTHORIZED');
  denied(() => f.leases.authorizeCurrent({ ...bound }), 'UNAUTHORIZED');
  denied(
    () => f.leases.authorizeCurrent({} as BoundControllerLease),
    'UNAUTHORIZED',
  );
});

test('a handle issued by another lease registry is never authority here', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  const other = new CloudControllerLeases({
    policy: f.policy,
    now: () => 10000,
  });
  denied(() => other.authorizeCurrent(bound), 'UNAUTHORIZED');
});

test('a bound handle revalidates its original mutation context on every media/lifecycle use', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.sessionA.revoked = true;
  denied(() => f.leases.authorizeCurrent(bound), 'UNAUTHORIZED');
  denied(() => f.leases.renew(f.post(), lease), 'UNAUTHORIZED');
});

test('changed authentication epoch invalidates previously bound media authority', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.sessionA.epoch += 1;
  denied(() => f.leases.authorizeCurrent(bound), 'UNAUTHORIZED');
});

test('CSRF rotation invalidates old bound mutation context even while login is current', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.sessionA.csrfToken = Buffer.alloc(32, 5).toString('base64url');
  denied(() => f.leases.authorizeCurrent(bound));
});

test('status has only read hints and never exposes a capability to another tab or session', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const owner = f.leases.status(f.read(), 'tab-a');
  const tab = f.leases.status(f.read(), 'tab-b');
  const session = f.leases.status(f.read(true), 'tab-a');
  assert.deepEqual(owner, {
    mode: 'held',
    ownSession: true,
    tabMatches: true,
    epoch: lease.epoch,
    expiresAt: lease.expiresAt,
  });
  assert.equal(tab.ownSession, true);
  assert.equal(tab.tabMatches, false);
  assert.equal(session.ownSession, false);
  assert.equal(session.tabMatches, false);
  for (const value of [owner, tab, session]) {
    assert.ok(Object.isFrozen(value));
    assert.equal(JSON.stringify(value).includes(lease.leaseId), false);
    assert.equal('leaseId' in value, false);
    assert.equal('tabId' in value, false);
  }
});

test('repeated read/SSE-style status checks and media authorization cannot renew a lease', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  for (const now of [15000, 20000, 25000, 39999]) {
    f.advance(now);
    assert.equal(f.leases.status(f.read(), 'tab-a').expiresAt, 40000);
    assert.equal(f.leases.authorizeCurrent(bound).expiresAt, 40000);
  }
  f.advance(40000);
  assert.equal(f.leases.status(f.read()).mode, 'available');
  denied(() => f.leases.authorizeCurrent(bound));
  denied(() => f.leases.renew(f.post(), lease));
});

test('renewal preserves issued handle identity while its next freshness check sees the new deadline', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.advance(20000);
  f.leases.renew(f.post(), lease);
  f.advance(45000);
  assert.equal(bound.expiresAt, 40000);
  assert.equal(f.leases.authorizeCurrent(bound).expiresAt, 50000);
});

test('expiry invalidates old proofs and reacquisition uses a new capability and increasing epoch', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.advance(40000);
  const next = f.leases.acquire(f.post(), 'tab-b', { busy: false });
  assert.ok(next.epoch > lease.epoch);
  assert.notEqual(next.leaseId, lease.leaseId);
  denied(() => f.leases.authorize(f.post(), lease));
  denied(() => f.leases.authorizeCurrent(bound));
});

test('busy preparing, active or unconfirmed cleanup gates acquisition even after lease expiry', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  f.advance(40000);
  held(() => f.leases.acquire(f.post(), 'tab-b', { busy: true }));
  assert.equal(f.leases.status(f.read()).epoch, lease.epoch);
  const next = f.leases.acquire(f.post(), 'tab-b', { busy: false });
  assert.equal(next.epoch, lease.epoch + 1);
});

test('busy acquisition does not issue a lease, while an existing owner may explicitly renew during a call', () => {
  const f = fixture();
  held(() => f.leases.acquire(f.post(), 'tab-a', { busy: true }));
  assert.equal(f.leases.status(f.read()).mode, 'available');
  assert.equal(f.leases.status(f.read()).epoch, 0);
  const lease = f.leases.acquire(f.post(), 'tab-a');
  f.advance(20000);
  assert.equal(f.leases.renew(f.post(), lease).expiresAt, 50000);
});

test('explicit revoke invalidates all old handles and increments the server epoch', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.leases.revoke(f.post(), lease);
  assert.equal(f.leases.status(f.read()).mode, 'available');
  assert.ok(f.leases.status(f.read()).epoch > lease.epoch);
  denied(() => f.leases.authorizeCurrent(bound));
  denied(() => f.leases.renew(f.post(), lease));
  denied(() => f.leases.revoke(f.post(), lease));
  const next = f.leases.acquire(f.post(), 'tab-a');
  assert.ok(next.epoch > lease.epoch);
  assert.notEqual(next.leaseId, lease.leaseId);
});

test('acquire and renew deadlines are bounded by both current authentication expiries', () => {
  const f = fixture(60000);
  f.sessionA.idleExpiresAt = 18000;
  f.sessionA.absoluteExpiresAt = 25000;
  const lease = f.leases.acquire(f.post(), 'tab-a');
  assert.equal(lease.expiresAt, 18000);
  f.advance(12000);
  f.sessionA.idleExpiresAt = 24000;
  assert.equal(f.leases.renew(f.post(), lease).expiresAt, 24000);
  f.sessionA.idleExpiresAt = 80000;
  assert.equal(f.leases.renew(f.post(), lease).expiresAt, 25000);
});

test('an authenticated deadline shortened after issue is reflected by each current grant check', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.sessionA.idleExpiresAt = 15000;
  assert.equal(f.leases.authorizeCurrent(bound).expiresAt, 15000);
  f.advance(15000);
  denied(() => f.leases.authorizeCurrent(bound), 'UNAUTHORIZED');
});

test('invalid or backwards server time cannot authorize a lease or manufacture deadlines', () => {
  const f = fixture();
  const lease = f.leases.acquire(f.post(), 'tab-a');
  const bound = f.leases.authorize(f.post(), lease);
  f.advance(9000);
  denied(() => f.leases.authorizeCurrent(bound));
  denied(() => f.leases.renew(f.post(), lease));
  const bad = new CloudControllerLeases({ policy: f.policy, now: () => NaN });
  denied(() => bad.acquire(f.post(), 'tab-a'));
});

test('expiry query returns only the freshly validated current auth deadline', () => {
  const f = fixture();
  assert.equal(f.policy.expiresAt(f.read()), 90000);
  const context = f.post();
  assert.equal(f.policy.expiresAt(context, 'mutate'), 90000);
  f.sessionA.absoluteExpiresAt = 50000;
  assert.equal(f.policy.expiresAt(context, 'mutate'), 50000);
  f.sessionA.idleExpiresAt = 20000;
  assert.equal(f.policy.expiresAt(context, 'mutate'), 20000);
});

test('auth deadline lookup cannot promote reading context, copies, stale epoch or revoked sessions', () => {
  const f = fixture();
  denied(() => f.policy.expiresAt(f.read(), 'mutate'));
  const context = f.post();
  denied(() => f.policy.expiresAt({ ...context }, 'mutate'), 'UNAUTHORIZED');
  f.sessionA.epoch += 1;
  denied(() => f.policy.expiresAt(context, 'mutate'), 'UNAUTHORIZED');
  const fresh = f.post();
  f.sessionA.revoked = true;
  denied(() => f.policy.expiresAt(fresh, 'mutate'), 'UNAUTHORIZED');
});

test('auth deadline lookup rechecks CSRF and refuses expiry boundaries', () => {
  const f = fixture();
  const context = f.post();
  f.sessionA.csrfToken = Buffer.alloc(32, 6).toString('base64url');
  denied(() => f.policy.expiresAt(context, 'mutate'));
  f.sessionA.csrfToken = csrf;
  f.advance(90000);
  denied(() => f.policy.expiresAt(context, 'mutate'), 'UNAUTHORIZED');
});
