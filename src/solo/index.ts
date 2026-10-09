import { ConfigStore } from './config';
import { buildSoloServer } from './server';
import { SessionManager } from './session-manager';
import { diagnosticLogRecord } from './diagnostic-log';
import { loadPhoneRuntime, requireLocalPhoneRuntime } from './cloud-runtime';

// Reject cloud mode before generating a local token or starting any workers.
requireLocalPhoneRuntime(loadPhoneRuntime());
const configStore = new ConfigStore();
const config = configStore.value;
if (!['127.0.0.1', '::1'].includes(config.API_HOST))
  throw new Error(
    'Solo UI must bind to loopback; use a HTTPS tunnel for /voice webhooks.',
  );
if (
  !/^\d+$/.test(config.API_PORT) ||
  +config.API_PORT < 1024 ||
  +config.API_PORT > 65535
)
  throw new Error('Invalid API_PORT');
const sessionManager = new SessionManager();
sessionManager.on('event', ({ event, data }) => {
  const record = diagnosticLogRecord(event, data);
  if (!record) return;
  // Locally generated correlation IDs and numeric fields only, never call SIDs/content.
  // eslint-disable-next-line no-console -- Keep bounded numeric evidence for call diagnosis.
  console.log(JSON.stringify(record));
});
const server = await buildSoloServer({ configStore, sessionManager });
server.addHook('onClose', async () => {
  setImmediate(() => process.exit(0));
});
await server.listen({ host: config.API_HOST, port: +config.API_PORT });
// eslint-disable-next-line no-console -- Startup prints only the local address, never credentials.
console.log(
  `AI Phone is ready at http://${config.API_HOST}:${config.API_PORT} (solo mode).`,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    sessionManager
      .close()
      .then(() => server.close())
      .catch(() => {
        // eslint-disable-next-line no-console -- Keep the fixed cleanup failure visible on shutdown.
        console.error(
          'CALL_CLEANUP_UNCONFIRMED: the service remains available for call cleanup.',
        );
      });
  });
