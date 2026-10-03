import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../src/solo/config';
import { checkPublicReadiness } from '../src/solo/public-readiness';
import { DesktopOnlineCoordinator, reconcileDesktopRouting, desktopRoutingClient, assertDesktopNoExternalCalls, type DesktopOnlineState } from '../src/solo/desktop-online';

const runtime = resolve('.runtime');
mkdirSync(runtime, { recursive: true });
const paused = () => existsSync(resolve(runtime, 'desktop-online-paused'));
let current: DesktopOnlineState = { state: 'starting', code: 'CHECKING' };
function publish(value = current) {
  current = value;
  const file = resolve(runtime, 'desktop-online-state.json');
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...value, checkedAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(temp, file);
}
const store = () => new ConfigStore({ generateToken: false });
async function api(path: string, body?: unknown, lease = '') {
  const config = store().value;
  const response = await fetch(`http://127.0.0.1:${config.API_PORT}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.LOCAL_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(lease ? { 'X-Phone-Maintenance': lease } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path === '/api/verify' ? 150000 : 10000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error === 'CONNECTION_MAINTENANCE_BUSY' ? value.error : 'RECOVERY_FAILED');
  return value;
}
function script(name: string, args: string[] = []) {
  return new Promise<void>((yes, no) => {
    const powerShell = resolve(process.env.WINDIR || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts', name), ...args], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); no(new Error('RECOVERY_FAILED')); }, 180000);
    child.once('error', () => { clearTimeout(timer); no(new Error('RECOVERY_FAILED')); });
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) yes(); else no(new Error('RECOVERY_FAILED')); });
  });
}
const coordinator = new DesktopOnlineCoordinator({
  paused,
  status: async () => {
    const status = await api('/api/status');
    return { ...status, verified: Boolean(status.lastVerification?.checks?.length && status.lastVerification.checks.every((check: { status: string }) => check.status === 'passed')) };
  },
  ensureService: () => script('Start-AIPhone.ps1', ['-NoOpen', '-LocalOnly']),
  publicReady: async () => (await checkPublicReadiness(store().value)).status === 'ready',
  publish,
  repair: async (restartTunnel) => {
    const acquired = await api('/api/connection-maintenance', { action: 'begin' });
    const lease = acquired.lease;
    let lost = false;
    const assertLease = async () => {
      if (lost || paused()) throw new Error('RECOVERY_FAILED');
      await api('/api/connection-maintenance', { action: 'renew', lease });
    };
    const renewal = setInterval(() => { assertLease().catch(() => { lost = true; }); }, 20000);
    try {
      await assertLease();
      await assertDesktopNoExternalCalls(desktopRoutingClient(store().value));
      if (restartTunnel) await script('Stop-Tunnel.ps1', ['-Quiet', '-RequireMaintenance']);
      await script('Start-Tunnel.ps1', ['-NoConfigure']);
      await assertLease();
      const tunnel = JSON.parse(readFileSync(resolve(runtime, 'tunnel.json'), 'utf8'));
      if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(tunnel.url)) throw new Error('RECOVERY_FAILED');
      const before = store().value;
      if (before.PUBLIC_BASE_URL !== tunnel.url) await api('/api/settings', { PUBLIC_BASE_URL: tunnel.url }, lease);
      const config = store().value;
      if ((await checkPublicReadiness(config)).status !== 'ready') throw new Error('PUBLIC_CALLBACK_UNREACHABLE');
      await reconcileDesktopRouting(config, {
        assertLease,
        backup: (value) => writeFileSync(resolve(runtime, `desktop-routing-backup-${Date.now()}.json`), JSON.stringify(value), { mode: 0o600 }),
        verify: async () => {
          const status = await api('/api/status');
          const engine = status.translationEngines.includes('pocket-captions') ? 'pocket-captions' : 'legacy';
          const report = await api('/api/verify', { translationEngine: engine }, lease);
          return report.checks.every((check: { status: string }) => check.status === 'passed');
        },
      });
      return config.PUBLIC_BASE_URL;
    } finally {
      clearInterval(renewal);
      await api('/api/connection-maintenance', { action: 'end', lease }).catch(() => {});
    }
  },
});
publish();
const heartbeat = setInterval(() => { try { publish(); } catch { /* The next cycle retries status persistence. */ } }, 20000);
let ending = false;
process.once('SIGTERM', () => { ending = true; });
process.once('SIGINT', () => { ending = true; });
while (!ending) {
  try { await coordinator.tick(); } catch { publish({ state: 'recovering', code: 'RECOVERY_FAILED' }); }
  // Local idle probes only; no calls, audio or reply generation are performed.
  if (!ending) await new Promise<void>((yes) => setTimeout(yes, 15000));
}
clearInterval(heartbeat);
publish({ state: 'paused', code: 'STOPPED' });
