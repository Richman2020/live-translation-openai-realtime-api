import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const STATES = [
  'starting',
  'ready',
  'recovering',
  'paused',
  'call_active',
  'offline',
];
const CODES = [
  'CHECKING',
  'CONNECTED',
  'CALL_IN_PROGRESS',
  'STOPPED',
  'SERVICE_STARTING',
  'PUBLIC_CALLBACK_UNREACHABLE',
  'CONFIGURATION_REQUIRED',
  'EXTERNAL_CALL_ACTIVE',
  'PROVIDER_CHECK_FAILED',
  'ROUTING_FAILED',
  'CONNECTION_MAINTENANCE_BUSY',
  'RECOVERY_FAILED',
];

/** Only public status labels leave the private daemon record. */
export function desktopConnectivity(
  file = resolve('.runtime/desktop-online-state.json'),
  now = Date.now(),
): { state: string; code: string } {
  try {
    const stats = statSync(file);
    if (
      stats.size > 4096 ||
      now - stats.mtimeMs > 90000 ||
      stats.mtimeMs > now + 5000
    )
      return { state: 'offline', code: 'RECOVERY_FAILED' };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!STATES.includes(value.state) || !CODES.includes(value.code))
      return { state: 'offline', code: 'RECOVERY_FAILED' };
    return { state: value.state, code: value.code };
  } catch {
    return { state: 'offline', code: 'RECOVERY_FAILED' };
  }
}
