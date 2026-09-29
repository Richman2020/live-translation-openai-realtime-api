import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeMediaTrace,
  parseMediaTrace,
} from '../src/solo/media-trace-analysis';

export function parseMediaTraceArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--input', '--pipeline', '--sha256', '--out'].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('USE_INPUT_PIPELINE_SHA256_AND_PRIVATE_OUT');
    values.set(key, value);
  }
  if (values.size !== 4 || !/^[a-f0-9]{64}$/i.test(values.get('--sha256')!))
    throw new Error('USE_INPUT_PIPELINE_SHA256_AND_PRIVATE_OUT');
  return {
    input: values.get('--input')!,
    pipeline: values.get('--pipeline')!,
    sha256: values.get('--sha256')!.toLowerCase(),
    out: values.get('--out')!,
  };
}

export function runMediaTraceAnalysis(
  options: ReturnType<typeof parseMediaTraceArguments>,
) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtimeRoot = realpathSync(resolve(projectRoot, '.runtime'));
  const output = resolve(options.out);
  // Resolve the real parent too, so a directory junction cannot publish the
  // private report elsewhere. Require an existing directory; never overwrite.
  const outputParent = realpathSync(dirname(output));
  const withinRuntime = relative(runtimeRoot, outputParent);
  if (
    isAbsolute(withinRuntime) ||
    withinRuntime === '..' ||
    withinRuntime.startsWith('..\\') ||
    withinRuntime.startsWith('../')
  )
    throw new Error('MEDIA_TRACE_OUTPUT_MUST_STAY_PRIVATE');
  if (statSync(options.input).size > 128 * 1024 * 1024)
    throw new Error('MEDIA_TRACE_TOO_LARGE');
  const raw = readFileSync(options.input);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== options.sha256) throw new Error('MEDIA_TRACE_HASH_MISMATCH');
  const report = {
    sourceSha256: sha256,
    ...analyzeMediaTrace(
      parseMediaTrace(raw.toString('utf8'), options.pipeline),
    ),
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    sourceSha256: sha256,
    evidence: report.evidence,
    chunks: report.observed.chunks,
    decision: report.simulation.decision,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        runMediaTraceAnalysis(parseMediaTraceArguments(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(
      JSON.stringify({
        failure: /^[A-Z][A-Z0-9_]{0,95}$/.test(message)
          ? message
          : 'MEDIA_TRACE_ANALYSIS_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
