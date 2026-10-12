/** Short-lived loopback-only credential intake. Never starts or changes phone service. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PrivateVoiceConfigError,
  savePrivateVoiceConfig,
  verifyPrivateVoicePath,
} from '../src/experiments/fixed-voice-private-config';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_BODY_BYTES = 4096;
const TTL_MS = 10 * 60_000;

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(token: string, nonce: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>固定声线实验配置</title><body>
<h1>固定声线实验配置</h1><p>只保存在本机项目配置。成功保存后页面会清空并关闭接收服务。</p>
<form id="config" autocomplete="off">
<p><label>ElevenLabs API Key <input name="ELEVENLABS_API_KEY" type="password" autocomplete="new-password" spellcheck="false" maxlength="1024" required></label></p>
<p><label>英文声音编号（可选） <input name="ELEVENLABS_VOICE_ID_EN" autocomplete="off" spellcheck="false" maxlength="128"></label></p>
<p><label>中文声音编号（可选） <input name="ELEVENLABS_VOICE_ID_ZH" autocomplete="off" spellcheck="false" maxlength="128"></label></p>
<button type="submit">保存到本机</button></form><p id="status" role="status"></p>
<script nonce="${nonce}">
const form = document.getElementById('config');
const status = document.getElementById('status');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button'); button.disabled = true;
  form.reset();
  try {
    const response = await fetch(location.pathname + '/save', {
      method: 'POST', headers: {'Content-Type':'application/json','X-Config-Token':'${token}'},
      body: JSON.stringify(values), credentials: 'omit', cache: 'no-store'
    });
    for (const name of Object.keys(values)) values[name] = '';
    const result = await response.json();
    status.textContent = response.ok ? '已保存到本机。接收服务已关闭。' : '未保存：' + result.error;
    if (!response.ok) button.disabled = false;
  } catch { status.textContent = '未确认保存，请核对服务状态。'; button.disabled = false; }
  finally { form.reset(); for (const name of Object.keys(values)) values[name] = ''; }
});
</script></body></html>`;
}

export async function startFixedVoiceIntake(
  options: {
    projectRoot?: string;
    ttlMs?: number;
    save?: (input: unknown) => void;
  } = {},
): Promise<{ url: string; closed: Promise<void>; close: () => void }> {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const ttlMs = options.ttlMs ?? TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 25 || ttlMs > TTL_MS)
    throw new Error('INVALID_TTL');
  verifyPrivateVoicePath(projectRoot);
  const route = `/configure/${randomBytes(24).toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(24).toString('hex');
  let origin = '';
  let used = false;
  let writing = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout>;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    const respond = (status: number, error: string) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ error }));
    };
    if (
      req.socket.remoteAddress !== '127.0.0.1' ||
      req.headers.host !== origin.slice('http://'.length) ||
      req.headers.forwarded ||
      req.headers['x-forwarded-for'] ||
      req.headers['x-forwarded-host'] ||
      req.headers['x-forwarded-proto'] ||
      (req.headers.origin !== undefined && req.headers.origin !== origin)
    ) {
      respond(403, 'LOCAL_ACCESS_ONLY');
      return;
    }
    if (used) {
      respond(410, 'INTAKE_CLOSED');
      return;
    }
    if (req.method === 'GET' && req.url === route) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(token, nonce));
      return;
    }
    if (req.method !== 'POST' || req.url !== `${route}/save`) {
      respond(404, 'NOT_FOUND');
      return;
    }
    if (
      req.headers.origin !== origin ||
      req.headers['content-type'] !== 'application/json' ||
      typeof req.headers['x-config-token'] !== 'string' ||
      !equal(req.headers['x-config-token'], token)
    ) {
      respond(403, 'INVALID_REQUEST');
      return;
    }
    if (writing) {
      respond(409, 'SAVE_IN_PROGRESS');
      return;
    }
    attempts += 1;
    if (attempts > 5) {
      respond(429, 'ATTEMPT_LIMIT');
      return;
    }
    writing = true;
    try {
      if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES)
        throw new PrivateVoiceConfigError('BODY_TOO_LARGE');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES)
          throw new PrivateVoiceConfigError('BODY_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new PrivateVoiceConfigError('INVALID_JSON');
      }
      (
        options.save ||
        ((values) => savePrivateVoiceConfig(projectRoot, values))
      )(input);
      used = true;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.on('finish', () => {
        clearTimeout(timer);
        server.close();
      });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      respond(
        400,
        error instanceof PrivateVoiceConfigError ? error.code : 'SAVE_FAILED',
      );
    } finally {
      writing = false;
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  const closed = new Promise<void>((resolve) => server.once('close', resolve));
  const close = () => {
    used = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  timer = setTimeout(close, ttlMs);
  return { url: `${origin}${route}`, closed, close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  startFixedVoiceIntake()
    .then(async (intake) => {
      // Only a temporary page capability is printed, never submitted values.
      console.log(
        JSON.stringify({
          status: 'READY',
          url: intake.url,
          expiresInSeconds: TTL_MS / 1000,
        }),
      );
      process.once('SIGINT', intake.close);
      process.once('SIGTERM', intake.close);
      await intake.closed;
      console.log(JSON.stringify({ status: 'CLOSED' }));
    })
    .catch(() => {
      console.error(
        JSON.stringify({ status: 'FAILED', error: 'INTAKE_START_FAILED' }),
      );
      process.exitCode = 1;
    });
}
