import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient';

import type { SoloConfig } from './config';

type VoiceNumber = {
  sid: string;
  phoneNumber: string;
  capabilities: { voice?: boolean };
  voiceUrl: string;
  voiceMethod: string;
  voiceApplicationSid: string;
  voiceFallbackUrl: string;
  voiceFallbackMethod: string;
  statusCallback: string;
  statusCallbackMethod: string;
};
type VoiceApp = { sid: string; voiceUrl: string; voiceMethod: string };
export type DesktopRoutingClient = {
  account(): Promise<{ status: string }>;
  numbers(): Promise<VoiceNumber[]>;
  application(): Promise<VoiceApp>;
  activeCalls(
    direction: 'from' | 'to',
    status: 'queued' | 'ringing' | 'in-progress',
  ): Promise<unknown[]>;
  updateApp(url: string): Promise<unknown>;
  updateNumber(sid: string, url: string): Promise<unknown>;
  number(sid: string): Promise<VoiceNumber>;
};

export function desktopRoutingClient(config: SoloConfig): DesktopRoutingClient {
  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN, {
    httpClient: new RequestClient({ timeout: 15000, autoRetry: false }),
    autoRetry: false,
  });
  return {
    account: () => client.api.v2010.accounts(config.TWILIO_ACCOUNT_SID).fetch(),
    numbers: () =>
      client.incomingPhoneNumbers.list({
        phoneNumber: config.TWILIO_CALLER_NUMBER,
        limit: 2,
      }),
    application: () => client.applications(config.TWILIO_TWIML_APP_SID).fetch(),
    activeCalls: (direction, status) =>
      client.calls.list({
        [direction]: config.TWILIO_CALLER_NUMBER,
        status,
        limit: 1,
      }),
    updateApp: (url) =>
      client
        .applications(config.TWILIO_TWIML_APP_SID)
        .update({ voiceUrl: url, voiceMethod: 'POST' }),
    updateNumber: (sid, url) =>
      client.incomingPhoneNumbers(sid).update({
        voiceUrl: url,
        voiceMethod: 'POST',
        voiceApplicationSid: '',
        voiceFallbackUrl: '',
        statusCallback: '',
      }),
    number: (sid) => client.incomingPhoneNumbers(sid).fetch(),
  };
}

export async function assertDesktopNoExternalCalls(
  client: DesktopRoutingClient,
): Promise<void> {
  const calls = await Promise.all(
    (['from', 'to'] as const).flatMap((direction) =>
      (['queued', 'ringing', 'in-progress'] as const).map((state) =>
        client.activeCalls(direction, state),
      ),
    ),
  );
  if (calls.some((list) => list.length))
    throw new Error('EXTERNAL_CALL_ACTIVE');
}

/** Caller holds the server's idle-only lease, renewed before every mutation. */
export async function reconcileDesktopRouting(
  config: SoloConfig,
  options: {
    client?: DesktopRoutingClient;
    assertLease: () => Promise<void>;
    verify: () => Promise<boolean>;
    backup: (value: unknown) => void;
  },
): Promise<void> {
  if (
    !config.TWILIO_API_KEY_SID ||
    !config.TWILIO_API_KEY_SECRET ||
    !config.TWILIO_TWIML_APP_SID
  )
    throw new Error('CONFIGURATION_REQUIRED');
  const client = options.client || desktopRoutingClient(config);
  const [account, numbers, app] = await Promise.all([
    client.account(),
    client.numbers(),
    client.application(),
  ]);
  const number = numbers.find(
    (item) =>
      item.phoneNumber === config.TWILIO_CALLER_NUMBER &&
      item.capabilities.voice,
  );
  if (account.status !== 'active' || !number) throw new Error('ROUTING_FAILED');
  await assertDesktopNoExternalCalls(client);
  const appUrl = `${config.PUBLIC_BASE_URL}/voice/client`;
  const numberUrl = `${config.PUBLIC_BASE_URL}/voice/incoming`;
  const appChanged = app.voiceUrl !== appUrl || app.voiceMethod !== 'POST';
  const numberChanged =
    number.voiceUrl !== numberUrl ||
    number.voiceMethod !== 'POST' ||
    Boolean(
      number.voiceApplicationSid ||
        number.voiceFallbackUrl ||
        number.statusCallback,
    );
  if (appChanged || numberChanged) options.backup({ app, number });
  if (appChanged) {
    await options.assertLease();
    await client.updateApp(appUrl);
  }
  await options.assertLease();
  if (!(await options.verify())) throw new Error('PROVIDER_CHECK_FAILED');
  if (numberChanged) {
    await options.assertLease();
    await client.updateNumber(number.sid, numberUrl);
  }
  const [currentApp, currentNumber] = await Promise.all([
    client.application(),
    client.number(number.sid),
  ]);
  if (
    currentApp.voiceUrl !== appUrl ||
    currentApp.voiceMethod !== 'POST' ||
    currentNumber.voiceUrl !== numberUrl ||
    currentNumber.voiceMethod !== 'POST' ||
    currentNumber.voiceApplicationSid ||
    currentNumber.voiceFallbackUrl ||
    currentNumber.statusCallback
  )
    throw new Error('ROUTING_FAILED');
}

export type DesktopLocalStatus = {
  configured: boolean;
  verified: boolean;
  activeSession: unknown;
  connectionMaintenance: boolean;
  publicUrl: string;
  translationEngines: string[];
};
export type DesktopOnlineState = {
  state:
    | 'starting'
    | 'ready'
    | 'recovering'
    | 'paused'
    | 'call_active'
    | 'offline';
  code: string;
};

/** No reconfiguration occurs in an active call, a pause, or another repair. */
export class DesktopOnlineCoordinator {
  private lastUrl = '';

  private lastRepair = 0;

  private publicFailures = 0;

  private probedUrl = '';

  constructor(
    private dependencies: {
      paused(): boolean;
      status(): Promise<DesktopLocalStatus>;
      ensureService(): Promise<void>;
      publicReady(): Promise<boolean>;
      repair(restartTunnel: boolean): Promise<string>;
      publish(value: DesktopOnlineState): void;
      now?: () => number;
    },
  ) {}

  async tick(): Promise<void> {
    const d = this.dependencies;
    if (d.paused()) {
      d.publish({ state: 'paused', code: 'STOPPED' });
      return;
    }
    let status: DesktopLocalStatus;
    try {
      status = await d.status();
    } catch {
      d.publish({ state: 'recovering', code: 'SERVICE_STARTING' });
      await d.ensureService();
      return;
    }
    if (status.activeSession) {
      d.publish({ state: 'call_active', code: 'CALL_IN_PROGRESS' });
      return;
    }
    if (status.connectionMaintenance) {
      d.publish({ state: 'recovering', code: 'CONNECTION_MAINTENANCE_BUSY' });
      return;
    }
    if (!status.configured) {
      d.publish({ state: 'offline', code: 'CONFIGURATION_REQUIRED' });
      return;
    }
    if (status.publicUrl !== this.probedUrl) {
      // DNS/edge propagation for a new address gets its own reconnect budget.
      this.probedUrl = status.publicUrl;
      this.publicFailures = 0;
    }
    const ready = await d.publicReady();
    this.publicFailures = ready ? 0 : this.publicFailures + 1;
    const now = (d.now || Date.now)();
    if (
      ready &&
      status.verified &&
      status.publicUrl === this.lastUrl &&
      now - this.lastRepair < 3600000
    ) {
      d.publish({ state: 'ready', code: 'CONNECTED' });
      return;
    }
    // Let cloudflared's own reconnect run first. Do not churn a healthy address.
    if (!ready && this.lastUrl && this.publicFailures < 3) {
      d.publish({ state: 'recovering', code: 'PUBLIC_CALLBACK_UNREACHABLE' });
      return;
    }
    if (d.paused()) {
      d.publish({ state: 'paused', code: 'STOPPED' });
      return;
    }
    d.publish({ state: 'recovering', code: 'CHECKING' });
    try {
      this.lastUrl = await d.repair(this.publicFailures >= 3);
      this.lastRepair = (d.now || Date.now)();
      this.publicFailures = 0;
      d.publish({ state: 'ready', code: 'CONNECTED' });
    } catch (error) {
      const codes = [
        'CONFIGURATION_REQUIRED',
        'EXTERNAL_CALL_ACTIVE',
        'PROVIDER_CHECK_FAILED',
        'ROUTING_FAILED',
        'CONNECTION_MAINTENANCE_BUSY',
        'PUBLIC_CALLBACK_UNREACHABLE',
      ];
      const code =
        error instanceof Error && codes.includes(error.message)
          ? error.message
          : 'RECOVERY_FAILED';
      d.publish({ state: 'recovering', code });
    }
  }
}
