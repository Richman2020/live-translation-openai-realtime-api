/** Offline Chromium acceptance: public assets and synthetic header probes; no phone/provider APIs. */
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
const browserSourceHeaders = { fetch: [], eventSource: [] };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://offline').pathname;
    const probe = pathname === '/offline-header-proof/fetch' ? 'fetch'
      : pathname === '/offline-header-proof/events' ? 'eventSource' : undefined;
    if (probe) {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      browserSourceHeaders[probe].push({
        method: request.method,
        origin: request.headers.origin ?? null,
        secFetchSite: request.headers['sec-fetch-site'] ?? null,
        secFetchMode: request.headers['sec-fetch-mode'] ?? null,
        secFetchDest: request.headers['sec-fetch-dest'] ?? null,
      });
      response.writeHead(200, { 'Content-Type': probe === 'eventSource' ? 'text/event-stream' : 'text/plain', 'Cache-Control': 'no-store' });
      response.end(probe === 'eventSource' ? 'data: headers-observed\n\n' : 'headers-observed');
      return;
    }
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
let browserStderr = '';
const pause = ms => new Promise(done => setTimeout(done, ms));
async function eventually(action, timeout = 10000, stage = 'Page') {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await action(); if (value) return value; } catch (error) { lastError = error.message; }
    if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null))
      throw new Error(`${stage}: Chromium exited (${chrome.exitCode ?? chrome.signalCode}). ${browserStderr}`);
    await pause(50);
  }
  throw new Error(`${stage}: offline browser readiness timed out after ${timeout} ms. ${lastError || ''} ${browserStderr}`);
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
  chrome = spawn(executable, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  chrome.stderr.on('data', bytes => {
    // Fresh synthetic profile only. Omit the debugging websocket capability.
    browserStderr = (browserStderr + String(bytes).replace(/DevTools listening on[^\r\n]*/g, '[DevTools ready]')).slice(-4000);
  });
  chrome.on('error', error => faults.push(String(error)));
  const port = await eventually(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 30000, 'Chromium startup');
  const target = await eventually(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'), 10000, 'DevTools target');
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
  await eventually(() => evaluate('window.conversationDemo ? true : false'), 10000, 'Conversation module');
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
  await evaluate(`fetch('/offline-header-proof/fetch').then(async response => {
    if (!response.ok || await response.text() !== 'headers-observed') throw new Error('Synthetic GET probe failed');
  })`);
  await evaluate(`new Promise((resolve, reject) => {
    const source = new EventSource('/offline-header-proof/events');
    const finish = error => { clearTimeout(timer); source.close(); error ? reject(error) : resolve(true); };
    const timer = setTimeout(() => finish(new Error('Synthetic EventSource probe timed out')), 3000);
    source.onmessage = event => finish(event.data === 'headers-observed' ? undefined : new Error('Unexpected synthetic event'));
    source.onerror = () => finish(new Error('Synthetic EventSource probe failed'));
  })`);
  const expectedSourceHeaders = [{ method: 'GET', origin: null, secFetchSite: 'same-origin', secFetchMode: 'cors', secFetchDest: 'empty' }];
  equal(browserSourceHeaders.fetch, expectedSourceHeaders, 'actual Chrome same-origin fetch GET omits Origin and sends same-origin Fetch Metadata');
  equal(browserSourceHeaders.eventSource, expectedSourceHeaders, 'actual Chrome same-origin EventSource GET omits Origin and sends same-origin Fetch Metadata');
  const legacyScreenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await evaluate(`(async () => {
    const { createConversationModel } = await import('/conversation-model.js');
    const { createConversationView } = await import('/conversation-view.js');
    document.documentElement.dataset.phoneSurface = 'controlled';
    document.body.innerHTML = '<section class="transcript-card card" style="height:700px;width:960px;margin:24px auto"><div class="transcript-header"><h2>连续发言块 · 离线事件验收</h2></div><div class="conversation-follow-bar"><span id="block-history" hidden></span><button id="block-latest" hidden>回到最新</button></div><div class="transcript-scroll" id="block-scroll"><div id="block-transcript"></div></div></section>';
    let model = createConversationModel('block-browser');
    const view = createConversationView({ container: document.getElementById('block-transcript'), scrollContainer: document.getElementById('block-scroll'), latestButton: document.getElementById('block-latest'), historyStatus: document.getElementById('block-history') });
    window.blockBrowser = { model, view,
      source(id, role, at, changes = {}) { return { type:'text',sessionId:'block-browser',utteranceId:id,role,kind:'original',text:role==='remote'?'Please confirm two rooms.':'我需要两间房。',final:true,revision:1,sourceRevision:1,at,sequence:at,pairing:'explicit',boundary:'semantic',speakerTurnId:role==='remote'?'remote-one':'local-one',speakerTurnSequence:role==='remote'?1:2,speakerTurnRevision:1,speakerSourceSequence:at,...changes }; },
      apply(event) { const accepted=model.apply(event); if(accepted) { const change=model.getLastChange(); if(change.orderChanged || !view.update(model.getUtterance(change.id))) view.render(model.getUtterances()); } return accepted; },
      reset() { model=createConversationModel('block-browser');this.model=model;view.reset(); },
      translated(id) { return document.querySelector('.conversation-translation [data-source-id=\"'+id+'\"] .translation-text'); },
      trace(id) { return document.querySelector('.conversation-source-evidence[data-source-id=\"'+id+'\"]'); },
      ids() { return [...document.querySelectorAll('.conversation-block')].map(block=>[...block.querySelectorAll('[data-utterance-id]')].map(row=>row.dataset.utteranceId)); }
    };
    for(let index=1;index<=3;index+=1) blockBrowser.apply(blockBrowser.source('remote-'+index,'remote',index*100));
    window.firstBlock=document.querySelector('.conversation-block');
  })()`);
  equal(await evaluate(`({ids:blockBrowser.ids(),headers:document.querySelectorAll('.conversation-block .utterance-meta').length,segments:document.querySelectorAll('.conversation-block [data-utterance-id]').length, readingAreas:document.querySelectorAll('.conversation-block .conversation-part-heading').length})`),
    { ids: [['remote-1', 'remote-2', 'remote-3']], headers: 1, segments: 3, readingAreas: 2 }, 'completed events share one speaker block with one original paragraph, one translated paragraph and no repeated language headings');
  await evaluate(`window.laterSource=blockBrowser.source('remote-after','remote',500);blockBrowser.apply(laterSource);window.laterRow=document.querySelector('[data-utterance-id="remote-after"]');blockBrowser.apply(blockBrowser.source('local-between','local',400));blockBrowser.apply({...laterSource,speakerTurnId:'remote-after-local',speakerTurnSequence:3,speakerTurnRevision:2});`);
  equal(await evaluate(`({ids:blockBrowser.ids(),same:laterRow===document.querySelector('[data-utterance-id="remote-after"]'),first:firstBlock===document.querySelector('.conversation-block')})`),
    { ids: [['remote-1', 'remote-2', 'remote-3'], ['local-between'], ['remote-after']], same: true, first: true }, 'late source insertion and newer binding epoch relocate a paragraph while preserving stable block and row nodes');
  await evaluate(`blockBrowser.apply({...blockBrowser.source('remote-1','remote',100),kind:'translation',text:'请确认两间房。'});`);
  equal(await evaluate(`({first:blockBrowser.translated('remote-1').textContent,last:blockBrowser.translated('remote-after').textContent})`),
    { first: '请确认两间房。', last: '等待译文…' }, 'late translation updates the earlier A block without taking the later A after B');
  await evaluate(`blockBrowser.apply(blockBrowser.source('remote-2','remote',200,{revision:2,sourceRevision:2,text:'I I need two rooms',displayText:'I need two rooms',normalization:'conservative'}));`);
  equal(await evaluate(`(() => {const row=document.querySelector('[data-utterance-id="remote-2"]');return {label:row.closest('.conversation-block').querySelector('.conversation-original .conversation-language').textContent,display:row.querySelector('.original-text').textContent,raw:blockBrowser.trace('remote-2').querySelector('.conversation-raw-text').textContent,rawOpen:row.closest('.conversation-block').querySelector('.conversation-raw').open};})()`),
    { label: '整理显示 · 原始识别可核对', display: 'I need two rooms', raw: 'I I need two rooms', rawOpen: false }, 'conservative display is labelled and the exact original recognition remains inspectable');
  await evaluate(`blockBrowser.apply({...blockBrowser.source('remote-3','remote',300),kind:'translation',sourceRevision:2,text:'对应新版原文的临时字幕',final:false});`);
  equal(await evaluate(`blockBrowser.translated('remote-3').textContent`), '译文待对应原文更新后显示…', 'future-source translation is visibly pending instead of paired with older original text');
  await evaluate(`blockBrowser.apply(blockBrowser.source('remote-3','remote',300,{revision:2,sourceRevision:2,text:'for the ection',final:false}));`);
  equal(await evaluate(`({raw:document.querySelector('[data-utterance-id="remote-3"] .original-text').textContent,translation:blockBrowser.translated('remote-3').textContent,status:document.querySelector('[data-utterance-id="remote-3"]').closest('.conversation-block').querySelector('.conversation-translation .draft-label').textContent})`),
    { raw: 'for the ection', translation: '对应新版原文的临时字幕', status: '临时内容更新中' }, 'a newer raw source exposes its matching Chinese draft without completing or guessing a clipped word');
  equal(await evaluate(`blockBrowser.apply({...laterSource,revision:99,text:'旧绑定正文不能覆盖',speakerTurnRevision:1})`), false, 'late old binding cannot overwrite a relocated source body');
  equal(await evaluate(`(() => {const corrected={...laterSource,speakerTurnId:'remote-after-local',speakerTurnSequence:3,speakerTurnRevision:2,revision:20};const accepted=[{speakerTurnId:undefined,speakerTurnSequence:undefined,speakerTurnRevision:undefined,speakerSourceSequence:undefined},{speakerTurnRevision:undefined},{speakerSourceSequence:undefined}].map(omitted=>blockBrowser.apply({...corrected,...omitted}));const old=blockBrowser.apply({...laterSource,revision:99});const row=blockBrowser.model.getUtterance('remote-after');return {accepted,old,epoch:row.speakerTurnRevision,turn:row.speakerTurnId,textRevision:row.original.revision};})()`),
    { accepted: [false, false, false], old: false, epoch: 2, turn: 'remote-after-local', textRevision: 1 }, 'omitted or partial binding metadata cannot erase a corrected epoch or let an older turn reclaim the displayed paragraph');
  equal(await evaluate(`blockBrowser.apply({...blockBrowser.source('remote-3','remote',300),kind:'translation',revision:99,sourceRevision:1,text:'旧的字幕'})`), false, 'old-source translation cannot overwrite the latest visible Chinese revision');
  await evaluate(`for(const [id,at,text] of [['native-before',100,'Earlier generated English.'],['native-after',600,'Later generated English.']])blockBrowser.apply({type:'text',sessionId:'block-browser',utteranceId:id,role:'local',kind:'translation',text,final:false,revision:1,at,sequence:at,pairing:'unpaired',boundary:'diagnostic',captionSource:'native_output',audioCorrespondence:'generated_only'});`);
  equal(await evaluate(`({ids:blockBrowser.ids(),aux:[...document.querySelectorAll('.conversation-auxiliary')].map(block=>({ids:[...block.querySelectorAll('[data-utterance-id]')].map(row=>row.dataset.utteranceId),label:block.querySelector('.conversation-auxiliary-label strong').textContent,headers:block.querySelectorAll('.utterance-meta').length}))})`),
    { ids: [['remote-1', 'remote-2', 'remote-3'], ['local-between'], ['remote-after']], aux: [{ ids: ['native-before'], label: '未关联来源轮次的文字', headers: 0 }, { ids: ['native-after'], label: '未关联来源轮次的文字', headers: 0 }] }, 'unbound native excerpts remain separate auxiliary entries and do not claim or merge A-B-A speaker turns');
  equal(await evaluate(`({chinese:getComputedStyle(blockBrowser.translated('remote-1')).fontSize,english:getComputedStyle(document.querySelector('[data-utterance-id="remote-1"] .original-text')).fontSize,readingAreas:document.querySelector('.conversation-block').querySelectorAll('.conversation-part-heading').length})`),
    { chinese: '17px', english: '13px', readingAreas: 2 }, 'grouped paragraphs retain prominent Chinese and secondary English inside one outer speech bubble');
  await evaluate(`window.versionedLateSource=blockBrowser.source('translation-first','remote',700,{speakerTurnId:'remote-after-local',speakerTurnSequence:3,speakerTurnRevision:2,sourceRevision:3,text:'not three rooms, two rooms'});blockBrowser.apply({...versionedLateSource,kind:'translation',text:'三间房',sourceRevision:undefined,speakerTurnId:undefined,speakerTurnSequence:undefined,speakerTurnRevision:undefined,speakerSourceSequence:undefined});blockBrowser.apply(versionedLateSource);`);
  equal(await evaluate(`({raw:document.querySelector('[data-utterance-id="translation-first"] .original-text').textContent,translation:blockBrowser.translated('translation-first').textContent})`),
    { raw: 'not three rooms, two rooms', translation: '译文待对应原文更新后显示…' }, 'unknown-version translation received first is hidden when a newer versioned original arrives');
  await evaluate(`blockBrowser.apply({...versionedLateSource,kind:'translation',revision:2,text:'不是三间房，是两间房。'});`);
  equal(await evaluate(`blockBrowser.translated('translation-first').textContent`), '不是三间房，是两间房。', 'matching-source translation replaces the pending unknown-version wording in the same source paragraph');
  for (const withdrawnText of ['', '？！ …']) {
    await evaluate(`blockBrowser.reset();window.withdrawA1=blockBrowser.source('withdraw-a1','local',100,{speakerTurnId:'withdraw-a1',speakerTurnSequence:1,speakerTurnRevision:1});window.withdrawB=blockBrowser.source('withdraw-b','remote',200,{text:'misheard fragment',final:false,speakerTurnId:'withdraw-b',speakerTurnSequence:2,speakerTurnRevision:2});window.withdrawA2=blockBrowser.source('withdraw-a2','local',300,{speakerTurnId:'withdraw-a2',speakerTurnSequence:3,speakerTurnRevision:3});blockBrowser.apply(withdrawA1);blockBrowser.apply(withdrawB);blockBrowser.apply({...withdrawB,kind:'translation',text:'已经显示的旧中文字幕',final:true});blockBrowser.apply(withdrawA2);blockBrowser.apply({...withdrawB,text:${JSON.stringify(withdrawnText)},final:true,revision:2,sourceRevision:2});blockBrowser.apply({...withdrawA2,speakerTurnId:'withdraw-a1',speakerTurnSequence:1,speakerTurnRevision:4});`);
    equal(await evaluate(`(() => {const evidence=blockBrowser.model.getUtterance('withdraw-b');return {ids:blockBrowser.ids(),ghost:document.querySelector('[data-utterance-id="withdraw-b"]')!==null,raw:evidence.original.text,sourceRevision:evidence.original.sourceRevision,withdrawn:evidence.sourceWithdrawn};})()`),
      { ids: [['withdraw-a1', 'withdraw-a2']], ghost: false, raw: withdrawnText, sourceRevision: 2, withdrawn: true }, `final ${withdrawnText ? 'punctuation-only' : 'empty'} raw removes the already translated B card and merges the continuous A source block while retaining audit evidence`);
    equal(await evaluate(`blockBrowser.apply({...withdrawB,kind:'translation',revision:99,text:'晚到旧字幕',final:true})`), false, 'a late older-source translation cannot restore a withdrawn speaker card');
    await evaluate(`blockBrowser.apply({...blockBrowser.source('withdraw-orphan','remote',400),kind:'translation',text:'仅翻译来源未知',sourceRevision:undefined,speakerTurnId:undefined,speakerTurnSequence:undefined,speakerTurnRevision:undefined,speakerSourceSequence:undefined});`);
    equal(await evaluate(`({ghost:document.querySelector('[data-utterance-id="withdraw-b"]')!==null,aux:[...document.querySelectorAll('.conversation-auxiliary [data-utterance-id]')].map(row=>row.dataset.utteranceId)})`),
      { ghost: false, aux: ['withdraw-orphan'] }, 'withdrawal filtering preserves legacy translation-only auxiliary text without reopening B');
    await evaluate(`blockBrowser.apply({...withdrawB,text:'Please confirm two rooms.',revision:3,sourceRevision:3,speakerTurnRevision:5});blockBrowser.apply({...withdrawA2,speakerTurnRevision:5});`);
    equal(await evaluate(`({ids:blockBrowser.ids(),at:blockBrowser.model.getUtterance('withdraw-b').at,translation:blockBrowser.translated('withdraw-b').textContent})`),
      { ids: [['withdraw-a1'], ['withdraw-b'], ['withdraw-a2']], at: 200, translation: '译文待对应原文更新后显示…' }, 'a newer valid raw reactivates the original source position without displaying its withdrawn older Chinese');
  }
  await evaluate(`blockBrowser.reset();for(let index=0;index<40;index+=1)blockBrowser.apply(blockBrowser.source('long-'+index,'remote',1000+index,{text:'Please confirm the room, date and address. '.repeat(3)}));`);
  await pause(100);
  equal(await evaluate(`({blocks:document.querySelectorAll('.conversation-block').length,paragraphs:document.querySelectorAll('.conversation-block [data-utterance-id]').length,following:blockBrowser.view.following})`),
    { blocks: 1, paragraphs: 40, following: true }, 'a long uninterrupted source turn retains one large block with independently versioned paragraphs');
  await evaluate(`(() => {const box=document.getElementById('block-scroll');box.scrollTop=350;box.dispatchEvent(new Event('scroll'));window.blockReadingTop=box.scrollTop;window.blockReadingRow=[...document.querySelectorAll('.conversation-block [data-utterance-id]')].find(row=>row.getBoundingClientRect().bottom>box.getBoundingClientRect().top);window.blockReadingOffset=blockReadingRow.getBoundingClientRect().top-box.getBoundingClientRect().top;blockBrowser.apply(blockBrowser.source('long-40','remote',1040,{text:'Next paragraph after a short pause.'}));})()`);
  await pause(100);
  equal(await evaluate(`({blocks:document.querySelectorAll('.conversation-block').length,following:blockBrowser.view.following,anchor:Math.abs(blockReadingRow.getBoundingClientRect().top-document.getElementById('block-scroll').getBoundingClientRect().top-blockReadingOffset)<2,button:!document.getElementById('block-latest').hidden})`),
    { blocks: 1, following: false, anchor: true, button: true }, 'appending to the same long speaker block preserves the history paragraph anchor and return-to-latest control');
  await evaluate(`document.getElementById('block-latest').click()`);
  equal(await evaluate(`blockBrowser.view.following && document.getElementById('block-latest').hidden`), true, 'return-to-latest resumes following for a continuously growing block');
  await evaluate(`blockBrowser.reset();
    window.draftSource=blockBrowser.source('incremental-one','local',100,{speakerTurnId:'local-only',speakerTurnSequence:1,text:'不是十五',final:false});
    blockBrowser.apply(draftSource);blockBrowser.apply({...draftSource,kind:'translation',text:'Not fifteen',final:false});
    window.incrementalRow=document.querySelector('[data-utterance-id="incremental-one"]');
    window.incrementalOriginal=incrementalRow.querySelector('.original-text');window.incrementalTranslation=blockBrowser.translated('incremental-one');
    blockBrowser.apply({...draftSource,text:'不是十五美元，是五十美元。',revision:2,sourceRevision:2,final:true});
    blockBrowser.apply({...draftSource,kind:'translation',text:'Not fifteen dollars; fifty dollars.',revision:2,sourceRevision:2,final:true});
    blockBrowser.apply(blockBrowser.source('genuine-repeat','local',200,{speakerTurnId:'local-only',speakerTurnSequence:1,text:'不是十五美元，是五十美元。'}));
    blockBrowser.apply({...blockBrowser.source('genuine-repeat','local',200,{speakerTurnId:'local-only',speakerTurnSequence:1}),kind:'translation',text:'Not fifteen dollars; fifty dollars.'});`);
  equal(await evaluate(`({sameOriginal:incrementalOriginal===incrementalRow.querySelector('.original-text'),sameTranslation:incrementalTranslation===blockBrowser.translated('incremental-one'),ids:blockBrowser.ids(),headings:document.querySelectorAll('.conversation-block .conversation-part-heading').length,paragraphs:document.querySelectorAll('.conversation-block .conversation-paragraph').length,source:document.querySelector('.conversation-original .conversation-paragraph').innerText.trim(),translation:document.querySelector('.conversation-translation .conversation-paragraph').innerText.trim(),drafts:document.querySelectorAll('.conversation-fragment-draft').length})`),
    { sameOriginal: true, sameTranslation: true, ids: [['incremental-one', 'genuine-repeat']], headings: 2, paragraphs: 2,
      source: '不是十五美元，是五十美元。 不是十五美元，是五十美元。', translation: 'Not fifteen dollars; fifty dollars. Not fifteen dollars; fifty dollars.', drafts: 0 },
    'partial and final revisions replace stable source nodes inside one reading pair while a genuinely repeated source remains twice');
  await evaluate(`blockBrowser.apply(blockBrowser.source('english-on-local','local',250,{speakerTurnId:'local-only',speakerTurnSequence:1,text:'This recognition is English.'}));blockBrowser.apply(blockBrowser.source('chinese-on-remote','remote',300,{speakerTurnId:'remote-only',speakerTurnSequence:2,text:'刚开'}));`);
  equal(await evaluate(`({roles:[...document.querySelectorAll('.conversation-block')].map(block=>block.classList.contains('mine')?'local':'remote'),localRaw:document.querySelector('[data-utterance-id="english-on-local"] .original-text').textContent,remoteRaw:document.querySelector('[data-utterance-id="chinese-on-remote"] .original-text').textContent,localLabel:document.querySelector('.mine .conversation-original .conversation-language').textContent,remoteLabel:document.querySelector('.their .conversation-original .conversation-language').textContent})`),
    { roles: ['local', 'remote'], localRaw: 'This recognition is English.', remoteRaw: '刚开', localLabel: '我方原始识别 · 预期中文', remoteLabel: '对方原始识别 · 预期英文' },
    'unexpected recognized language is retained with the bound media role instead of being hidden, deduplicated or relabelled as another speaker');
  await evaluate(`blockBrowser.reset();for(let index=0;index<80;index+=1){const source=blockBrowser.source('translated-history-'+index,'remote',1000+index,{text:'Please confirm the address and the date. '.repeat(3)});blockBrowser.apply(source);blockBrowser.apply({...source,kind:'translation',text:'请确认地址和日期，不是十五美元，是五十美元。'.repeat(3)});}const box=document.getElementById('block-scroll');const target=blockBrowser.translated('translated-history-12');box.scrollTop=target.getBoundingClientRect().top-box.getBoundingClientRect().top+box.scrollTop;box.dispatchEvent(new Event('scroll'));window.translationReadingFragment=[...document.querySelectorAll('.conversation-translation .conversation-source-fragment')].find(fragment=>fragment.getBoundingClientRect().bottom>box.getBoundingClientRect().top);window.translationReadingNode=translationReadingFragment.querySelector('.translation-text');window.translationReadingSource=translationReadingFragment.dataset.sourceId;window.translationReadingOffset=translationReadingFragment.getBoundingClientRect().top-box.getBoundingClientRect().top;blockBrowser.apply(blockBrowser.source('translated-history-0','remote',1000,{text:'Please confirm the address and the date. '.repeat(12),revision:2,sourceRevision:2}));`);
  equal(await evaluate(`({same:translationReadingNode===blockBrowser.translated(translationReadingSource),following:blockBrowser.view.following,offset:Math.abs(translationReadingFragment.getBoundingClientRect().top-document.getElementById('block-scroll').getBoundingClientRect().top-translationReadingOffset)<2})`),
    { same: true, following: false, offset: true }, 'reading the translated paragraph retains its own source anchor when an earlier original expands');
  // Screenshot uses synthetic content only; it is a layout receipt, not an ASR,
  // translation, latency or actual call acceptance result.
  await evaluate(`blockBrowser.reset();
    const samples=[['example-local-one','local',100,'您好，我想预约一位水管工。','Hello, I would like to book a plumber.','example-local',1],['example-local-two','local',200,'我会说中文，请您说英文。不是十五美元，是五十美元。','I speak Chinese; please speak English. Not fifteen dollars; fifty dollars.','example-local',1],['example-remote-one','remote',300,'Hello, I am a plumber.','您好，我是一名水管工。','example-remote',2],['example-remote-two','remote',400,'The appointment is on June fifteenth, not June fifth.','预约是六月十五日，不是六月五日。','example-remote',2]];
    for(const [id,role,at,text,translation,speakerTurnId,speakerTurnSequence] of samples){const source=blockBrowser.source(id,role,at,{text,speakerTurnId,speakerTurnSequence});blockBrowser.apply(source);blockBrowser.apply({...source,kind:'translation',text:translation});}
    document.getElementById('block-scroll').scrollTop=0;`);
  await evaluate(`document.getElementById('block-scroll').scrollTop=0;`);
  const result = { passed: true, checks, browserSourceHeaders };
  assert.deepEqual(faults, []);
  assert.equal(requests.some(url => /^https?:/.test(url) && !url.startsWith(`${origin}/`)), false, 'Browser contacted an external endpoint');
  const output = join(repo, '.runtime', 'conversation-browser');
  await mkdir(output, { recursive: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'acceptance.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(join(output, 'legacy-acceptance.png'), Buffer.from(legacyScreenshot.data, 'base64'));
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
