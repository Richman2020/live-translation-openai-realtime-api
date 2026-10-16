import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CF62_BASELINE_COMMIT = 'cf62d18eb8dc371f294c8c08f03d2472992e5d4a';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const baselineFiles = [
  'package.json',
  'src/experiments/livetranslate-client.ts',
  'src/experiments/livetranslate-types.ts',
  'src/experiments/livetranslate-send-pump.ts',
  'src/solo/openai-websocket.ts',
] as const;

/** Freeze the complete relative-import closure of cf62, without rewriting its
 * code or borrowing a candidate helper. Locked external dependencies resolve
 * through this repository's existing node_modules; nothing is installed. */
export async function loadFrozenCf62Baseline() {
  const runtime = join(repository, '.runtime');
  mkdirSync(runtime, { recursive: true });
  const directory = mkdtempSync(join(runtime, 'capacity-cf62-differential-'));
  try {
    const blobs = baselineFiles.map((path) => {
      const bytes = execFileSync(
        'git',
        ['show', `${CF62_BASELINE_COMMIT}:${path}`],
        {
          cwd: repository,
        },
      );
      const gitBlob = execFileSync(
        'git',
        ['rev-parse', `${CF62_BASELINE_COMMIT}:${path}`],
        {
          cwd: repository,
          encoding: 'utf8',
        },
      ).trim();
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode: 0o600 });
      assert.equal(
        execFileSync('git', ['hash-object', destination], {
          cwd: repository,
          encoding: 'utf8',
        }).trim(),
        gitBlob,
        `unaltered cf62 Git object: ${path}`,
      );
      return {
        path,
        gitBlob,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    const module = (await import(
      pathToFileURL(join(directory, 'src/experiments/livetranslate-client.ts'))
        .href
    )) as typeof import('../../src/experiments/livetranslate-client');
    return {
      module,
      directory,
      commit: CF62_BASELINE_COMMIT,
      blobs,
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
