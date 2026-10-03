import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeQualityResults } from '../src/experiments/quality-result-analysis';

export function parseAnalysisArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--input', '--out'].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('USE_INPUT_RESULTS_AND_OUT_NAMED_PRIVATE_ANALYSIS');
    values.set(key, value);
  }
  if (!values.get('--input') || !values.get('--out'))
    throw new Error('USE_INPUT_RESULTS_AND_OUT_NAMED_PRIVATE_ANALYSIS');
  return { input: values.get('--input')!, out: values.get('--out')! };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        analyzeQualityResults(parseAnalysisArguments(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(
      JSON.stringify({
        failure: /^[A-Z][A-Z0-9_]{0,95}$/.test(message)
          ? message
          : 'QUALITY_ANALYSIS_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
