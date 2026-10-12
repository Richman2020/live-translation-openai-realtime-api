import { pcm16ToMuLaw } from '../solo/translation-pcm';

export type RecordingFixture = {
  id: string;
  role: 'local' | 'remote';
  sourceText: string;
  expectedTranslation: string;
  targetLanguage: 'en' | 'zh';
  kind: 'short' | 'long';
};

/** Validate every recording before writing a file; never opens a provider. */
export function validateQualityRecordings(
  input: unknown,
  fixtures: RecordingFixture[],
) {
  if (!Array.isArray(fixtures) || fixtures.length !== 14)
    throw new Error('INVALID_RECORDING_FIXTURES');
  const fixtureIds = new Set<string>();
  for (const item of fixtures) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(item.id) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(item.id) ||
      fixtureIds.has(item.id.toLowerCase()) ||
      !['local', 'remote'].includes(item.role) ||
      item.targetLanguage !== (item.role === 'local' ? 'en' : 'zh') ||
      !['short', 'long'].includes(item.kind) ||
      [item.sourceText, item.expectedTranslation].some(
        (text) =>
          typeof text !== 'string' || !text.trim() || text.length > 2000,
      )
    )
      throw new Error('INVALID_RECORDING_FIXTURES');
    fixtureIds.add(item.id.toLowerCase());
  }
  for (const role of ['local', 'remote']) {
    if (
      fixtures.filter((item) => item.role === role && item.kind === 'short')
        .length !== 6 ||
      fixtures.filter((item) => item.role === role && item.kind === 'long')
        .length !== 1
    )
      throw new Error('INVALID_RECORDING_FIXTURE_MIX');
  }
  const bundle = input as {
    version?: unknown;
    kind?: unknown;
    format?: unknown;
    consentForProjectEvaluation?: unknown;
    cases?: { id?: unknown; pcm16Base64?: unknown }[];
  } | null;
  if (
    !bundle ||
    bundle.version !== 'phone-quality-recordings/1' ||
    bundle.kind !== 'human' ||
    bundle.format !== 'PCM16LE_8000_mono' ||
    bundle.consentForProjectEvaluation !== true ||
    !Array.isArray(bundle.cases) ||
    bundle.cases.length !== 14 ||
    fixtures.length !== 14
  )
    throw new Error('INVALID_RECORDINGS_OR_MISSING_TEST_CONSENT');
  const known = new Map(fixtures.map((item) => [item.id, item]));
  const seen = new Set<string>();
  return bundle.cases.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !known.has(item.id) ||
      seen.has(item.id) ||
      typeof item.pcm16Base64 !== 'string' ||
      !item.pcm16Base64.length ||
      item.pcm16Base64.length > 1280000 ||
      item.pcm16Base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(item.pcm16Base64)
    )
      throw new Error('INVALID_OR_DUPLICATE_RECORDING');
    seen.add(item.id);
    const pcm = Buffer.from(item.pcm16Base64, 'base64');
    if (
      pcm.length < 4000 ||
      pcm.length > 60 * 16000 ||
      pcm.length % 2 !== 0 ||
      pcm.toString('base64') !== item.pcm16Base64
    )
      throw new Error('RECORDING_MUST_BE_250MS_TO_60S_PCM16_8000_MONO');
    const pcmu = Buffer.alloc(pcm.length / 2);
    let sum = 0;
    for (let i = 0; i < pcmu.length; i += 1) {
      const sample = pcm.readInt16LE(i * 2);
      sum += sample * sample;
      pcmu[i] = pcm16ToMuLaw(sample);
    }
    if (Math.sqrt(sum / pcmu.length) < 50)
      throw new Error('RECORDING_TOO_QUIET');
    const expected = known.get(item.id)!;
    return {
      id: expected.id,
      role: expected.role,
      sourceText: expected.sourceText,
      expectedTranslation: expected.expectedTranslation,
      targetLanguage: expected.targetLanguage,
      kind: expected.kind,
      pcm,
      pcmu,
    };
  });
}
