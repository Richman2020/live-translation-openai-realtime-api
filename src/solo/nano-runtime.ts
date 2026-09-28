import {
  createNanoVoiceWorker,
  type NanoVoiceWorker,
} from './nano-voice-worker';
import {
  createNanoVoicePostprocessor,
  type NanoVoicePostprocessor,
} from './nano-voice-postprocess';
import { createNanoCaptionVoice } from './nano-caption-voice';
import type { LocalVoiceSynthesizer } from './continuous-translation-bridge';

let worker: NanoVoiceWorker | undefined;
let postprocessor: NanoVoicePostprocessor | undefined;
let captionVoice: LocalVoiceSynthesizer | undefined;
let captionSource: NanoVoiceWorker | undefined;

type NanoRuntimeStatus =
  | ReturnType<NanoVoiceWorker['status']>
  | { state: 'not_started'; pendingJobs: 0 };

type NanoVoiceCheck = {
  name: 'nanoVoice';
} & (
  | { status: 'passed'; code: 'NANO_READY' }
  | { status: 'failed'; code: 'NANOVOICE_UNAVAILABLE' }
);

/** One local GPU model shared across sequential calls; never spawned by status. */
export function getNanoVoiceWorker(): NanoVoiceWorker {
  if (!worker || ['failed', 'closed'].includes(worker.status().state))
    worker = createNanoVoiceWorker();
  return worker;
}

/** Only the original-English/captions mode adopts the user's B + louder preset. */
export function getNanoCaptionVoice(): LocalVoiceSynthesizer {
  const source = getNanoVoiceWorker();
  if (!postprocessor) postprocessor = createNanoVoicePostprocessor();
  if (!captionVoice || captionSource !== source) {
    captionSource = source;
    captionVoice = createNanoCaptionVoice(source, postprocessor);
  }
  return captionVoice;
}

export function nanoVoiceStatus(): NanoRuntimeStatus {
  return worker?.status() ?? { state: 'not_started', pendingJobs: 0 };
}

export function closeNanoVoiceWorker(): void {
  postprocessor?.close();
  postprocessor = undefined;
  captionVoice = undefined;
  captionSource = undefined;
  worker?.close();
  worker = undefined;
}

export async function checkNanoCaptionVoice(): Promise<NanoVoiceCheck> {
  try {
    await getNanoCaptionVoice().ready;
    return { name: 'nanoVoice', status: 'passed', code: 'NANO_READY' };
  } catch {
    postprocessor?.close();
    postprocessor = undefined;
    captionVoice = undefined;
    captionSource = undefined;
    return {
      name: 'nanoVoice',
      status: 'failed',
      code: 'NANOVOICE_UNAVAILABLE',
    };
  }
}

export async function checkNanoVoice(): Promise<NanoVoiceCheck> {
  try {
    await getNanoVoiceWorker().ready;
    return { name: 'nanoVoice', status: 'passed' as const, code: 'NANO_READY' };
  } catch {
    return {
      name: 'nanoVoice',
      status: 'failed' as const,
      code: 'NANOVOICE_UNAVAILABLE',
    };
  }
}
