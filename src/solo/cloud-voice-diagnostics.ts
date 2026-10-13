/** Only fixed server classifications may reach deployment logs. */
const reasons = new Set([
  'CLOUD_INGRESS_FORBIDDEN',
  'INGRESS_HEADER_SHAPE',
  'INGRESS_DUPLICATE_HEADER',
  'INGRESS_HEADER_NORMALIZATION',
  'INGRESS_HOST_MISMATCH',
  'INGRESS_PROXY_METADATA',
  'INGRESS_CONNECTION',
  'INGRESS_CONTENT_LENGTH',
  'INGRESS_CONTENT_ENCODING',
  'INGRESS_BODY_METHOD',
  'INGRESS_UPGRADE',
  'INGRESS_UPGRADE_HEAD_LIMIT',
  'TWILIO_SIGNATURE_MISSING',
  'TWILIO_ACCOUNT_MISMATCH',
  'TWILIO_FORM_CONTENT_TYPE_INVALID',
  'TWILIO_SIGNATURE_MISMATCH',
  'INVALID_SESSION',
  'INVALID_BROWSER_CALL',
  'CALL_SID_MISMATCH',
  'INVALID_VOICE_JOIN',
  'CALL_AUTHORIZATION_REVOKED',
  'UNEXPECTED_CALL_LEG',
  'INVALID_MEDIA_STREAM',
  'UNSUPPORTED_AUDIO_FORMAT',
  'MEDIA_START_TIMEOUT',
  'MEDIA_START_INVALID',
]);

export type CloudVoiceRoute =
  | '/voice/client'
  | '/voice/connect'
  | '/voice/status'
  | '/voice/stream-status'
  | '/voice/media';

/** Fixed callback paths only. Never return query values or an unknown route. */
export function cloudVoiceRoute(
  method: string | undefined,
  target: string | undefined,
): CloudVoiceRoute | undefined {
  if (typeof target !== 'string') return undefined;
  if (method === 'GET' && target === '/voice/media') return '/voice/media';
  if (method !== 'POST') return undefined;
  const path = target.split('?')[0];
  if (path === '/voice/client' && target === path) return path;
  if (
    path === '/voice/connect' ||
    path === '/voice/status' ||
    path === '/voice/stream-status'
  )
    return path;
  return undefined;
}

export function reportCloudVoiceRejection(
  route: CloudVoiceRoute,
  reason: string,
): void {
  // Runtime callers cannot turn a type assertion into arbitrary log content.
  const recognized = cloudVoiceRoute(
    route === '/voice/media' ? 'GET' : 'POST',
    route,
  );
  if (!recognized || recognized !== route) return;
  try {
    // eslint-disable-next-line no-console -- Fixed enum and route only; no request or exception data.
    console.error(
      JSON.stringify({
        event:
          route === '/voice/client'
            ? 'CLOUD_VOICE_CLIENT_REJECTED'
            : 'CLOUD_VOICE_CALLBACK_REJECTED',
        route,
        reason: reasons.has(reason) ? reason : 'REQUEST_FORBIDDEN',
      }),
    );
  } catch {
    // Logging failure cannot change authorization or callback cleanup.
  }
}

export function reportCloudVoiceClientRejection(reason: string): void {
  reportCloudVoiceRejection('/voice/client', reason);
}
