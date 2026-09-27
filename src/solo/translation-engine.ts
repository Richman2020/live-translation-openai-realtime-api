export const TRANSLATION_ENGINES = ['legacy', 'continuous'] as const;
export type TranslationEngine = (typeof TRANSLATION_ENGINES)[number];

export function isTranslationEngine(
  value: unknown,
): value is TranslationEngine {
  return TRANSLATION_ENGINES.includes(value as TranslationEngine);
}
