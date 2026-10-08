import type { LocalVoiceSynthesizer } from './continuous-translation-bridge';
import type { NanoVoicePostprocessor } from './nano-voice-postprocess';

function aborted(): Error {
  const error = new Error('NANOVOICE_ABORTED');
  error.name = 'AbortError';
  return error;
}

function waitReady(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return ready;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    ready.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Per-sentence B preset. Shared model ownership stays with nano-runtime. */
export function createNanoCaptionVoice(
  source: LocalVoiceSynthesizer,
  postprocessor: NanoVoicePostprocessor,
): LocalVoiceSynthesizer {
  const ready = Promise.all([source.ready, postprocessor.ready]).then(() => {});
  ready.catch(() => {});
  return {
    ready,
    maxOutputSeconds: 22,
    async synthesize(text, signal) {
      await waitReady(ready, signal);
      if (signal?.aborted) throw aborted();
      const generated = await source.synthesize(text, signal);
      if (signal?.aborted) throw aborted();
      const processed = await postprocessor.process(generated.pcm, signal);
      if (signal?.aborted) throw aborted();
      return {
        pcm: processed.pcm,
        sampleRate: 24000,
        metrics: {
          generationMs: generated.metrics.generationMs,
          audioMs: processed.pcm.length / 48,
        },
      };
    },
  };
}
