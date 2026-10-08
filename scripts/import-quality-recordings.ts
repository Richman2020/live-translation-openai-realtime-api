import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  pcm16Wav,
  safeQualityError,
  validatePrivateQualityOutput,
} from '../src/experiments/continuous-quality-matrix';
import { validateQualityRecordings } from '../src/experiments/quality-recordings';

// Only imports a deliberately exported local test bundle. No credentials, API
// calls, live microphone, or phone dependencies are invoked by this script.
try {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--input', '--out'].includes(args[i]) ||
      values.has(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('USE_INPUT_BUNDLE_AND_PRIVATE_OUT');
    values.set(args[i], args[i + 1]);
  }
  if (!values.get('--input') || !values.get('--out'))
    throw new Error('USE_INPUT_BUNDLE_AND_PRIVATE_OUT');
  const outputRoot = validatePrivateQualityOutput(
    process.cwd(),
    values.get('--out')!,
  );
  const inputPath = resolve(values.get('--input')!);
  if (statSync(inputPath).size > 20 * 1024 * 1024)
    throw new Error('RECORDINGS_BUNDLE_TOO_LARGE');
  const fixture = JSON.parse(
    readFileSync('tests/fixtures/phone-quality-v1.json', 'utf8'),
  );
  const items = validateQualityRecordings(
    JSON.parse(readFileSync(inputPath, 'utf8')),
    fixture.cases,
  );
  mkdirSync(dirname(outputRoot), { recursive: true });
  mkdirSync(outputRoot);
  for (const item of items) {
    writeFileSync(
      resolve(outputRoot, `${item.id}.wav`),
      pcm16Wav(item.pcm, 8000),
      { flag: 'wx' },
    );
    writeFileSync(resolve(outputRoot, `${item.id}.pcmu`), item.pcmu, {
      flag: 'wx',
    });
  }
  const manifest = {
    version: 'phone-quality-inputs/1',
    kind: 'human',
    consentForProjectEvaluation: true,
    format: 'PCMU_8000_mono',
    cases: items.map(({ pcm, pcmu, ...item }) => ({
      ...item,
      inputFile: `${item.id}.pcmu`,
      inputSha256: createHash('sha256').update(pcmu).digest('hex'),
    })),
  };
  writeFileSync(
    resolve(outputRoot, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      imported: items.length,
      kind: 'human',
      networkUsed: false,
      credentialsRead: false,
      output: outputRoot,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ failure: safeQualityError(error) }));
  process.exitCode = 1;
}
