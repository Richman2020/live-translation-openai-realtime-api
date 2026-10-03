import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionMaintenance } from '../src/solo/connection-maintenance';
import { desktopConnectivity } from '../src/solo/desktop-connectivity';
import { DesktopOnlineCoordinator, reconcileDesktopRouting, type DesktopRoutingClient } from '../src/solo/desktop-online';
import type { SoloConfig } from '../src/solo/config';

test('maintenance cannot begin over an active call and only its owner can renew or release', () => {
  let now = 0;
  const lease = new ConnectionMaintenance(() => now);
  assert.throws(() => lease.begin(true), /CONNECTION_MAINTENANCE_BUSY/);
  const first = lease.begin(false);
  assert.equal(lease.active, true);
  assert.throws(() => lease.begin(false), /BUSY/);
  assert.throws(() => lease.end('wrong'), /INVALID/);
  now = 170000; lease.renew(first);
  now = 340000; assert.equal(lease.active, true);
  now = 350001; assert.equal(lease.active, false);
  const second = lease.begin(false);
  assert.throws(() => lease.end(first), /INVALID/);
  lease.end(second); assert.equal(lease.active, false);
});

test('desktop status excludes arbitrary private fields and treats stale, malformed or large evidence as offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-desktop-status-'));
  const file = join(dir, 'status.json');
  try {
    writeFileSync(file, JSON.stringify({ state: 'ready', code: 'CONNECTED', token: 'must-never-leave-private-file' }));
    assert.deepEqual(desktopConnectivity(file), { state: 'ready', code: 'CONNECTED' });
    utimesSync(file, new Date(0), new Date(0));
    assert.equal(desktopConnectivity(file).state, 'offline');
    for (const value of ['{', JSON.stringify({ state: 'ready', code: 'some-private-error' }), ' '.repeat(5000)]) {
      writeFileSync(file, value); assert.equal(desktopConnectivity(file).state, 'offline');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function routingFixture() {
  const config = { TWILIO_ACCOUNT_SID:'ACfixture', TWILIO_CALLER_NUMBER:'+12125551234', TWILIO_API_KEY_SID:'SKfixture', TWILIO_API_KEY_SECRET:'fixture', TWILIO_TWIML_APP_SID:'APfixture', PUBLIC_BASE_URL:'https://phone.example.com' } as SoloConfig;
  const number = { sid:'PNfixture', phoneNumber:config.TWILIO_CALLER_NUMBER, capabilities:{voice:true}, voiceUrl:'https://old.example/voice', voiceMethod:'POST', voiceApplicationSid:'', voiceFallbackUrl:'', voiceFallbackMethod:'POST', statusCallback:'', statusCallbackMethod:'POST' };
  const app = { sid:'APfixture', voiceUrl:'https://old.example/client', voiceMethod:'POST' };
  const events:string[]=[];
  let active = false;
  let verified = true;
  let lostLease = false;
  const client:DesktopRoutingClient = {
    account: async () => ({status:'active'}), numbers:async()=>[number], application:async()=>app,
    activeCalls:async (direction,status) => { events.push(`idle:${direction}:${status}`); return active && direction==='to' && status==='ringing' ? [{}] : []; },
    updateApp:async url=>{events.push('app');app.voiceUrl=url;},
    updateNumber:async (_sid,url)=>{events.push('number');number.voiceUrl=url;},
    number:async()=>number,
  };
  const run = () => reconcileDesktopRouting(config, { client,
    backup:()=>{events.push('backup');},
    assertLease:async()=>{events.push('lease');if(lostLease)throw new Error('lost');},
    verify:async()=>{events.push('verify');return verified;},
  });
  return { config, events, number, app, run, active:()=>{active=true;}, failVerify:()=>{verified=false;}, loseLease:()=>{lostLease=true;} };
}
test('routing checks both number directions, backs up and verifies providers before moving the number', async () => {
  const f=routingFixture(); await f.run();
  assert.equal(f.events.filter(v=>v.startsWith('idle')).length,6);
  assert.ok(f.events.indexOf('backup')<f.events.indexOf('app'));
  assert.ok(f.events.indexOf('app')<f.events.indexOf('verify'));
  assert.ok(f.events.indexOf('verify')<f.events.indexOf('number'));
  assert.equal(f.app.voiceUrl,`${f.config.PUBLIC_BASE_URL}/voice/client`);
  assert.equal(f.number.voiceUrl,`${f.config.PUBLIC_BASE_URL}/voice/incoming`);
  f.events.length=0; await f.run();
  assert.ok(!f.events.includes('backup')&&!f.events.includes('app')&&!f.events.includes('number'),'healthy callbacks are not written again');
});
test('an external call, provider failure or lost maintenance lease blocks resource mutation', async () => {
  const active=routingFixture(); active.active(); await assert.rejects(active.run(),/EXTERNAL_CALL_ACTIVE/);
  assert.ok(!active.events.includes('app')&&!active.events.includes('verify')&&!active.events.includes('number'));
  const provider=routingFixture();provider.failVerify();await assert.rejects(provider.run(),/PROVIDER_CHECK_FAILED/);
  assert.ok(!provider.events.includes('number'));
  const lease=routingFixture();lease.loseLease();await assert.rejects(lease.run(),/lost/);
  assert.ok(!lease.events.includes('app')&&!lease.events.includes('number'));
});

function coordinatorFixture() {
  const events:string[]=[];const states:unknown[]=[];
  let paused=false,active=false,maintenance=false,connected=true,service=true,verified=true,now=0;
  let publicUrl='https://phone.example';
  const coordinator = new DesktopOnlineCoordinator({
    paused:()=>paused, now:()=>now,
    status:async()=>{events.push('status');if(!service)throw new Error('offline');return {configured:true,verified,activeSession:active?{}:null,connectionMaintenance:maintenance,publicUrl,translationEngines:[]};},
    ensureService:async()=>{events.push('service');service=true;},
    publicReady:async()=>{events.push('probe');return connected;},
    repair:async restart=>{events.push(`repair:${restart}`);verified=true;return publicUrl;},
    publish:v=>{states.push(v);},
  });
  return {coordinator,events,states,pause:()=>{paused=true;},activate:()=>{active=true;},maintenance:()=>{maintenance=true;},disconnect:()=>{connected=false;},connect:()=>{connected=true;},loseService:()=>{service=false;},loseVerification:()=>{verified=false;},changeAddress:()=>{publicUrl='https://new-phone.example';},advance:(ms:number)=>{now+=ms;}};
}
test('coordinator respects explicit stop, active calls and other maintenance without probing or restarting', async () => {
  for(const mode of ['pause','activate','maintenance'] as const){const f=coordinatorFixture();f[mode]();await f.coordinator.tick();assert.ok(!f.events.includes('probe')&&!f.events.some(v=>v.startsWith('repair'))&&!f.events.includes('service'));}
});
test('coordinator restores a dead service, avoids periodic provider churn and only restarts after three failed public probes', async () => {
  const f=coordinatorFixture();f.loseService();await f.coordinator.tick();assert.deepEqual(f.events,['status','service']);
  f.events.length=0;await f.coordinator.tick();assert.ok(f.events.includes('repair:false'));
  f.events.length=0;await f.coordinator.tick();assert.deepEqual(f.events,['status','probe']);
  f.loseVerification();f.events.length=0;await f.coordinator.tick();assert.ok(f.events.includes('repair:false'),'a restarted server is reverified even with the same public address');
  f.disconnect();f.events.length=0;await f.coordinator.tick();await f.coordinator.tick();assert.ok(!f.events.some(v=>v.startsWith('repair')));
  await f.coordinator.tick();assert.ok(f.events.includes('repair:true'));
  f.connect();f.advance(3600001);f.events.length=0;await f.coordinator.tick();assert.ok(f.events.some(v=>v.startsWith('repair')));
});

test('a new public address gets three fresh failed probes before another tunnel restart', async () => {
  const f=coordinatorFixture();await f.coordinator.tick();f.disconnect();
  await f.coordinator.tick();await f.coordinator.tick();
  f.changeAddress();f.events.length=0;
  await f.coordinator.tick();await f.coordinator.tick();
  assert.ok(!f.events.some(v=>v.startsWith('repair')));
  await f.coordinator.tick();assert.ok(f.events.includes('repair:true'));
});
