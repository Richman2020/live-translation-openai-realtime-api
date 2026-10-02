import {
  createPocketVoiceWorker,
  type PocketVoiceWorker,
} from './pocket-voice-worker';

let worker: PocketVoiceWorker | undefined;
type PocketVoiceCheck = { name: 'pocketVoice' } & (
  | { status: 'passed'; code: 'POCKET_READY' }
  | { status: 'failed'; code: 'POCKETVOICE_UNAVAILABLE' }
);

/** Status never starts a model; one warmed public preset serves sequential calls. */
export function getPocketVoiceWorker(): PocketVoiceWorker {
  if (!worker || ['failed', 'closed'].includes(worker.status().state))
    worker = createPocketVoiceWorker();
  return worker;
}

export function pocketVoiceStatus():
  | ReturnType<PocketVoiceWorker['status']>
  | { state: 'not_started'; pendingJobs: 0 } {
  return worker?.status() ?? { state: 'not_started', pendingJobs: 0 };
}

export function closePocketVoiceWorker(): void {
  worker?.close();
  worker = undefined;
}

export async function checkPocketVoice(): Promise<PocketVoiceCheck> {
  try {
    await getPocketVoiceWorker().ready;
    return { name: 'pocketVoice', status: 'passed', code: 'POCKET_READY' };
  } catch {
    return {
      name: 'pocketVoice',
      status: 'failed',
      code: 'POCKETVOICE_UNAVAILABLE',
    };
  }
}
