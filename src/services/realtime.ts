/** GA Realtime configuration; Twilio Media Streams use G.711 mu-law. */
export default function buildRealtimeSessionUpdate(instructions: string) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad' },
        },
        output: { format: { type: 'audio/pcmu' } },
      },
    },
  };
}
