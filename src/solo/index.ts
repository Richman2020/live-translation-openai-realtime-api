import { ConfigStore } from './config';
import { buildSoloServer } from './server';
import { SessionManager } from './session-manager';

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
  if (!['translation-connection', 'translation-audio'].includes(event)) return;
  // Fixed connection metadata only: no IDs, credentials, audio or transcripts.
  // eslint-disable-next-line no-console -- Retain the numeric close code for diagnosis.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      role: data.role,
      state: data.state,
      closeCode: data.closeCode,
      ...(event === 'translation-audio'
        ? {
            recipientRole: data.recipientRole,
            stage: data.stage,
            generatedBytes: data.generatedBytes,
            sentBytes: data.sentBytes,
          }
        : {}),
    }),
  );
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
