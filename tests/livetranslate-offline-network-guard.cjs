'use strict';

// Test-only process guard. No destinations, credentials, headers or payloads are retained.
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

let attempts = 0;
let localIpc = 0;
const deny = () => {
  attempts += 1;
  throw new Error('LIVETRANSLATE_OFFLINE_NETWORK_FORBIDDEN');
};
const allowOnlyLocalPipe = (original) => function (...args) {
  // tsx uses a Unix-domain pipe for local loader IPC. No IP/TCP address is allowed.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const pipe = typeof first === 'string' ? first : first?.path;
  if (typeof pipe === 'string' && pipe.startsWith('/') &&
      (typeof first === 'string' || (first.port === undefined && first.host === undefined))) {
    localIpc += 1;
    return original.apply(this, args);
  }
  return deny();
};
net.Socket.prototype.connect = allowOnlyLocalPipe(net.Socket.prototype.connect);
net.connect = allowOnlyLocalPipe(net.connect);
net.createConnection = allowOnlyLocalPipe(net.createConnection);
tls.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
globalThis.fetch = deny;

process.on('exit', () => {
  const directory = process.env.LIVETRANSLATE_OFFLINE_GUARD_DIR;
  if (directory) {
    fs.writeFileSync(
      path.join(directory, `process-${process.pid}.json`),
      JSON.stringify({ realNetworkAttempts: attempts, allowedLocalPipeCalls: localIpc }) + '\n',
      { mode: 0o600 },
    );
  }
  if (attempts) process.exitCode = 1;
});
