import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const vendor = resolve('public/vendor');
mkdirSync(vendor, { recursive: true });
copyFileSync(
  resolve('node_modules/@twilio/voice-sdk/dist/twilio.min.js'),
  resolve(vendor, 'twilio.min.js'),
);
console.log('Desktop Voice SDK prepared locally.');
