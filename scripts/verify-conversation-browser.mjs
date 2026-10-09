/** Offline Chromium acceptance: serves public assets only; no phone/provider APIs. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(repo, 'public');
const executable = process.env.CHROME_BIN || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(existsSync);
if (!executable) throw new Error('Set CHROME_BIN to an installed Chromium executable.');
const profile = await mkdtemp(join(tmpdir(), 'phone-offline-chrome-'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://offline').pathname;
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep) || !mime[extname(file)] || pathname.startsWith('/api/') || pathname.startsWith('/voice/')) {
      response.writeHead(404).end(); return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-store' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome;
let socket;
let nextId = 0;
const pending = new Map();
const faults = [];
const requests = [];
const pause = ms => new Promise(done => setTimeout(done, ms));
async function eventually(action, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await action(); if (value) return value; } catch { /* Boot is asynchronous. */ }
    await pause(50);
  }
  throw new Error('Offline browser readiness timed out');
}
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { done: value => { clearTimeout(timer); done(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}

try {
  chrome = spawn(executable, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  chrome.on('error', error => faults.push(String(error)));
  const port = await eventually(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]));
  const target = await eventually(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject); });
  socket.on('message', data => {
    const value = JSON.parse(String(data));
    if (value.id) {
      const request = pending.get(value.id); pending.delete(value.id);
      if (value.error) request?.reject(new Error(value.error.message)); else request?.done(value.result);
    } else if (value.method === 'Runtime.exceptionThrown') faults.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    else if (value.method === 'Network.requestWillBeSent') requests.push(value.params.request.url);
  });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/conversation-demo.html` });
  await eventually(() => evaluate('window.conversationDemo ? true : false'));
  const checks = [];
  function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); checks.push(label); }
  await evaluate(`document.getElementById('demo-step').click(); window.firstConversationRow = document.querySelector('[data-utterance-id="greeting"]');`);
  equal(await evaluate(`window.firstConversationRow.querySelector('.conversation-original .draft-label').textContent`), '临时 · 更新中', 'draft text is visibly provisional');
  await evaluate(`document.getElementById('demo-step').click(); document.getElementById('demo-step').click(); document.getElementById('demo-step').click();`);
  equal(await evaluate(`({ same: window.firstConversationRow === document.querySelector('[data-utterance-id="greeting"]'), ids: [...document.querySelectorAll('article[data-utterance-id]')].map(row => row.dataset.utteranceId), translated: window.firstConversationRow.querySelector('.conversation-translation .transcript-text').textContent })`), {
    same: true, ids: ['greeting', 'reply'], translated: 'Hello, I would like to book an appointment for three tomorrow afternoon.',
  }, 'late translation updates the paired row without changing conversation order');
  await evaluate(`document.getElementById('demo-step').click()`);
  equal(await evaluate(`window.firstConversationRow.querySelector('.utterance-playback').dataset.playbackStatus`), 'queued', 'final text does not imply played audio');
  await evaluate(`document.getElementById('demo-step').click()`);
  equal(await evaluate(`window.firstConversationRow.querySelector('.utterance-playback').dataset.playbackStatus`), 'sent', 'sent audio remains awaiting line confirmation');
  await evaluate(`document.getElementById('demo-step').click(); document.getElementById('demo-step').click();`);
  equal(await evaluate(`window.firstConversationRow.querySelector('.utterance-playback').dataset.playbackStatus`), 'played', 'matching simulated mark confirms delivery separately');
  await evaluate(`document.getElementById('demo-all').click()`);
  equal(await evaluate(`[...document.querySelectorAll('article[data-utterance-id]')].map(row => row.dataset.utteranceId)`), ['greeting', 'reply', 'details-0', 'interruption', 'details-1', 'confirmation', 'safe-text'], 'late interruption sorts by source time between semantic segments');
  equal(await evaluate(`document.querySelector('[data-utterance-id="details-1"] .conversation-original .transcript-text').textContent`), '不是十五美元，是五十美元以内。', 'stale out-of-order draft cannot overwrite final numbers and negation');
  equal(await evaluate(`document.querySelector('[data-utterance-id="details-1"] .utterance-playback').dataset.playbackStatus`), 'cancelled', 'cancelled queued translation stays distinct from played audio');
  equal(await evaluate(`document.querySelector('[data-utterance-id="confirmation"] .conversation-original .transcript-text').textContent`), 'No problem. We will keep a quiet room for you.', 'source arriving after translation occupies the existing card');
  equal(await evaluate(`document.querySelector('[data-utterance-id="safe-text"] img') === null`), true, 'transcript markup renders as safe text');
  await evaluate(`document.getElementById('demo-history').click()`);
  await pause(100);
  equal(await evaluate(`(() => { const box = document.getElementById('transcript-scroll'); return box.scrollHeight - box.scrollTop - box.clientHeight < 65; })()`), true, 'new conversation follows the latest row');
  await evaluate(`(() => { const box = document.getElementById('transcript-scroll'); box.scrollTop = 120; box.dispatchEvent(new Event('scroll')); window.readingPosition = box.scrollTop; })()`);
  equal(await evaluate(`document.getElementById('conversation-latest').hidden`), false, 'reading history pauses automatic following');
  await evaluate(`document.getElementById('demo-history').click()`);
  await pause(100);
  equal(await evaluate(`Math.abs(document.getElementById('transcript-scroll').scrollTop - window.readingPosition) < 2`), true, 'incoming rows preserve the history reading position');
  await evaluate(`document.getElementById('conversation-latest').click()`);
  equal(await evaluate(`(() => { const box = document.getElementById('transcript-scroll'); return box.scrollHeight - box.scrollTop - box.clientHeight < 65 && document.getElementById('conversation-latest').hidden; })()`), true, 'return to latest resumes following');
  await evaluate(`document.getElementById('demo-reset').click(); document.getElementById('demo-all').click(); document.getElementById('transcript-scroll').scrollTop = 0;`);
  const result = { passed: true, checks };
  assert.deepEqual(faults, []);
  assert.equal(requests.some(url => /^https?:/.test(url) && !url.startsWith(`${origin}/`)), false, 'Browser contacted an external endpoint');
  const output = join(repo, '.runtime', 'conversation-browser');
  await mkdir(output, { recursive: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'acceptance.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(join(output, 'acceptance.json'), `${JSON.stringify({ ...result, browser: await send('Browser.getVersion'), externalRequests: 0, exceptions: faults }, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, screenshot: '.runtime/conversation-browser/acceptance.png', externalRequests: 0, exceptions: faults }));
} finally {
  socket?.close();
  const stopOwnedBrowser = signal => {
    try {
      if (process.platform !== 'win32' && Number.isInteger(chrome?.pid)) process.kill(-chrome.pid, signal);
      else chrome?.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(done => chrome.once('exit', done));
    stopOwnedBrowser('SIGTERM');
    await Promise.race([exited, pause(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) { stopOwnedBrowser('SIGKILL'); await exited; }
  }
  // The runner's Chrome wrapper may exit before its helper processes. Only this
  // detached, owned group is reclaimed; never scan or kill unrelated browsers.
  if (chrome?.pid && process.platform !== 'win32') stopOwnedBrowser('SIGKILL');
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
