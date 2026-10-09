// eslint-disable-next-line max-classes-per-file -- Keep the typed public error with its session manager.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import twilio from 'twilio';
import RequestClient from 'twilio/lib/base/RequestClient';

import type { SoloConfig } from './config';
import { safeEqual } from './security';
import { ConversationEventAdapter } from './conversation-events';
import { TranslationBridge } from './translation-bridge';
import {
  ContinuousTranslationBridge,
  type LocalVoiceSynthesizer,
} from './continuous-translation-bridge';
import { getNanoVoiceWorker, getNanoCaptionVoice } from './nano-runtime';
import { getPocketVoiceWorker } from './pocket-runtime';
import {
  isTranslationEngine,
  usesRemoteCaptions,
  usesNanoVoice,
  usesPocketVoice,
  type TranslationEngine,
} from './translation-engine';

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
  translationEngine: TranslationEngine;
  translationReady: boolean;
  captionState?: 'connecting' | 'ready' | 'failed';
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
export type BridgeOptions = ConstructorParameters<
  typeof TranslationBridge
>[0] & {
  translationEngine?: TranslationEngine;
};
/** Trusted server integration only; never constructed from browser fields. */
export type OutboundCallAdmission = {
  browserIdentity: string;
  beforePublish: (id: string) => void;
  authorizeCurrent: () => void;
};

/** Route capabilities independently: captions never imply a local voice model. */
export function createSessionBridge(
  settings: BridgeOptions,
  voices: {
    nano: () => LocalVoiceSynthesizer;
    nanoCaption: () => LocalVoiceSynthesizer;
    pocket?: () => LocalVoiceSynthesizer;
  } = {
    nano: getNanoVoiceWorker,
    nanoCaption: getNanoCaptionVoice,
    pocket: getPocketVoiceWorker,
  },
): BridgeLike {
  if (usesRemoteCaptions(settings.translationEngine)) {
    let localVoice: LocalVoiceSynthesizer | undefined;
    if (usesNanoVoice(settings.translationEngine))
      localVoice = voices.nanoCaption();
    if (usesPocketVoice(settings.translationEngine))
      localVoice = (voices.pocket || getPocketVoiceWorker)();
    return new ContinuousTranslationBridge({
      ...settings,
      remoteCaptions: true,
      outgoingPrefixes: settings.translationEngine === 'pocket-prefix',
      ...(localVoice ? { localVoice } : {}),
    });
  }
  if (settings.translationEngine === 'continuous-nano')
    return new ContinuousTranslationBridge({
      ...settings,
      localVoice: voices.nano(),
    });
  if (settings.translationEngine === 'continuous')
    return new ContinuousTranslationBridge(settings);
  return new TranslationBridge(settings);
}
type Session = {
  browserIdentity: string;
  admission?: Readonly<OutboundCallAdmission>;
  conversation: ConversationEventAdapter;
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
  readyRoles: Set<Role>;
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

  private readonly explicitControlDependencies: boolean;

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
    this.explicitControlDependencies =
      typeof options.providerFactory === 'function' &&
      typeof options.bridgeFactory === 'function';
    this.now = options.now || Date.now;
    this.providerFactory = options.providerFactory || twilioProvider;
    this.bridgeFactory = options.bridgeFactory || createSessionBridge;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 75000;
    this.maxCallMs = options.maxCallMs ?? 60 * 60 * 1000;
  }

  get hasExplicitControlDependencies(): boolean {
    return this.explicitControlDependencies;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  get activeSession(): CallView | null {
    const session = this.activeId && this.sessions.get(this.activeId);
    return session ? { ...session.view } : null;
  }

  setPresence(available: boolean): void {
    // A finite two-minute lease tolerates delayed background-window heartbeats.
    this.availableUntil = available ? this.now() + 120000 : 0;
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
    translationEngine: TranslationEngine = 'legacy',
    admission?: OutboundCallAdmission,
  ): Session {
    if (this.closing) throw new SessionError('SHUTTING_DOWN', 503);
    if (this.activeId) throw new SessionError('BUSY', 409);
    if (this.cleanupUnconfirmed)
      throw new SessionError('CALL_CLEANUP_UNCONFIRMED', 409);
    const id = randomUUID();
    let trusted: Readonly<OutboundCallAdmission> | undefined;
    if (admission) {
      if (
        typeof admission.browserIdentity !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(admission.browserIdentity) ||
        typeof admission.beforePublish !== 'function' ||
        typeof admission.authorizeCurrent !== 'function'
      )
        throw new SessionError('INVALID_CALL_ADMISSION');
      trusted = Object.freeze({ ...admission });
      trusted.authorizeCurrent();
      trusted.beforePublish(id);
    }
    const session: Session = {
      browserIdentity: trusted?.browserIdentity || 'ai-phone',
      ...(trusted ? { admission: trusted } : {}),
      conversation: new ConversationEventAdapter(id, this.now),
      view: {
        id,
        direction,
        status: 'connecting',
        to,
        from,
        translationEngine,
        translationReady: false,
        ...(usesRemoteCaptions(translationEngine)
          ? { captionState: 'connecting' as const }
          : {}),
      },
      readyRoles: new Set(),
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
    translationEngine: TranslationEngine = 'legacy',
    admission?: OutboundCallAdmission,
  ): CallView & { connectionParams: { sessionId: string; nonce: string } } {
    if (!isTranslationEngine(translationEngine))
      throw new SessionError('INVALID_TRANSLATION_ENGINE');
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
      translationEngine,
      admission,
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
      fields.From !== `client:${session.browserIdentity}`
    )
      throw new SessionError('INVALID_BROWSER_CALL', 403);
    this.bindCall(session, 'local', fields.CallSid);
    if (!this.admissionCurrent(session))
      this.beginEndIntent(session.view.id, 'CALL_AUTHORIZATION_REVOKED');
    if (session.ended)
      this.track(
        this.end(session.view.id).then(() =>
          this.terminateLeg(session, fields.CallSid),
        ),
      );
    return this.streamTwiml(session, 'local');
  }

  connectLeg(id: string, role: Role, nonce: string, sid: string): string {
    const session = this.getAuthorized(id, role, nonce);
    if (!session.attempted.has(role) && !session.callSids[role])
      throw new SessionError('UNEXPECTED_CALL_LEG', 403);
    this.bindCall(session, role, sid);
    session.uncertainRoles.delete(role);
    if (!this.admissionCurrent(session))
      this.beginEndIntent(session.view.id, 'CALL_AUTHORIZATION_REVOKED');
    if (session.ended) {
      this.track(
        this.end(session.view.id).then(() => this.terminateLeg(session, sid)),
      );
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
    if (session.ended && !session.confirmedTerminal.has(sid))
      session.pendingCleanup.add(sid);
  }

  private admissionCurrent(session: Session): boolean {
    if (!session.admission) return true;
    try {
      session.admission.authorizeCurrent();
      return true;
    } catch {
      return false;
    }
  }

  /** Only protected calls receive this facade; local bridges keep their socket.
   * Check both engine input and every write. Revocation cannot retract network
   * bytes already sent or audio already heard; only a strict clear may pass to
   * drain the previously authenticated destination during cleanup.
   */
  private protectMediaSocket(
    session: Session,
    socket: WebSocket,
    streamSid: string,
  ): WebSocket {
    if (!session.admission) return socket;
    type Listener = (...args: unknown[]) => void;
    const listeners: {
      original: Listener;
      wrapped: Listener;
    }[] = [];
    const methods = new Map<PropertyKey, unknown>();
    const subscribe = new Set([
      'on',
      'addListener',
      'once',
      'prependListener',
      'prependOnceListener',
    ]);
    const isClear = (data: unknown): boolean => {
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return false;
      if (data.length > 256) return false;
      try {
        const packet = JSON.parse(data.toString()) as Record<string, unknown>;
        return (
          !!packet &&
          !Array.isArray(packet) &&
          Object.keys(packet).length === 2 &&
          packet.event === 'clear' &&
          packet.streamSid === streamSid
        );
      } catch {
        return false;
      }
    };
    const revoke = () => {
      try {
        this.beginEndIntent(session.view.id, 'CALL_AUTHORIZATION_REVOKED');
      } finally {
        this.track(this.end(session.view.id));
      }
    };
    const protectedSocket: WebSocket = new Proxy(socket, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (methods.has(property)) return methods.get(property);
        let method: (...args: unknown[]) => unknown;
        if (property === 'send') {
          method = (...args) => {
            if (session.ended || !this.admissionCurrent(session)) {
              const cleanup = isClear(args[0]);
              try {
                if (!session.ended) revoke();
              } finally {
                if (!cleanup) {
                  const callback = args.at(-1);
                  if (typeof callback === 'function')
                    Reflect.apply(callback, undefined, [
                      new Error('CALL_AUTHORIZATION_REVOKED'),
                    ]);
                }
              }
              if (!cleanup) return undefined;
            }
            return Reflect.apply(value, target, args);
          };
        } else if (typeof property === 'string' && subscribe.has(property)) {
          method = (...args) => {
            if (args[0] === 'message' && typeof args[1] === 'function') {
              const original = args[1] as Listener;
              const once =
                property === 'once' || property === 'prependOnceListener';
              const wrapped: Listener = (...values) => {
                if (once) {
                  const index = listeners.findIndex(
                    (entry) => entry.wrapped === wrapped,
                  );
                  if (index >= 0) listeners.splice(index, 1);
                }
                if (session.ended) return;
                if (!this.admissionCurrent(session)) {
                  revoke();
                  return;
                }
                Reflect.apply(original, protectedSocket, values);
              };
              listeners.push({ original, wrapped });
              Reflect.apply(value, target, [args[0], wrapped]);
            } else Reflect.apply(value, target, args);
            return protectedSocket;
          };
        } else if (property === 'off' || property === 'removeListener') {
          method = (...args) => {
            if (args[0] === 'message' && typeof args[1] === 'function') {
              const index = listeners.findLastIndex(
                (entry) => entry.original === args[1],
              );
              if (index >= 0) {
                const [entry] = listeners.splice(index, 1);
                Reflect.apply(value, target, [args[0], entry.wrapped]);
                return protectedSocket;
              }
            }
            Reflect.apply(value, target, args);
            return protectedSocket;
          };
        } else {
          method = (...args) => {
            if (
              property === 'removeAllListeners' &&
              (!args.length || args[0] === 'message')
            )
              listeners.length = 0;
            const result: unknown = Reflect.apply(value, target, args);
            return result === target ? protectedSocket : result;
          };
        }
        methods.set(property, method);
        return method;
      },
    });
    return protectedSocket;
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
      if (!this.admissionCurrent(session)) {
        this.track(this.end(session.view.id, 'CALL_AUTHORIZATION_REVOKED'));
        throw new SessionError('CALL_AUTHORIZATION_REVOKED', 403);
      }
      session.sockets[role] = socket;
      const finish = () => {
        if (!session.ended) this.end(session.view.id);
      };
      socket.once('close', () => {
        if (!session.ended) this.end(session.view.id, 'PHONE_STREAM_CLOSED');
      });
      socket.once('error', () => {
        if (!session.ended) this.end(session.view.id, 'PHONE_STREAM_ERROR');
      });
      socket.on('message', (data) => {
        try {
          if (JSON.parse(data.toString())?.event === 'stop') finish();
        } catch {
          if (!session.ended)
            this.end(session.view.id, 'INVALID_MEDIA_MESSAGE');
        }
      });
      if (!session.bridge) {
        session.bridge = this.bridgeFactory({
          apiKey: session.config.OPENAI_API_KEY,
          model: session.config.OPENAI_REALTIME_MODEL,
          transcriptionModel: session.config.OPENAI_TRANSCRIPTION_MODEL,
          proxyUrl: session.config.OPENAI_PROXY_URL,
          translationEngine: session.view.translationEngine,
          onTranscript: (transcript) => {
            if (!session.ended) {
              this.emit('event', {
                event: 'transcript',
                data: {
                  ...transcript,
                  sessionId: session.view.id,
                  ...(session.view.translationEngine === 'pocket-prefix' &&
                  transcript.role === 'local'
                    ? { conversationVisible: false }
                    : {}),
                },
              });
              // Prefix source turns and translated clauses have different IDs.
              // Its explicit segment callback supplies their true correspondence.
              if (
                !(
                  session.view.translationEngine === 'pocket-prefix' &&
                  transcript.role === 'local'
                )
              ) {
                const event = session.conversation.transcript(transcript);
                if (event)
                  this.emit('event', { event: 'conversation', data: event });
              }
            }
          },
          onConversationTranscript: (transcript) => {
            if (session.ended) return;
            const event = session.conversation.transcript(transcript);
            if (event)
              this.emit('event', { event: 'conversation', data: event });
          },
          onUtterancePlayback: (playback) => {
            if (session.ended && playback.status !== 'cancelled') return;
            const event = session.conversation.playback(playback);
            if (event)
              this.emit('event', { event: 'conversation', data: event });
          },
          onFailure: (reason) => {
            if (!session.ended) this.end(session.view.id, reason);
          },
          onConnection: (connection) => {
            if (!session.ended) {
              if (connection.state === 'ready')
                session.readyRoles.add(connection.role);
              else session.readyRoles.delete(connection.role);
              const translationReady = usesRemoteCaptions(
                session.view.translationEngine,
              )
                ? session.readyRoles.has('local')
                : session.readyRoles.size === 2;
              if (session.view.translationReady !== translationReady) {
                session.view.translationReady = translationReady;
                this.publish(session);
              }
              this.emit('event', {
                event: 'translation-connection',
                data: { ...connection, sessionId: session.view.id },
              });
            }
          },
          onCaptionState: (caption) => {
            if (
              session.ended ||
              !usesRemoteCaptions(session.view.translationEngine)
            )
              return;
            session.view.captionState = caption.state;
            this.publish(session);
            this.emit('event', {
              event: 'caption-status',
              data: { state: caption.state, sessionId: session.view.id },
            });
          },
          onAudioDiagnostic: (audio) => {
            // Keep final unconfirmed playback reports when a call is closing.
            this.emit('event', {
              event: 'translation-audio',
              data: { ...audio, sessionId: session.view.id },
            });
            if (session.ended && audio.stage !== 'unconfirmed') return;
            const event = session.conversation.audio(audio);
            if (event)
              this.emit('event', { event: 'conversation', data: event });
          },
          onCaptionInputDiagnostic: (diagnostic) => {
            if (!session.ended)
              this.emit('event', {
                event: 'caption-input',
                data: { ...diagnostic, sessionId: session.view.id },
              });
          },
          onProviderDiagnostic: (diagnostic) => {
            if (!session.ended)
              this.emit('event', {
                event: 'translation-provider',
                data: { ...diagnostic, sessionId: session.view.id },
              });
          },
          onInputDiagnostic: (diagnostic) => {
            // Preserve the final partial input window during bridge cleanup.
            this.emit('event', {
              event: 'translation-input',
              data: { ...diagnostic, sessionId: session.view.id },
            });
          },
          onMetric: (metric) => {
            if (!session.ended)
              this.emit('event', {
                event: 'translation-metric',
                data: { ...metric, sessionId: session.view.id },
              });
          },
        });
      }
      session.bridge.attach(
        role,
        this.protectMediaSocket(session, socket, start.streamSid),
        start.streamSid,
      );
      if (session.ended) return true;
      if (session.sockets.local && session.sockets.remote) {
        clearTimeout(session.timer);
        session.view.status = 'active';
        this.publish(session);
        session.timer = setTimeout(
          () => {
            this.end(session.view.id, 'CALL_DURATION_LIMIT');
          },
          usesPocketVoice(session.view.translationEngine)
            ? Math.min(this.maxCallMs, 5 * 60 * 1000)
            : this.maxCallMs,
        );
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
    session.view.status = 'ringing';
    this.publish(session);
    // Admission errors are not provider failures and cannot make a not-yet
    // submitted leg uncertain. Check immediately before the create attempt.
    if (session.ended || !this.admissionCurrent(session)) {
      session.dialing.delete(role);
      await this.end(session.view.id, 'CALL_AUTHORIZATION_REVOKED');
      return;
    }
    session.attempted.add(role);
    try {
      const created = await session.provider.create({
        to:
          role === 'local'
            ? `client:${session.browserIdentity}`
            : session.view.to,
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
      if (!this.admissionCurrent(session))
        this.beginEndIntent(session.view.id, 'CALL_AUTHORIZATION_REVOKED');
      if (session.ended) {
        await this.end(session.view.id);
        // A concurrent end may have taken its SID snapshot before this create
        // returned. Still terminate this verified late leg after that drain.
        await this.terminateLeg(session, created.sid);
      }
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
    if (!this.admissionCurrent(session))
      this.beginEndIntent(session.view.id, 'CALL_AUTHORIZATION_REVOKED');
    // A create request can time out after Twilio accepted it. Its signed callback
    // supplies the otherwise unknown SID so the late call is still terminated.
    if (session.ended) {
      this.track(
        this.end(session.view.id).then(() =>
          this.terminateLeg(session, fields.CallSid),
        ),
      );
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

  /** Accept a termination synchronously; provider cleanup belongs to end(). */
  beginEndIntent(id: string, error?: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('SESSION_NOT_FOUND', 404);
    if (session.ended) return;
    session.ended = true;
    session.view.translationReady = false;
    session.readyRoles.clear();
    clearTimeout(session.timer);
    session.view.status = 'ending';
    if (error) session.view.error = error;
    for (const sid of Object.values(session.callSids)) {
      if (!session.confirmedTerminal.has(sid)) session.pendingCleanup.add(sid);
    }
    session.view.cleanupUnconfirmed = this.cleanupRequired(session);
    try {
      this.publish(session);
    } finally {
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
    }
  }

  async end(id: string, error?: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('SESSION_NOT_FOUND', 404);
    if (session.ending) return session.ending;
    this.beginEndIntent(id, error);
    // Publish the shared task before any async provider work can re-enter end.
    const ending = Promise.resolve().then(async () => {
      await Promise.all(
        [...session.pendingCleanup].map((sid) =>
          this.terminateLeg(session, sid),
        ),
      );
      this.settleEnded(session);
    });
    session.ending = ending;
    try {
      await ending;
    } finally {
      if (session.ending === ending) session.ending = undefined;
    }
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
