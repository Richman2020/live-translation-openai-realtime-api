import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import twilio from 'twilio';

import type { SoloConfig } from './config';

export function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function isLocalRequest(req: FastifyRequest, port: string): boolean {
  const remote = req.raw.socket.remoteAddress || req.ip;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  if (
    req.headers.forwarded ||
    req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['x-forwarded-proto']
  )
    return false;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return allowed.includes((req.headers.host || '').toLowerCase());
}
export function sameOrigin(req: FastifyRequest): boolean {
  const { origin } = req.headers;
  return !origin || origin === `http://${req.headers.host}`;
}
export function validLocalToken(
  req: FastifyRequest,
  config: SoloConfig,
): boolean {
  const auth = req.headers.authorization;
  let token =
    typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token && req.method === 'GET' && req.url.split('?')[0] === '/api/events')
    token = new URL(req.url, 'http://local').searchParams.get('token') || '';
  return safeEqual(token, config.LOCAL_ACCESS_TOKEN);
}
export function validTwilioRequest(
  req: FastifyRequest,
  config: SoloConfig,
  websocket = false,
): boolean {
  const signature = req.headers['x-twilio-signature'];
  if (
    !config.PUBLIC_BASE_URL ||
    !config.TWILIO_AUTH_TOKEN ||
    typeof signature !== 'string'
  )
    return false;
  const body = websocket ? {} : (req.body as Record<string, string>);
  if (
    !websocket &&
    (!body ||
      body.AccountSid !== config.TWILIO_ACCOUNT_SID ||
      !/^application\/x-www-form-urlencoded(?:;|$)/i.test(
        req.headers['content-type'] || '',
      ))
  )
    return false;
  const url = `${config.PUBLIC_BASE_URL}${req.raw.url}`;
  // The handshake is HTTP(S), while some stream senders sign the configured WSS URL.
  // Both candidates are pinned to the configured origin and exact requested path.
  return (
    twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, url, body) ||
    (websocket &&
      twilio.validateRequest(
        config.TWILIO_AUTH_TOKEN,
        signature,
        url.replace(/^https:/, 'wss:'),
        {},
      ))
  );
}
