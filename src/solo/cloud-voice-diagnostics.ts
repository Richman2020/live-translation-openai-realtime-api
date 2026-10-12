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
  'TWILIO_SIGNATURE_MISSING',
  'TWILIO_ACCOUNT_MISMATCH',
  'TWILIO_FORM_CONTENT_TYPE_INVALID',
  'TWILIO_SIGNATURE_MISMATCH',
  'INVALID_SESSION',
  'INVALID_BROWSER_CALL',
  'CALL_SID_MISMATCH',
  'INVALID_VOICE_JOIN',
  'CALL_AUTHORIZATION_REVOKED',
]);

export function reportCloudVoiceClientRejection(reason: string): void {
  try {
    // eslint-disable-next-line no-console -- Fixed enum and route only; no request or exception data.
    console.error(
      JSON.stringify({
        event: 'CLOUD_VOICE_CLIENT_REJECTED',
        route: '/voice/client',
        reason: reasons.has(reason) ? reason : 'REQUEST_FORBIDDEN',
      }),
    );
  } catch {
    // Logging failure cannot change authorization or callback cleanup.
  }
}
