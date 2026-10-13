export type CaptionNormalization = {
  displayText: string;
  normalization?: 'conservative';
};

/** Display-only restarts. Facts, emphasis, quotations and corrections stay raw. */
export function normalizeCaptionDisplay(rawText: string): CaptionNormalization {
  if (
    /["'“”‘’`{}<>[\]]/u.test(rawText) ||
    /\b(?:no|not|never|sorry|actually|rather|mean|instead|maybe|perhaps|but)\b/i.test(
      rawText,
    )
  )
    return { displayText: rawText };
  // A finite restart policy, not general deduplication: had/that/very, numbers,
  // names, units and negation are intentionally absent from this whitelist.
  const displayText = rawText.replace(
    /\b(I|the|a|an|to)\b(?:[ \t]+\1\b(?![-'’]))+/g,
    '$1',
  );
  return displayText === rawText
    ? { displayText: rawText }
    : { displayText, normalization: 'conservative' };
}
