import { constants, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const samplePath = fileURLToPath(new URL('../.env.sample', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

try {
  copyFileSync(samplePath, envPath, constants.COPYFILE_EXCL);
  console.log('.env: CREATED');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.log('.env: EXISTS (unchanged)');
  } else {
    console.error('.env: SETUP_FAILED');
    process.exitCode = 1;
  }
}
