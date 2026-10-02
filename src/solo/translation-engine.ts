export const TRANSLATION_ENGINES = [
  'legacy',
  'continuous',
  'continuous-nano',
  'nano-captions',
  'continuous-captions',
  'pocket-captions',
] as const;
export type TranslationEngine = (typeof TRANSLATION_ENGINES)[number];

export function isTranslationEngine(
  value: unknown,
): value is TranslationEngine {
  return TRANSLATION_ENGINES.includes(value as TranslationEngine);
}

export function usesRemoteCaptions(value: unknown): boolean {
  return (
    value === 'nano-captions' ||
    value === 'continuous-captions' ||
    value === 'pocket-captions'
  );
}

export function usesPocketVoice(value: unknown): boolean {
  return value === 'pocket-captions';
}

export function usesNanoVoice(value: unknown): boolean {
  return value === 'continuous-nano' || value === 'nano-captions';
}
