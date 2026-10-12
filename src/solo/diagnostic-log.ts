/** Numeric, content-free diagnostics. Never serialize a provider event wholesale. */
export function diagnosticLogRecord(
  event: string,
  data: Record<string, unknown>,
  at = new Date().toISOString(),
): Record<string, unknown> | undefined {
  if (
    ![
      'translation-connection',
      'translation-audio',
      'translation-metric',
      'translation-provider',
      'translation-input',
      'caption-input',
    ].includes(event)
  )
    return undefined;
  const record: Record<string, unknown> = { at, event };
  const choice = (key: string, allowed: string[]) => {
    if (typeof data[key] === 'string' && allowed.includes(data[key] as string))
      record[key] = data[key];
  };
  const numbers = (keys: string[], max = Number.MAX_SAFE_INTEGER) => {
    keys.forEach((key) => {
      const value = data[key];
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= max
      )
        record[key] = value;
    });
  };
  choice('role', ['local', 'remote']);
  if (event === 'translation-connection') {
    choice('state', ['disconnected', 'reconnecting', 'ready']);
    numbers(['closeCode'], 65535);
  }
  if (event === 'caption-input') {
    choice('stage', ['input', 'commit', 'asr-final']);
    numbers([
      'receivedBytes',
      'forwardedBytes',
      'discardedZeroBytes',
      'lowEnergyBytes',
      'commits',
      'peakRms',
      'turnAudioMs',
      'finalCharacters',
    ]);
  }
  if (event === 'translation-metric') {
    choice('name', [
      'speech_stop_to_first_audio_ms',
      'nano_text_to_audio_ms',
      'nano_boundary_wait_ms',
      'pocket_boundary_wait_ms',
      'pocket_text_to_first_chunk_ms',
      'pocket_text_to_first_voiced_ms',
      'pocket_synthesis_complete_ms',
      'prefix_source_wait_ms',
      'prefix_translation_ms',
      'prefix_source_to_submit_ms',
    ]);
    choice('scope', [
      'provider_generation',
      'local_synthesis',
      'text_boundary',
    ]);
    numbers([
      'value',
      'transcriptionMs',
      'queueMs',
      'generationMs',
      'prefixSequence',
    ]);
  }
  if (
    [
      'translation-audio',
      'translation-provider',
      'translation-input',
      'translation-metric',
    ].includes(event)
  ) {
    // This is generated locally for a bridge, never a provider/account/call SID.
    if (
      typeof data.pipelineId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        data.pipelineId,
      )
    )
      record.pipelineId = data.pipelineId;
    choice('clock', ['bridge_monotonic']);
    numbers(['observedAtMs']);
  }
  if (event === 'translation-audio') {
    choice('recipientRole', ['local', 'remote']);
    choice('audioKind', ['original', 'translation']);
    choice('stage', ['generated', 'sent', 'playback_confirmed', 'unconfirmed']);
    if (
      typeof data.deliveryId === 'string' &&
      /^(continuous|original)_[1-9]\d{0,11}$/.test(data.deliveryId)
    )
      record.deliveryId = data.deliveryId;
    numbers([
      'generatedBytes',
      'sentBytes',
      'prefixSequence',
      'createdAtMs',
      'sentAtMs',
      'acknowledgedAtMs',
      'sentToMarkMs',
      'outstandingAudioMs',
      'audioDurationMs',
      'providerElapsedMs',
    ]);
    numbers(['rms', 'peak'], 32768);
  }
  if (event === 'translation-provider') {
    choice('stage', ['session_created', 'session_updated']);
    numbers(['expiresAtEpochSeconds'], 4102444800);
  }
  if (event === 'translation-input') {
    numbers([
      'windowStartedAtMs',
      'windowEndedAtMs',
      'audioDurationMs',
      'mediaTimestampMs',
    ]);
    numbers(['rms', 'peak'], 32768);
  }
  return record;
}
