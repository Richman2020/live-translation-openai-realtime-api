import {
  parseCloudWebVerificationConfig,
  selectCloudServiceMode,
} from './cloud-web-verification-config';

/** Distinct from the protected local entry. No dotenv write, generated local
 * access token, fake identity, startup model session, or automatic phone call.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check'))
    throw new Error('CLOUD_START_ARGUMENTS_INVALID');
  const mode = selectCloudServiceMode(process.env);
  if (mode === 'web-verification') {
    const config = parseCloudWebVerificationConfig(process.env);
    if (args[0] === '--check') {
      // eslint-disable-next-line no-console -- Fixed metadata, no identity or credentials.
      console.log(
        JSON.stringify({
          ok: true,
          mode: 'cloud',
          serviceMode: 'web-verification',
          configOnly: true,
          externalProvidersContacted: false,
          callsEnabled: false,
          supplierCallsEnabled: false,
          phoneJournalRequired: false,
          singleInstance: true,
        }),
      );
      return;
    }
    const { createCloudWebVerificationService } = await import(
      './cloud-web-verification-service'
    );
    const service = await createCloudWebVerificationService(config);
    const stop = () => {
      service
        .close()
        .then(() => {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        })
        .catch(() => {
          // eslint-disable-next-line no-console -- No transport or provider error text.
          console.error('CLOUD_WEB_STOP_FAILED');
        });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // eslint-disable-next-line no-console -- Fixed mode status, no supplier readiness claim.
    console.log('CLOUD_WEB_VERIFICATION_STARTED_CALLS_DISABLED');
    return;
  }
  const { parseCloudServiceConfig } = await import('./cloud-service-config');
  const config = parseCloudServiceConfig(process.env);
  if (args[0] === '--check') {
    // eslint-disable-next-line no-console -- Fixed metadata only, never env values.
    console.log(
      JSON.stringify({
        ok: true,
        mode: 'cloud',
        configOnly: true,
        externalProvidersContacted: false,
        translationEngine: 'continuous-captions',
        openaiSocketsPerCall: config.outgoingPairedCaptions ? 5 : 3,
        optionalOutgoingCaptionSockets: config.outgoingPairedCaptions ? 2 : 0,
        outgoingPairedCaptions: config.outgoingPairedCaptions,
        openaiModels: [
          'gpt-realtime-translate',
          'gpt-4o-transcribe',
          'gpt-realtime-1.5',
          ...(config.outgoingPairedCaptions ? ['gpt-live-transcribe'] : []),
        ],
        maxCalls: 1,
        maxCallSeconds: 300,
        singleInstance: true,
      }),
    );
    return;
  }
  const { createCloudService, registerCloudServiceSignals } = await import(
    './cloud-service'
  );
  const service = await createCloudService(config, {
    onCleanupFailure: () => {
      // eslint-disable-next-line no-console -- Fixed safety status, no provider errors.
      console.error('CLOUD_CLEANUP_UNCONFIRMED');
    },
  });
  // eslint-disable-next-line no-console -- This does not assert supplier connectivity.
  console.log('CLOUD_CONFIGURED_SINGLE_INSTANCE_STARTED');
  registerCloudServiceSignals(service, {
    onCleanupFailure: () => {
      // eslint-disable-next-line no-console -- Preserve transport on uncertain cleanup.
      console.error('CLOUD_CLEANUP_UNCONFIRMED');
    },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  // Error text from suppliers/transports must never reach deployment logs.
  const safe =
    /^(?:CLOUD_[A-Z_]+(?::[A-Z_]+)?|INVALID_CLOUD_[A-Z_]+|CLOUD_REQUIRES_SINGLE_WARM_INSTANCE|BUDGET_[A-Z_]+|GOOGLE_OIDC_CONFIG_INVALID)$/.test(
      message,
    )
      ? message
      : 'CLOUD_START_FAILED';
  // eslint-disable-next-line no-console -- Allowlisted error codes/field names only.
  console.error(safe);
  process.exitCode = 1;
});
