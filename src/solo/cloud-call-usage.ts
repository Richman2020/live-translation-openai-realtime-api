/** Application reservations only, never a supplier invoice cap. Provider special
 * tokens, automatic ASR/VAD output and actual non-text fees are not proven bounded
 * by these byte proxies. The durable journal must reserve the entire call first;
 * this ephemeral guard cannot restore a call or refund an admitted operation. */
export type CloudProviderAdmission =
  | {
      stage: 'connect';
      connectionId: string;
      role: 'local' | 'remote';
      path: 'native_translation' | 'remote_captions' | 'outgoing_captions';
      url: string;
    }
  | { stage: 'send'; connectionId: string; data: unknown };

type RecordValue = Record<string, any>;
type Slot =
  | 'native'
  | 'remoteAsr'
  | 'remoteText'
  | 'outgoingAsr'
  | 'outgoingText';
type Connection = {
  slot: Slot;
  updates: number;
  instructionsBytes: number;
  inputBytes: number;
  serverVad: boolean;
  ended: boolean;
};
const NON_TEXT_RESERVE = 2_000_000; // Engineering reserve, not verified vendor pricing.
const PCM_LIMIT = 14_400_000;
const ERROR = 'CLOUD_CALL_USAGE_REJECTED';
const record = (v: unknown): v is RecordValue =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, allowed: string[]) =>
  record(v) && Object.keys(v).every((k) => allowed.includes(k));
const exact = (v: unknown, expected: unknown) =>
  JSON.stringify(v) === JSON.stringify(expected);
const boundedText = (v: unknown): v is string =>
  typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= 16_384;
const id = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(v);

export function createCloudCallUsageBudget(options: {
  reservationUsdMicros: number;
  outgoingPairedCaptions: boolean;
}) {
  if (
    !record(options) ||
    !Number.isSafeInteger(options.reservationUsdMicros) ||
    options.reservationUsdMicros <= NON_TEXT_RESERVE ||
    options.reservationUsdMicros > 5_000_000 ||
    typeof options.outgoingPairedCaptions !== 'boolean'
  )
    throw new Error(ERROR);
  const { reservationUsdMicros, outgoingPairedCaptions } = options;
  const connections = new Map<string, Connection>();
  const slots = new Set<Slot>();
  let closed = false;
  let inputUnits = 0;
  let outputTokensReserved = 0;
  let textRequests = 0;
  let textReservedUsdMicros = 0;
  let nativePlaybackBytes = 0;
  let returnOriginalPlaybackBytes = 0;
  let sends = 0;
  const reject = (): never => {
    closed = true;
    throw new Error(ERROR);
  };
  const require = (condition: unknown) => {
    if (!condition) reject();
  };
  const sessionUpdate = (c: Connection, session: RecordValue) => {
    require(record(session));
    if (c.slot === 'native') {
      require(
        c.updates === 0 &&
          keys(session, ['audio']) &&
          keys(session.audio, ['input', 'output']) &&
          exact(session.audio.output, { language: 'en' }),
      );
      if (session.audio.input !== undefined)
        require(
          keys(session.audio.input, ['noise_reduction']) &&
            (session.audio.input.noise_reduction === null ||
              exact(session.audio.input.noise_reduction, {
                type: 'near_field',
              }) ||
              exact(session.audio.input.noise_reduction, {
                type: 'far_field',
              })),
        );
    } else if (c.slot.endsWith('Text')) {
      require(
        c.updates === 0 &&
          keys(session, [
            'type',
            'model',
            'output_modalities',
            'instructions',
            'audio',
            'tools',
          ]) &&
          session.type === 'realtime' &&
          session.model === 'gpt-realtime-1.5' &&
          exact(session.output_modalities, ['text']) &&
          exact(session.audio, { input: { turn_detection: null } }) &&
          exact(session.tools, []) &&
          boundedText(session.instructions),
      );
      c.instructionsBytes = Buffer.byteLength(session.instructions, 'utf8');
    } else {
      if (c.updates !== 0) {
        require(
          c.updates === 1 &&
            c.slot === 'remoteAsr' &&
            c.serverVad &&
            exact(session, {
              type: 'transcription',
              audio: { input: { turn_detection: null } },
            }),
        );
      } else {
        require(
          keys(session, ['type', 'audio']) &&
            session.type === 'transcription' &&
            keys(session.audio, ['input']),
        );
        const input = session.audio.input;
        require(
          keys(input, ['format', 'transcription', 'turn_detection']) &&
            exact(input.format, { type: 'audio/pcm', rate: 24000 }),
        );
        const t = input.transcription;
        require(record(t));
        if (c.slot === 'remoteAsr' && t.model === 'gpt-4o-transcribe') {
          require(
            keys(t, ['model', 'language', 'prompt']) &&
              t.language === 'en' &&
              boundedText(t.prompt) &&
              exact(input.turn_detection, {
                type: 'server_vad',
                threshold: 0.3,
                prefix_padding_ms: 300,
                silence_duration_ms: 400,
              }),
          );
          c.serverVad = true;
        } else {
          require(
            c.slot === 'outgoingAsr' &&
              keys(t, ['model', 'languages', 'delay']) &&
              t.model === 'gpt-live-transcribe' &&
              exact(t.languages, ['zh-cn']) &&
              t.delay === 'low' &&
              input.turn_detection === null,
          );
        }
      }
    }
    c.updates += 1;
  };
  const admit = (event: CloudProviderAdmission) => {
    try {
      require(!closed && record(event) && id(event.connectionId));
      if (event.stage === 'connect') {
        require(!connections.has(event.connectionId));
        let slot: Slot;
        if (event.path === 'native_translation') {
          require(
            event.role === 'local' &&
              event.url ===
                'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate',
          );
          slot = 'native';
        } else {
          require(
            (event.path === 'remote_captions' && event.role === 'remote') ||
              (event.path === 'outgoing_captions' &&
                event.role === 'local' &&
                outgoingPairedCaptions),
          );
          require(
            event.url ===
              'wss://api.openai.com/v1/realtime?intent=transcription' ||
              event.url ===
                'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5',
          );
          slot =
            `${event.path === 'remote_captions' ? 'remote' : 'outgoing'}${event.url.endsWith('intent=transcription') ? 'Asr' : 'Text'}` as Slot;
        }
        require(!slots.has(slot));
        slots.add(slot);
        connections.set(event.connectionId, {
          slot,
          updates: 0,
          instructionsBytes: 0,
          inputBytes: 0,
          serverVad: false,
          ended: false,
        });
        return;
      }
      require(
        event.stage === 'send' &&
          typeof event.data === 'string' &&
          Buffer.byteLength(event.data as string) <= 20_000_000 &&
          sends < 100_000,
      );
      const c = connections.get(event.connectionId);
      require(c && !c.ended);
      const connection = c!;
      const raw = event.data as string;
      const message = JSON.parse(raw);
      require(
        record(message) &&
          (message.event_id === undefined || id(message.event_id)),
      );
      if (message.type === 'session.update') {
        require(keys(message, ['type', 'event_id', 'session']));
        sessionUpdate(connection, message.session);
      } else {
        require(connection.updates > 0);
        if (message.type === 'response.create') {
          require(
            connection.slot.endsWith('Text') &&
              keys(message, ['type', 'event_id', 'response']),
          );
          const r = message.response;
          require(
            keys(r, [
              'conversation',
              'metadata',
              'output_modalities',
              'instructions',
              'max_output_tokens',
              'input',
            ]) &&
              r.conversation === 'none' &&
              exact(r.output_modalities, ['text']) &&
              boundedText(r.instructions) &&
              Number.isSafeInteger(r.max_output_tokens) &&
              r.max_output_tokens >= 1 &&
              r.max_output_tokens <= 1200,
          );
          require(
            r.metadata === undefined ||
              (keys(r.metadata, ['caption_request', 'prefix_request']) &&
                Object.values(r.metadata).every(id)),
          );
          require(
            Array.isArray(r.input) &&
              r.input.length > 0 &&
              r.input.length <= 16 &&
              r.input.every(
                (item: unknown) =>
                  keys(item, ['type', 'role', 'content']) &&
                  (item as RecordValue).type === 'message' &&
                  (item as RecordValue).role === 'user' &&
                  Array.isArray((item as RecordValue).content) &&
                  (item as RecordValue).content.length > 0 &&
                  (item as RecordValue).content.length <= 16 &&
                  (item as RecordValue).content.every(
                    (content: unknown) =>
                      keys(content, ['type', 'text']) &&
                      (content as RecordValue).type === 'input_text' &&
                      boundedText((content as RecordValue).text),
                  ),
              ),
          );
          // Count the actual encoded request each time, including escaped JSON,
          // repeated context and both request/session instructions. Bytes are a
          // conservative application proxy, deliberately not called tokens.
          const units =
            Buffer.byteLength(raw, 'utf8') +
            connection.instructionsBytes +
            4096;
          const fee = units * 4 + r.max_output_tokens * 16;
          require(
            units <= 32768 &&
              inputUnits + units <= 450000 &&
              textRequests < 60 &&
              outputTokensReserved + r.max_output_tokens <= 72000 &&
              NON_TEXT_RESERVE + textReservedUsdMicros + fee <=
                reservationUsdMicros,
          );
          inputUnits += units;
          outputTokensReserved += r.max_output_tokens;
          textReservedUsdMicros += fee;
          textRequests += 1;
        } else if (
          message.type === 'input_audio_buffer.append' ||
          message.type === 'session.input_audio_buffer.append'
        ) {
          require(
            !connection.slot.endsWith('Text') &&
              message.type ===
                (connection.slot === 'native'
                  ? 'session.input_audio_buffer.append'
                  : 'input_audio_buffer.append') &&
              keys(message, ['type', 'event_id', 'audio']) &&
              typeof message.audio === 'string' &&
              message.audio.length > 0 &&
              message.audio.length % 4 === 0 &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(message.audio),
          );
          const pcm = Buffer.from(message.audio, 'base64');
          require(
            pcm.length > 0 &&
              pcm.length % 2 === 0 &&
              pcm.toString('base64') === message.audio &&
              connection.inputBytes + pcm.length <= PCM_LIMIT,
          );
          connection.inputBytes += pcm.length;
        } else if (message.type === 'response.cancel') {
          require(
            connection.slot.endsWith('Text') &&
              keys(message, ['type', 'event_id', 'response_id']) &&
              id(message.response_id),
          );
        } else if (message.type === 'input_audio_buffer.commit') {
          require(
            connection.slot.endsWith('Asr') &&
              keys(message, ['type', 'event_id']),
          );
        } else if (message.type === 'session.close') {
          require(
            connection.slot === 'native' && keys(message, ['type', 'event_id']),
          );
          connection.ended = true;
        } else reject();
      }
      sends += 1;
    } catch {
      reject();
    }
  };
  return {
    admit,
    consumePlayback(event: {
      path: 'native_translation' | 'return_original';
      bytes: number;
    }) {
      require(
        !closed &&
          record(event) &&
          Number.isSafeInteger(event.bytes) &&
          event.bytes > 0,
      );
      if (event.path === 'native_translation') {
        require(
          event.bytes % 2 === 0 &&
            nativePlaybackBytes + event.bytes <= PCM_LIMIT,
        );
        nativePlaybackBytes += event.bytes;
      } else {
        require(
          event.path === 'return_original' &&
            returnOriginalPlaybackBytes + event.bytes <= 2_400_000,
        );
        returnOriginalPlaybackBytes += event.bytes;
      }
    },
    close() {
      closed = true;
    },
    get snapshot() {
      return {
        scope: 'application_reserved' as const,
        billed: false as const,
        costBoundVerified: false as const,
        closed,
        connections: connections.size,
        sends,
        textRequests,
        inputUnits,
        outputTokensReserved,
        textReservedUsdMicros,
        nonTextReservedUsdMicros: NON_TEXT_RESERVE,
        reservationUsdMicros,
        nativeInputBytes:
          [...connections.values()].find((c) => c.slot === 'native')
            ?.inputBytes ?? 0,
        remoteAsrInputBytes:
          [...connections.values()].find((c) => c.slot === 'remoteAsr')
            ?.inputBytes ?? 0,
        outgoingAsrInputBytes:
          [...connections.values()].find((c) => c.slot === 'outgoingAsr')
            ?.inputBytes ?? 0,
        nativePlaybackBytes,
        returnOriginalPlaybackBytes,
      };
    },
  };
}
