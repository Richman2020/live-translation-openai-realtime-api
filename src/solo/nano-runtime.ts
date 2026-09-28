import {
  createNanoVoiceWorker,
  type NanoVoiceWorker,
} from './nano-voice-worker';

let worker: NanoVoiceWorker | undefined;

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

export function nanoVoiceStatus(): NanoRuntimeStatus {
  return worker?.status() ?? { state: 'not_started', pendingJobs: 0 };
}

export function closeNanoVoiceWorker(): void {
  worker?.close();
  worker = undefined;
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
