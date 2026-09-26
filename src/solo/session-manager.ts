// eslint-disable-next-line max-classes-per-file -- Keep the typed public error with its session manager.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient';

import type { SoloConfig } from './config';
import { safeEqual } from './security';
import { TranslationBridge } from './translation-bridge';

export type Role = 'local' | 'remote';
export type CallView = {
  id: string;
  direction: 'inbound' | 'outbound';
  status:
    | 'connecting'
    | 'ringing'
    | 'active'
    | 'ending'
    | 'completed'
    | 'failed';
  to: string;
  from: string;
  error?: string;
  providerErrorCode?: number;
  providerHttpStatus?: number;
  cleanupUnconfirmed?: boolean;
};
export type CallProvider = {
  create(options: Record<string, unknown>): Promise<{ sid: string }>;
  hangup(sid: string): Promise<void>;
};
export type BridgeLike = {
  attach(role: Role, socket: WebSocket, streamSid: string): void;
  close(): void;
};
export type BridgeOptions = ConstructorParameters<typeof TranslationBridge>[0];
type Session = {
  view: CallView;
  config: SoloConfig;
  nonces: Record<Role, string>;
  callSids: Partial<Record<Role, string>>;
  sockets: Partial<Record<Role, WebSocket>>;
  dialing: Set<Role>;
  attempted: Set<Role>;
  pendingCleanup: Set<string>;
  confirmedTerminal: Set<string>;
  uncertainRoles: Set<Role>;
  cleanupTasks: Map<string, Promise<void>>;
  bridge?: BridgeLike;
  timer?: ReturnType<typeof setTimeout>;
  ended: boolean;
  ending?: Promise<void>;
  provider: CallProvider;
};
export class SessionError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
  ) {
    super(code);
  }
}
const callSidValid = (sid: string) => /^CA[0-9a-f]{32}$/i.test(sid || '');
const terminal = new Set([
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);

export async function terminateCall(call: {
  fetch(): Promise<{ status: string }>;
  update(options: { status: 'canceled' | 'completed' }): Promise<unknown>;
}): Promise<void> {
  let lastError: unknown;
  // A ringing call may be answered between fetch and update. Re-read once and
  // use the correct terminal transition; never retry call creation itself.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Re-read after each failed transition to handle an answered call.
    const state = await call.fetch();
    if (terminal.has(state.status)) return;
    try {
      // eslint-disable-next-line no-await-in-loop -- This update depends on the latest fetched state.
      await call.update({
        status: ['queued', 'ringing', 'initiated'].includes(state.status)
          ? 'canceled'
          : 'completed',
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if (terminal.has((await call.fetch()).status)) return;
  throw lastError;
}

export function twilioProvider(config: SoloConfig): CallProvider {
  const client = twilio(
    config.TWILIO_API_KEY_SID,
    config.TWILIO_API_KEY_SECRET,
    {
      accountSid: config.TWILIO_ACCOUNT_SID,
      httpClient: new RequestClient({ timeout: 15000, autoRetry: false }),
      autoRetry: false,
    },
  );
  return {
    create: async (options) => client.calls.create(options as any),
    hangup: async (sid) => terminateCall(client.calls(sid)),
  };
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  private activeId: string | null = null;

  private availableUntil = 0;

  private closing = false;

  private backgroundTasks = new Set<Promise<void>>();

  private readonly now: () => number;

  private readonly providerFactory: (config: SoloConfig) => CallProvider;

  private readonly bridgeFactory: (options: BridgeOptions) => BridgeLike;

  private readonly setupTimeoutMs: number;

  private readonly maxCallMs: number;

  constructor(
    options: {
      providerFactory?: (config: SoloConfig) => CallProvider;
      bridgeFactory?: (options: BridgeOptions) => BridgeLike;
      now?: () => number;
      setupTimeoutMs?: number;
      maxCallMs?: number;
    } = {},
  ) {
    super();
    this.now = options.now || Date.now;
    this.providerFactory = options.providerFactory || twilioProvider;
    this.bridgeFactory =
      options.bridgeFactory || ((settings) => new TranslationBridge(settings));
    this.setupTimeoutMs = options.setupTimeoutMs ?? 75000;
    this.maxCallMs = options.maxCallMs ?? 60 * 60 * 1000;
  }

  get activeSession(): CallView | null {
    const session = this.activeId && this.sessions.get(this.activeId);
    return session ? { ...session.view } : null;
  }

  setPresence(available: boolean): void {
    this.availableUntil = available ? this.now() + 45000 : 0;
  }

  get available(): boolean {
    return !this.closing && this.availableUntil > this.now();
  }

  private track(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    );
  }

  private get cleanupUnconfirmed(): boolean {
    return [...this.sessions.values()].some(
      (session) => session.pendingCleanup.size || session.uncertainRoles.size,
    );
  }

  isCleanupConfirmed(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.ended && !this.cleanupRequired(session);
  }

  private cleanupRequired(session: Session): boolean {
    return !!(
      session.pendingCleanup.size ||
      session.uncertainRoles.size ||
      session.dialing.size
    );
  }

  private settleEnded(session: Session): void {
    if (!session.ended) return;
    const unconfirmed = this.cleanupRequired(session);
    session.view.cleanupUnconfirmed = unconfirmed;
    if (unconfirmed) session.view.status = 'ending';
    else session.view.status = session.view.error ? 'failed' : 'completed';
    if (!unconfirmed && this.activeId === session.view.id) this.activeId = null;
    this.publish(session);
  }

  private publish(session: Session): void {
    this.emit('event', { event: 'call', data: { ...session.view } });
  }

  private make(
    config: SoloConfig,
    direction: CallView['direction'],
    to: string,
    from: string,
  ): Session {
    if (this.closing) throw new SessionError('SHUTTING_DOWN', 503);
    if (this.activeId) throw new SessionError('BUSY', 409);
    if (this.cleanupUnconfirmed)
      throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 409);
    const id = randomUUID();
    const session: Session = {
      view: { id, direction, status: 'connecting', to, from },
      config: { ...config },
      nonces: {
        local: randomBytes(24).toString('hex'),
        remote: randomBytes(24).toString('hex'),
      },
      callSids: {},
      sockets: {},
      dialing: new Set(),
      attempted: new Set(),
      pendingCleanup: new Set(),
      confirmedTerminal: new Set(),
      uncertainRoles: new Set(),
      cleanupTasks: new Map(),
      ended: false,
      provider: this.providerFactory(config),
    };
    this.sessions.set(id, session);
    this.activeId = id;
    session.timer = setTimeout(() => {
      this.end(id, 'CALL_SETUP_TIMEOUT');
    }, this.setupTimeoutMs);
    session.timer.unref?.();
    // Keep a bounded set of ended sessions to handle repeated provider callbacks.
    for (const [key, old] of this.sessions) {
      if (this.sessions.size <= 100) break;
      if (
        old.ended &&
        !old.ending &&
        !old.pendingCleanup.size &&
        !old.uncertainRoles.size &&
        !old.dialing.size
      )
        this.sessions.delete(key);
    }
    this.publish(session);
    return session;
  }

  createOutbound(
    config: SoloConfig,
    to: string,
  ): CallView & { connectionParams: { sessionId: string; nonce: string } } {
    if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(to))
      throw new SessionError('INVALID_DESTINATION');
    if (to === config.TWILIO_CALLER_NUMBER)
      throw new SessionError('CANNOT_DIAL_OWN_NUMBER');
    if (!this.available) throw new SessionError('BROWSER_NOT_READY', 409);
    const session = this.make(
      config,
      'outbound',
      to,
      config.TWILIO_CALLER_NUMBER,
    );
    return {
      ...session.view,
      connectionParams: {
        sessionId: session.view.id,
        nonce: session.nonces.local,
      },
    };
  }

  acceptIncoming(config: SoloConfig, fields: Record<string, string>): string {
    const existing = [...this.sessions.values()].find(
      (session) =>
        session.callSids.remote === fields.CallSid &&
        session.view.direction === 'inbound',
    );
    if (existing)
      return existing.ended
        ? this.rejectTwiml(false)
        : this.streamTwiml(existing, 'remote');
    if (
      !callSidValid(fields.CallSid) ||
      fields.To !== config.TWILIO_CALLER_NUMBER
    )
      throw new SessionError('INVALID_INBOUND_CALL', 403);
    if (!this.available || this.activeId || this.cleanupUnconfirmed)
      return this.rejectTwiml(true);
    const session = this.make(
      config,
      'inbound',
      fields.To,
      fields.From || 'unknown',
    );
    session.callSids.remote = fields.CallSid;
    return this.streamTwiml(session, 'remote');
  }

  connectBrowser(fields: Record<string, string>): string {
    const session = this.getAuthorized(fields.sessionId, 'local', fields.nonce);
    if (
      session.view.direction !== 'outbound' ||
      fields.From !== 'client:ai-phone'
    )
      throw new SessionError('INVALID_BROWSER_CALL', 403);
    this.bindCall(session, 'local', fields.CallSid);
    if (session.ended) this.track(this.terminateLeg(session, fields.CallSid));
    return this.streamTwiml(session, 'local');
  }

  connectLeg(id: string, role: Role, nonce: string, sid: string): string {
    const session = this.getAuthorized(id, role, nonce);
    if (!session.attempted.has(role) && !session.callSids[role])
      throw new SessionError('UNEXPECTED_CALL_LEG', 403);
    this.bindCall(session, role, sid);
    session.uncertainRoles.delete(role);
    if (session.ended) {
      this.track(this.terminateLeg(session, sid));
      return this.rejectTwiml(false);
    }
    return this.streamTwiml(session, role);
  }

  private bindCall(session: Session, role: Role, sid: string): void {
    if (
      !callSidValid(sid) ||
      (session.callSids[role] && session.callSids[role] !== sid)
    )
      throw new SessionError('CALL_SID_MISMATCH', 403);
    session.callSids[role] = sid;
  }

  private getAuthorized(id: string, role: Role, nonce: string): Session {
    const session = this.sessions.get(id);
    if (
      !session ||
      !['local', 'remote'].includes(role) ||
      !safeEqual(nonce || '', session.nonces[role])
    )
      throw new SessionError('INVALID_SESSION', 403);
    return session;
  }

  private callbackUrl(session: Session, role: Role, path: string): string {
    const params = new URLSearchParams({
      sessionId: session.view.id,
      role,
      nonce: session.nonces[role],
    });
    return `${session.config.PUBLIC_BASE_URL}${path}?${params}`;
  }

  private streamTwiml(session: Session, role: Role): string {
    if (session.ended) return this.rejectTwiml(false);
    const response = new twilio.twiml.VoiceResponse();
    const stream = response.connect().stream({
      url: `${session.config.PUBLIC_BASE_URL.replace(/^https:/, 'wss:')}/voice/media`,
      statusCallback: this.callbackUrl(session, role, '/voice/stream-status'),
      statusCallbackMethod: 'POST',
    });
    stream.parameter({ name: 'sessionId', value: session.view.id });
    stream.parameter({ name: 'role', value: role });
    stream.parameter({ name: 'nonce', value: session.nonces[role] });
    response.hangup();
    return response.toString();
  }

  private rejectTwiml(busy: boolean): string {
    const response = new twilio.twiml.VoiceResponse();
    if (busy) response.reject({ reason: 'busy' });
    else response.hangup();
    return response.toString();
  }

  attachMedia(socket: WebSocket, start: any): boolean {
    const params = start?.customParameters;
    let session: Session;
    try {
      session = this.getAuthorized(
        params?.sessionId,
        params?.role,
        params?.nonce,
      );
      const role = params.role as Role;
      if (
        session.ended ||
        start.accountSid !== session.config.TWILIO_ACCOUNT_SID ||
        !session.callSids[role] ||
        start.callSid !== session.callSids[role] ||
        !/^MZ[0-9a-f]{32}$/i.test(start.streamSid || '') ||
        session.sockets[role]
      )
        throw new SessionError('INVALID_MEDIA_STREAM', 403);
      if (
        !start.mediaFormat ||
        start.mediaFormat.encoding !== 'audio/x-mulaw' ||
        start.mediaFormat.sampleRate !== 8000 ||
        start.mediaFormat.channels !== 1
      )
        throw new SessionError('UNSUPPORTED_AUDIO_FORMAT');
      session.sockets[role] = socket;
      const finish = () => {
        this.end(session.view.id);
      };
      socket.once('close', () => {
        this.end(session.view.id, 'PHONE_STREAM_CLOSED');
      });
      socket.once('error', () => {
        this.end(session.view.id, 'PHONE_STREAM_ERROR');
      });
      socket.on('message', (data) => {
        try {
          if (JSON.parse(data.toString())?.event === 'stop') finish();
        } catch {
          this.end(session.view.id, 'INVALID_MEDIA_MESSAGE');
        }
      });
      if (!session.bridge) {
        session.bridge = this.bridgeFactory({
          apiKey: session.config.OPENAI_API_KEY,
          model: session.config.OPENAI_REALTIME_MODEL,
          proxyUrl: session.config.OPENAI_PROXY_URL,
          onTranscript: (transcript) => {
            if (!session.ended)
              this.emit('event', {
                event: 'transcript',
                data: { ...transcript, sessionId: session.view.id },
              });
          },
          onFailure: (reason) => {
            this.end(session.view.id, reason);
          },
          onConnection: (connection) => {
            if (!session.ended)
              this.emit('event', {
                event: 'translation-connection',
                data: { ...connection, sessionId: session.view.id },
              });
          },
        });
      }
      session.bridge.attach(role, socket, start.streamSid);
      if (session.ended) return true;
      if (session.sockets.local && session.sockets.remote) {
        clearTimeout(session.timer);
        session.view.status = 'active';
        this.publish(session);
        session.timer = setTimeout(() => {
          this.end(session.view.id, 'CALL_DURATION_LIMIT');
        }, this.maxCallMs);
        session.timer.unref?.();
      } else if (
        (session.view.direction === 'outbound' && role === 'local') ||
        (session.view.direction === 'inbound' && role === 'remote')
      ) {
        this.track(
          this.dialOther(session, role === 'local' ? 'remote' : 'local'),
        );
      }
      return true;
    } catch {
      socket.close(1008, 'Invalid stream');
      return false;
    }
  }

  private async dialOther(session: Session, role: Role): Promise<void> {
    if (session.ended || session.dialing.has(role) || session.callSids[role])
      return;
    session.dialing.add(role);
    session.attempted.add(role);
    session.view.status = 'ringing';
    this.publish(session);
    try {
      const created = await session.provider.create({
        to: role === 'local' ? 'client:ai-phone' : session.view.to,
        from: session.config.TWILIO_CALLER_NUMBER,
        url: this.callbackUrl(session, role, '/voice/connect'),
        method: 'POST',
        statusCallback: this.callbackUrl(session, role, '/voice/status'),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: 40,
      });
      this.bindCall(session, role, created.sid);
      session.uncertainRoles.delete(role);
      if (session.ended) await this.terminateLeg(session, created.sid);
    } catch (error) {
      const status = Number((error as { status?: number })?.status);
      // Only bounded numeric diagnostics may leave this process. SDK messages,
      // URLs, request options and stacks can contain credentials or phone data.
      const code = (error as { code?: unknown })?.code;
      if (
        typeof code === 'number' &&
        Number.isInteger(code) &&
        code > 0 &&
        code <= 999999
      )
        session.view.providerErrorCode = code;
      const providerStatus = (error as { status?: unknown })?.status;
      if (
        typeof providerStatus === 'number' &&
        Number.isInteger(providerStatus) &&
        providerStatus >= 400 &&
        providerStatus <= 599
      )
        session.view.providerHttpStatus = providerStatus;
      // A definitive 4xx rejects creation. Transport failures/5xx may have
      // accepted it: keep the callback nonce alive and refuse a safe shutdown
      // until a signed callback reveals and terminates that call.
      if (
        !session.callSids[role] &&
        !(status >= 400 && status < 500 && status !== 408)
      )
        session.uncertainRoles.add(role);
      await this.end(session.view.id, 'TWILIO_CALL_FAILED');
    } finally {
      session.dialing.delete(role);
      this.settleEnded(session);
    }
  }

  handleStatus(
    id: string,
    role: Role,
    nonce: string,
    fields: Record<string, string>,
    stream = false,
  ): void {
    const session = this.getAuthorized(id, role, nonce);
    const wasUnknown = !session.callSids[role];
    if (wasUnknown && session.attempted.has(role))
      this.bindCall(session, role, fields.CallSid);
    if (session.callSids[role] !== fields.CallSid)
      throw new SessionError('CALL_SID_MISMATCH', 403);
    session.uncertainRoles.delete(role);
    if (!stream && terminal.has(fields.CallStatus)) {
      session.confirmedTerminal.add(fields.CallSid);
      session.pendingCleanup.delete(fields.CallSid);
    }
    // A create request can time out after Twilio accepted it. Its signed callback
    // supplies the otherwise unknown SID so the late call is still terminated.
    if (session.ended) {
      if (!session.confirmedTerminal.has(fields.CallSid))
        this.track(this.terminateLeg(session, fields.CallSid));
      else this.settleEnded(session);
      return;
    }
    if (
      stream &&
      ['stream-error', 'stream-stopped'].includes(fields.StreamEvent)
    ) {
      this.end(
        id,
        fields.StreamEvent === 'stream-error'
          ? 'MEDIA_STREAM_FAILED'
          : undefined,
      );
      return;
    }
    if (terminal.has(fields.CallStatus)) {
      this.end(
        id,
        ['completed', 'canceled'].includes(fields.CallStatus)
          ? undefined
          : `CALL_${fields.CallStatus.toUpperCase().replace(/-/g, '_')}`,
      );
    }
  }

  private cleanupFailed(session: Session): void {
    session.view.error = 'CALL_CLEANUP_FAILED';
    this.settleEnded(session);
    this.emit('event', {
      event: 'error',
      data: {
        sessionId: session.view.id,
        error: 'CALL_CLEANUP_FAILED',
        message: '电话线路关闭未确认，请在 Twilio 控制台检查当前通话。',
      },
    });
  }

  private async terminateLeg(session: Session, sid: string): Promise<void> {
    if (session.confirmedTerminal.has(sid)) return undefined;
    if (session.cleanupTasks.has(sid)) return session.cleanupTasks.get(sid);
    session.pendingCleanup.add(sid);
    const task = (async () => {
      try {
        await session.provider.hangup(sid);
        session.pendingCleanup.delete(sid);
        session.confirmedTerminal.add(sid);
        this.settleEnded(session);
      } catch {
        this.cleanupFailed(session);
      }
    })();
    session.cleanupTasks.set(sid, task);
    await task;
    session.cleanupTasks.delete(sid);
    return undefined;
  }

  async end(id: string, error?: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('SESSION_NOT_FOUND', 404);
    if (session.ending) return session.ending;
    if (session.ended) {
      session.ending = Promise.all(
        [...session.pendingCleanup].map((sid) =>
          this.terminateLeg(session, sid),
        ),
      ).then(() => this.settleEnded(session));
      await session.ending;
      session.ending = undefined;
      return undefined;
    }
    session.ended = true;
    clearTimeout(session.timer);
    session.view.status = 'ending';
    if (error) session.view.error = error;
    this.publish(session);
    session.ending = (async () => {
      try {
        session.bridge?.close();
      } catch {
        /* Continue terminating all call legs. */
      }
      for (const socket of Object.values(session.sockets)) {
        try {
          socket.close();
        } catch {
          // Continue terminating the provider legs even if a socket is already closed.
        }
      }
      await Promise.all(
        Object.values(session.callSids).map((sid) =>
          this.terminateLeg(session, sid),
        ),
      );
      this.settleEnded(session);
    })();
    await session.ending;
    session.ending = undefined;
    return undefined;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.availableUntil = 0;
    if (this.activeId) await this.end(this.activeId);
    while (this.backgroundTasks.size)
      // eslint-disable-next-line no-await-in-loop -- Settling pending creates may enqueue more cleanup work.
      await Promise.all([...this.backgroundTasks]);
    // Retry known uncertain terminations once; a successful provider response or
    // signed terminal callback is required before reporting a safe shutdown.
    await Promise.all(
      [...this.sessions.values()].flatMap((session) =>
        [...session.pendingCleanup].map((sid) =>
          this.terminateLeg(session, sid),
        ),
      ),
    );
    if (this.cleanupUnconfirmed)
      throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 503);
  }
}
