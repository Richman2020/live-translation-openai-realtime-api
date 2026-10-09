import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

import {
  CloudAccessError,
  type CloudAccessContext,
  type CloudAccessPolicy,
} from './cloud-access';
import type { CallView, SessionManager } from './session-manager';

type PhoneEvent = { event: string; data: unknown };
export type OwnedPhoneStreamAccess = {
  policy: Pick<CloudAccessPolicy, 'revalidate' | 'runAuthorizedSession'>;
  ownedActive(context: CloudAccessContext): CallView | null;
  runAuthorizedEvent(
    context: CloudAccessContext,
    event: PhoneEvent,
    commit: () => void,
  ): boolean;
};
type StreamTransport = {
  sessionStreamGuard(
    action: 'read',
  ): (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
  requestContext(request: FastifyRequest): CloudAccessContext;
};

const VARY = [
  'Origin',
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-Dest',
  'Cookie',
];

/** Explicitly injected owner SSE. No login, public listener, provider or replay. */
export function createOwnedPhoneEventStreams(options: {
  access: OwnedPhoneStreamAccess;
  transport: StreamTransport;
  manager: Pick<SessionManager, 'on' | 'off'>;
  maxStreams?: number;
  maxStreamsPerSession?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  revalidationIntervalMs?: number;
  heartbeatIntervalMs?: number;
}) {
  const {
    access,
    transport,
    manager,
    maxStreams = 16,
    maxStreamsPerSession = 2,
    maxFrameBytes = 64 * 1024,
    maxBufferedBytes = 256 * 1024,
    revalidationIntervalMs = 1000,
    heartbeatIntervalMs = 20000,
  } = options;
  if (
    ![
      maxStreams,
      maxStreamsPerSession,
      maxFrameBytes,
      maxBufferedBytes,
      revalidationIntervalMs,
      heartbeatIntervalMs,
    ].every(Number.isSafeInteger) ||
    maxStreams < 1 ||
    maxStreams > 16 ||
    maxStreamsPerSession < 1 ||
    maxStreamsPerSession > 2 ||
    maxStreamsPerSession > maxStreams ||
    maxFrameBytes < 1 ||
    maxFrameBytes > 64 * 1024 ||
    maxBufferedBytes < maxFrameBytes ||
    maxBufferedBytes > 256 * 1024 ||
    revalidationIntervalMs < 10 ||
    revalidationIntervalMs > 1000 ||
    heartbeatIntervalMs < 10 ||
    heartbeatIntervalMs > 20000
  )
    throw new Error('INVALID_OWNED_STREAM_OPTIONS');
  const streams = new Map<() => void, string>();
  let stopped = false;
  const guard = transport.sessionStreamGuard('read');

  function handler(request: FastifyRequest, reply: FastifyReply) {
    let context: CloudAccessContext;
    let snapshot: CallView | null;
    let snapshotFrame: string;
    try {
      if (stopped)
        return reply.code(503).send({ error: 'EVENT_STREAMS_CLOSED' });
      context = transport.requestContext(request);
      snapshot = access.ownedActive(context);
      snapshotFrame = `event: snapshot\ndata: ${JSON.stringify({ activeSession: snapshot })}\n\n`;
      access.policy.revalidate(context, 'read');
    } catch (error) {
      const known = error instanceof CloudAccessError;
      return reply.code(known ? error.statusCode : 503).send({
        error: known ? error.code : 'EVENT_STREAM_UNAVAILABLE',
      });
    }
    const sessionKey = JSON.stringify([
      context.authSessionId,
      context.principalId,
      context.browserOwnerId,
      context.epoch,
    ]);
    if (
      streams.size >= maxStreams ||
      [...streams.values()].filter((key) => key === sessionKey).length >=
        maxStreamsPerSession
    )
      return reply.code(429).send({ error: 'TOO_MANY_EVENT_CONNECTIONS' });
    if (Buffer.byteLength(snapshotFrame) > maxFrameBytes)
      return reply.code(503).send({ error: 'EVENT_FRAME_TOO_LARGE' });

    const output: ServerResponse = reply.raw;
    let disposed = false;
    let subscribed = false;
    let close: () => void;
    let onEvent: (event: PhoneEvent) => void;
    let revalidationTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    function dispose(destroy = false) {
      if (disposed) return;
      disposed = true;
      clearInterval(revalidationTimer);
      clearInterval(heartbeatTimer);
      if (subscribed) manager.off('event', onEvent);
      streams.delete(close);
      request.raw.off('aborted', close);
      output.off('close', close);
      output.off('error', close);
      if (!output.destroyed && !output.writableEnded) {
        if (destroy) output.destroy();
        else output.end();
      }
    }
    close = () => {
      dispose();
    };
    function write(frame: string) {
      if (disposed) return;
      const bytes = Buffer.byteLength(frame);
      if (
        output.destroyed ||
        output.writableEnded ||
        bytes > maxFrameBytes ||
        output.writableLength + bytes > maxBufferedBytes
      ) {
        dispose(true);
        return;
      }
      output.write(frame);
    }
    onEvent = (event: PhoneEvent) => {
      if (disposed) return;
      try {
        // Authorize before serialization, then again immediately before write.
        // Never infer an event's owner from the manager's current active call.
        access.runAuthorizedEvent(context, event, () => {
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(event.event)) return;
          const frame = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
          access.policy.runAuthorizedSession(context, 'read', () => {
            access.runAuthorizedEvent(context, event, () => write(frame));
          });
        });
      } catch (error) {
        if (!(error instanceof CloudAccessError) || error.statusCode !== 404)
          dispose(true);
      }
    };
    try {
      access.policy.runAuthorizedSession(context, 'read', () => {
        const start = () => {
          const previousVary = String(reply.getHeader('vary') || '').split(',');
          const vary = new Map(
            [...previousVary, ...VARY].map((field) => [
              field.trim().toLowerCase(),
              field.trim(),
            ]),
          );
          vary.delete('');
          const inheritedHeaders: OutgoingHttpHeaders = Object.fromEntries(
            Object.entries(reply.getHeaders()).map(([key, value]) => [
              key.toLowerCase(),
              typeof value === 'number' ? String(value) : value,
            ]),
          );
          reply.hijack();
          output.writeHead(200, {
            ...inheritedHeaders,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'private, no-store',
            vary: [...vary.values()].join(', '),
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          });
          streams.set(close, sessionKey);
          output.once('close', close);
          output.once('error', close);
          request.raw.once('aborted', close);
          manager.on('event', onEvent);
          subscribed = true;
          write(snapshotFrame);
        };
        if (snapshot) {
          if (
            !access.runAuthorizedEvent(
              context,
              { event: 'call', data: snapshot },
              start,
            )
          )
            throw new CloudAccessError('NOT_FOUND');
        } else start();
      });
      if (!disposed) {
        revalidationTimer = setInterval(() => {
          try {
            access.policy.revalidate(context, 'read');
          } catch {
            dispose(true);
          }
        }, revalidationIntervalMs);
        heartbeatTimer = setInterval(() => {
          try {
            access.policy.runAuthorizedSession(context, 'read', () =>
              write(': keepalive\n\n'),
            );
          } catch {
            dispose(true);
          }
        }, heartbeatIntervalMs);
        revalidationTimer.unref();
        heartbeatTimer.unref();
      }
    } catch (error) {
      if (reply.sent || reply.raw.headersSent) dispose(true);
      else {
        const known = error instanceof CloudAccessError;
        return reply.code(known ? error.statusCode : 503).send({
          error: known ? error.code : 'EVENT_STREAM_UNAVAILABLE',
        });
      }
    }
    return undefined;
  }
  return {
    guard,
    handler,
    close() {
      stopped = true;
      for (const close of streams.keys()) close();
    },
  };
}
