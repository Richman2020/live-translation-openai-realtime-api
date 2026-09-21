import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

function readEnvFile(relativePath) {
  try {
    return parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url))));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    // Do not print file contents or errors that might include credentials.
    console.error('.env: READ_FAILED');
    process.exit(1);
  }
}

const sample = readEnvFile('../.env.sample');
const config = { ...readEnvFile('../.env'), ...process.env };
const validators = {
  OPENAI_API_KEY: (value) => /^sk-\S+$/.test(value),
  TWILIO_ACCOUNT_SID: (value) => /^AC[0-9a-f]{32}$/i.test(value),
  TWILIO_AUTH_TOKEN: (value) => /^[0-9a-f]{32}$/i.test(value),
  TWILIO_CALLER_NUMBER: (value) => /^\+[1-9]\d{7,14}$/.test(value),
  TWILIO_FLEX_NUMBER: (value) => /^\+[1-9]\d{7,14}$/.test(value),
  TWILIO_FLEX_WORKFLOW_SID: (value) => /^WW[0-9a-f]{32}$/i.test(value),
  NGROK_DOMAIN: (value) => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value),
};

function isPlaceholder(name, value) {
  return value === sample[name]
    || /(?:replace[-_ ]with|your[-_ ]|example\.|<[^>]*>|\[[^\]]*\])/i.test(value)
    || /^(?:AC|WW)(?:0+|X+)$/i.test(value)
    || /^\+\d*X+$/i.test(value);
}

let failed = false;
for (const [name, validate] of Object.entries(validators)) {
  const value = (config[name] ?? '').trim();
  let status = 'PRESENT';
  if (!value) status = 'MISSING';
  else if (isPlaceholder(name, value)) status = 'PLACEHOLDER';
  else if (!validate(value)) status = 'INVALID_FORMAT';
  else if (name === 'TWILIO_FLEX_NUMBER' && value === config.TWILIO_CALLER_NUMBER?.trim()) {
    status = 'MUST_DIFFER_FROM_TWILIO_CALLER_NUMBER';
  }
  console.log(`${name}: ${status}`);
  failed ||= status !== 'PRESENT';
}

const nodeEnvStatus = ['development', 'test', 'production'].includes(config.NODE_ENV)
  ? 'PRESENT'
  : config.NODE_ENV ? 'INVALID_FORMAT' : 'MISSING';
console.log(`NODE_ENV: ${nodeEnvStatus}`);
failed ||= nodeEnvStatus !== 'PRESENT';

if (config.API_PORT !== undefined) {
  const port = Number(config.API_PORT);
  const status = /^\d+$/.test(config.API_PORT) && Number.isInteger(port) && port >= 1 && port <= 65535
    ? 'PRESENT' : 'INVALID_FORMAT';
  console.log(`API_PORT: ${status}`);
  failed ||= status !== 'PRESENT';
}

if (config.FORWARD_AUDIO_BEFORE_TRANSLATION !== undefined) {
  const status = ['true', 'false'].includes(config.FORWARD_AUDIO_BEFORE_TRANSLATION)
    ? 'PRESENT' : 'INVALID_FORMAT';
  console.log(`FORWARD_AUDIO_BEFORE_TRANSLATION: ${status}`);
  failed ||= status !== 'PRESENT';
}

process.exitCode = failed ? 1 : 0;
