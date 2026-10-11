// Browser-only controls for the calls-disabled workbench. No phone SDK or stream.
import { observeWebVerificationState } from './web-verification.js';
import { createMicrophoneInput } from './microphone-input.js';
import { createAudioOutput } from './audio-output.js';
import { createConversationModel } from './conversation-model.js';
import { createConversationView } from './conversation-view.js';

const $ = id => document.getElementById(id);
const validMode = document.documentElement.dataset.serviceMode === 'web-workbench';
let disposed = false;
let auth = { phase: 'checking', authenticated: false, expiresAt: 0 };
let capture = null;
let captureGeneration = 0;
let lastAuthenticated = false;
let micMessage = '登录后可点击检测；默认不请求麦克风权限。';
const canUseAudio = () => !disposed && validMode && auth.authenticated
  && auth.phase === 'authenticated' && auth.expiresAt > Date.now()
  && navigator.onLine !== false && !document.hidden;
const mayKeepAudio = () => !disposed && validMode && auth.authenticated
  && ['authenticated', 'renewing'].includes(auth.phase) && auth.expiresAt > Date.now()
  && navigator.onLine !== false && !document.hidden;

function renderMicrophones(snapshot) {
  const select = $('microphone-input');
  select.replaceChildren(new Option('系统默认麦克风', ''));
  for (const device of snapshot.devices) {
    const option = new Option(device.label, device.deviceId);
    option.disabled = device.available === false;
    select.append(option);
  }
  select.value = snapshot.selectedId;
  $('microphone-input-status').textContent = snapshot.status === 'refreshing'
    ? '正在读取设备列表；不会请求麦克风权限。'
    : !snapshot.selectedAvailable ? snapshot.message
    : snapshot.message.startsWith('无法') ? snapshot.message
    : snapshot.selectedId ? '已选择此麦克风；只有点击检测时才启用。'
    : '使用系统默认麦克风。选择和刷新不会启用；授权后可刷新查看设备名称。';
  renderAudioControls();
}

function renderOutput(snapshot) {
  $('audio-output-status').textContent = snapshot.message;
  $('stop-audio-output').hidden = snapshot.status !== 'testing';
  $('test-audio-output').disabled = !canUseAudio() || snapshot.status === 'testing';
}

const microphone = createMicrophoneInput({ mediaDevices: navigator.mediaDevices, onChange: renderMicrophones });
const output = createAudioOutput({ onChange: renderOutput });
const conversation = createConversationModel({ sessionId: 'calls-disabled-empty' });
const conversationView = createConversationView({ container: $('transcript'), scrollContainer: $('transcript-scroll'),
  emptyNode: $('empty-conversation'), latestButton: $('conversation-latest'), historyStatus: $('conversation-history-status') });
// No events are manufactured or subscribed to in this mode.
conversationView.render(conversation.getUtterances());

function renderAudioControls() {
  const snapshot = microphone.snapshot;
  $('microphone-input').disabled = disposed || !validMode || Boolean(capture) || snapshot.status === 'refreshing';
  $('refresh-microphones').disabled = disposed || !validMode || Boolean(capture) || snapshot.status === 'refreshing';
  $('test-microphone').disabled = !canUseAudio() || Boolean(capture) || !snapshot.selectedAvailable
    || snapshot.status === 'refreshing';
  $('stop-microphone-test').disabled = !capture;
  $('microphone-test-status').textContent = micMessage;
  $('microphone-test-status').dataset.status = capture?.status || 'stopped';
  $('test-audio-output').disabled = !canUseAudio() || output.snapshot.status === 'testing';
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch { /* Release the other tracks too. */ }
  }
}

function releaseCapture(operation) {
  if (!operation) return;
  clearTimeout(operation.timeout);
  cancelAnimationFrame(operation.frame);
  for (const [track, listener] of operation.listeners || []) track.removeEventListener?.('ended', listener);
  stopTracks(operation.stream);
  try { operation.source?.disconnect(); } catch { /* Already disconnected. */ }
  try { operation.analyser?.disconnect(); } catch { /* Already disconnected. */ }
  try { Promise.resolve(operation.context?.close()).catch(() => {}); } catch { /* Already closed. */ }
}

function stopMicrophone(message = '检测已停止，麦克风已释放。') {
  ++captureGeneration;
  const operation = capture;
  capture = null;
  releaseCapture(operation);
  micMessage = message;
  $('microphone-level').value = 0;
  $('microphone-level-value').textContent = '0%';
  $('microphone-actual').textContent = '麦克风未启用。';
  renderAudioControls();
}

function currentCapture(operation) {
  return capture === operation && operation.generation === captureGeneration && mayKeepAudio();
}

function retireCapture(operation) {
  if (capture === operation) stopMicrophone('检测已停止，麦克风已释放。');
  else releaseCapture(operation);
}

async function testMicrophone() {
  if (!canUseAudio() || capture || !microphone.snapshot.selectedAvailable) return;
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    micMessage = '浏览器无法检测麦克风，请使用支持音频采集的 HTTPS 页面。'; renderAudioControls(); return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (typeof AudioContextClass !== 'function') {
    micMessage = '浏览器不支持本地音量检测，本次没有启用麦克风。'; renderAudioControls(); return;
  }
  const operation = { generation: ++captureGeneration, status: 'requesting', stream: null,
    context: null, source: null, analyser: null, frame: 0, listeners: [], timeout: null };
  capture = operation;
  micMessage = '正在等待麦克风权限。可以点击停止取消本次检测。'; renderAudioControls();
  operation.timeout = setTimeout(() => {
    if (capture === operation) stopMicrophone('检测时间已到，麦克风已释放；迟到的授权也不会继续采音。');
  }, 30000);
  try {
    // Created only in this explicit click, and never connected to the speakers.
    operation.context = new AudioContextClass();
    await operation.context.resume();
    if (!currentCapture(operation)) { retireCapture(operation); return; }
    const constraints = await microphone.constraints();
    if (!currentCapture(operation)) { retireCapture(operation); return; }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!currentCapture(operation)) { stopTracks(stream); retireCapture(operation); return; }
    operation.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('No live audio track');
    const settings = track.getSettings?.() || {};
    const selectedId = microphone.snapshot.selectedId;
    if (selectedId && settings.deviceId !== selectedId) throw new Error('Microphone selection unconfirmed');
    operation.source = operation.context.createMediaStreamSource(stream);
    operation.analyser = operation.context.createAnalyser();
    operation.analyser.fftSize = 1024;
    operation.source.connect(operation.analyser);
    operation.status = 'running';
    $('microphone-actual').textContent = `实际采音：${track.label || '浏览器未提供设备名称'}${settings.sampleRate ? ` · ${settings.sampleRate} Hz` : ''}`;
    const ended = () => { if (capture === operation) stopMicrophone('麦克风已断开，检测停止。请刷新设备后重试。'); };
    for (const audioTrack of stream.getAudioTracks()) {
      audioTrack.addEventListener?.('ended', ended); operation.listeners.push([audioTrack, ended]);
    }
    micMessage = '正在本地检测音量，请说一句话。音频不上传；30 秒后自动停止。'; renderAudioControls();
    const samples = new Float32Array(operation.analyser.fftSize);
    const updateLevel = () => {
      if (!currentCapture(operation)) {
        if (capture === operation) stopMicrophone('检测已停止，麦克风已释放。');
        return;
      }
      operation.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 100));
      $('microphone-level').value = level;
      $('microphone-level-value').textContent = `${level}%`;
      operation.frame = requestAnimationFrame(updateLevel);
    };
    updateLevel();
  } catch (error) {
    if (capture !== operation || operation.generation !== captureGeneration) { releaseCapture(operation); return; }
    stopMicrophone(error?.name === 'NotAllowedError' ? '麦克风权限未获允许，本次没有继续采音。'
      : error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError'
      ? '选定的麦克风不可用，请刷新并重新选择。'
      : '未能确认麦克风检测，已释放音频资源。请检查设备后重试。');
  }
}

const number = $('phone-number');
const normaliseNumber = value => value.replace(/[^\d+*# ()-]/g, '').slice(0, 24);
number.addEventListener('input', () => {
  const position = number.selectionStart;
  const prefix = normaliseNumber(number.value.slice(0, position));
  number.value = normaliseNumber(number.value);
  number.setSelectionRange(prefix.length, prefix.length);
  $('phone-error').textContent = '';
});
const letters = ['','ABC','DEF','GHI','JKL','MNO','PQRS','TUV','WXYZ','','+',''];
for (const [index, digit] of ['1','2','3','4','5','6','7','8','9','*','0','#'].entries()) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'dial-key'; button.dataset.digit = digit;
  button.setAttribute('aria-label', `输入 ${digit}`);
  button.append(document.createTextNode(digit));
  const sublabel = document.createElement('small'); sublabel.textContent = letters[index]; button.append(sublabel);
  button.disabled = !validMode;
  button.addEventListener('click', () => {
    if (disposed || !validMode) return;
    const start = number.selectionStart ?? number.value.length;
    const end = number.selectionEnd ?? start;
    if (number.value.length - (end - start) >= 24) return;
    number.setRangeText(digit, start, end, 'end'); number.focus();
  });
  document.querySelector('.keypad').append(button);
}
$('erase-number').addEventListener('click', () => {
  if (disposed || !validMode) return;
  const start = number.selectionStart ?? number.value.length;
  const end = number.selectionEnd ?? start;
  number.setRangeText('', start === end ? Math.max(0, start - 1) : start, end, 'end'); number.focus();
});
number.disabled = !validMode; $('erase-number').disabled = !validMode;
$('refresh-microphones').addEventListener('click', () => { if (!disposed && validMode && !capture) void microphone.refresh(); });
$('microphone-input').addEventListener('change', event => { if (!capture) microphone.select(event.target.value); });
$('test-microphone').addEventListener('click', testMicrophone);
$('stop-microphone-test').addEventListener('click', () => stopMicrophone());
$('test-audio-output').addEventListener('click', () => { if (canUseAudio() && output.snapshot.status !== 'testing') void output.test(); });
$('stop-audio-output').addEventListener('click', () => output.cancelTest());

const unsubscribeAuth = observeWebVerificationState(snapshot => {
  auth = snapshot;
  $('account-summary').textContent = snapshot.authenticated ? '账号 · 已登录'
    : snapshot.phase === 'checking' ? '账号 · 正在检查' : '账号 · 未登录';
  if (snapshot.authenticated && !lastAuthenticated) $('account-menu').open = false;
  lastAuthenticated = snapshot.authenticated;
  if (!mayKeepAudio()) {
    if (capture) stopMicrophone('登录或页面状态已变化，检测已停止，麦克风已释放。');
    output.cancelTest();
  }
  if (!capture && !snapshot.authenticated) micMessage = '登录后可点击检测；默认不请求麦克风权限。';
  else if (!capture && micMessage.startsWith('登录后')) micMessage = '点击检测后才会启用麦克风；可以随时停止。';
  renderAudioControls();
});

function stopLocalAudio(message) {
  if (capture) stopMicrophone(message);
  output.cancelTest();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLocalAudio('页面已离开前台，检测已停止，麦克风已释放。');
  renderAudioControls();
});
window.addEventListener('offline', () => stopLocalAudio('网络已离线，检测已停止，麦克风已释放。'));
window.addEventListener('pagehide', () => {
  disposed = true;
  stopLocalAudio('页面已关闭，麦克风已释放。');
  unsubscribeAuth(); microphone.dispose(); conversationView.dispose();
  document.documentElement.dataset.workbenchReady = 'false';
});
renderMicrophones(microphone.snapshot); renderOutput(output.snapshot);
if (validMode) void microphone.refresh();
document.documentElement.dataset.workbenchReady = 'true';
