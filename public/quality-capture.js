import { qualityFixtures } from './quality-fixtures.js';

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries(
  [
    'consent',
    'case',
    'count',
    'source',
    'record',
    'stop',
    'next',
    'status',
    'player',
    'export',
  ].map((id) => [id, byId(id)]),
);
const samples = new Map();
const MAX_SECONDS = 60;
let active = null;
let pending = null;
let busy = false;
let previewUrl;
let generation = 0;
function selected() {
  return qualityFixtures.cases.find((item) => item.id === elements.case.value);
}
function refresh() {
  const item = selected();
  elements.source.textContent = item.sourceText;
  elements.count.textContent = `已录制 ${samples.size} / ${qualityFixtures.cases.length}`;
  elements.record.disabled = busy || !elements.consent.checked;
  elements.stop.disabled = !active;
  elements.next.disabled = busy;
  elements.case.disabled = busy;
  elements.consent.disabled = busy;
  elements.export.disabled =
    busy ||
    !elements.consent.checked ||
    samples.size !== qualityFixtures.cases.length;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }
  const pcm = samples.get(item.id);
  elements.player.hidden = !pcm;
  elements.player.removeAttribute('src');
  if (pcm) {
    previewUrl = URL.createObjectURL(
      new Blob([wave(pcm)], { type: 'audio/wav' }),
    );
    elements.player.src = previewUrl;
  }
}
function wave(pcm) {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  for (const [offset, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ])
    for (let i = 0; i < value.length; i++)
      bytes[offset + i] = value.charCodeAt(i);
  view.setUint32(4, 36 + pcm.byteLength, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);
  return buffer;
}
function release(session) {
  clearTimeout(session.timer);
  if (session.onEnded)
    session.stream
      .getTracks()
      .forEach((track) => track.removeEventListener('ended', session.onEnded));
  session.processor.onaudioprocess = null;
  session.processor.disconnect();
  session.source.disconnect();
  session.mute.disconnect();
  session.stream.getTracks().forEach((track) => track.stop());
  session.context.close().catch(() => {});
}
async function stop() {
  if (!active) return;
  const session = active;
  active = null;
  release(session);
  elements.stop.disabled = true;
  elements.status.textContent = '正在准备本机试听…';
  try {
    if (session.length < session.rate / 4) throw new Error('TOO_SHORT');
    const joined = new Float32Array(session.length);
    let offset = 0;
    for (const chunk of session.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    session.chunks = [];
    // Browser resampling applies a low-pass filter; do not drop input samples.
    const offline = new OfflineAudioContext(
      1,
      Math.ceil((joined.length * 8000) / session.rate),
      8000,
    );
    const buffer = offline.createBuffer(1, joined.length, session.rate);
    buffer.copyToChannel(joined, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = (await offline.startRendering()).getChannelData(0);
    const pcm = new Uint8Array(rendered.length * 2);
    const view = new DataView(pcm.buffer);
    let energy = 0;
    for (let i = 0; i < rendered.length; i++) {
      const value = Math.max(-1, Math.min(1, rendered[i]));
      const sample = Math.round(value < 0 ? value * 32768 : value * 32767);
      view.setInt16(i * 2, sample, true);
      energy += sample * sample;
    }
    if (Math.sqrt(energy / rendered.length) < 50) throw new Error('QUIET');
    if (session.generation !== generation) return;
    samples.set(session.id, pcm);
    elements.status.textContent = '本句已保存在页面内存，可试听后继续。';
  } catch {
    if (session.generation === generation)
      elements.status.textContent =
        '本句太短、音量过低或处理失败，请重新录制。';
  } finally {
    if (session.generation === generation) {
      busy = false;
      refresh();
    }
  }
}
async function start() {
  if (busy || !elements.consent.checked) return;
  busy = true;
  refresh();
  const ownGeneration = generation;
  const request = { stream: null, context: null };
  pending = request;
  let stream;
  let context;
  try {
    elements.status.textContent = '请允许麦克风访问，然后朗读本句。';
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (ownGeneration !== generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    request.stream = stream;
    context = new AudioContext();
    request.context = context;
    await context.resume();
    if (ownGeneration !== generation) {
      stream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
      return;
    }
    if (!Number.isFinite(context.sampleRate) || context.sampleRate > 192000)
      throw new Error('UNSUPPORTED_RATE');
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    const session = {
      id: selected().id,
      stream,
      context,
      source,
      processor,
      mute,
      rate: context.sampleRate,
      chunks: [],
      length: 0,
      generation: ownGeneration,
      timer: undefined,
    };
    processor.onaudioprocess = (event) => {
      if (active !== session) return;
      const input = event.inputBuffer.getChannelData(0);
      const remaining = Math.floor(session.rate * MAX_SECONDS) - session.length;
      const take = Math.min(input.length, remaining);
      if (take > 0) {
        session.chunks.push(input.slice(0, take));
        session.length += take;
      }
      if (session.length >= session.rate * MAX_SECONDS) void stop();
    };
    session.onEnded = () => {
      if (active !== session) return;
      active = null;
      release(session);
      session.chunks = [];
      busy = false;
      elements.status.textContent =
        '麦克风已断开，本句未保存，请重新选择设备后录制。';
      refresh();
    };
    stream
      .getTracks()
      .forEach((track) => track.addEventListener('ended', session.onEnded));
    active = session;
    pending = null;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    session.timer = setTimeout(() => void stop(), MAX_SECONDS * 1000);
    const trackLabel = stream.getTracks()[0]?.label;
    elements.status.textContent = `正在录制，请正常读稿。${trackLabel ? ` 当前麦克风：${trackLabel}` : ' 使用浏览器默认麦克风。'}`;
    elements.stop.disabled = false;
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    context?.close().catch(() => {});
    if (ownGeneration === generation) {
      pending = null;
      busy = false;
      active = null;
      elements.status.textContent = '未能开启麦克风，请检查设备和浏览器授权。';
      refresh();
    }
  }
}
function base64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 32768)
    result += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(result);
}
function download() {
  if (
    busy ||
    !elements.consent.checked ||
    samples.size !== qualityFixtures.cases.length
  )
    return;
  const bundle = {
    version: 'phone-quality-recordings/1',
    kind: 'human',
    consentForProjectEvaluation: true,
    format: 'PCM16LE_8000_mono',
    cases: qualityFixtures.cases.map((item) => ({
      id: item.id,
      pcm16Base64: base64(samples.get(item.id)),
    })),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `phone-quality-recordings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  elements.status.textContent = '已导出到本机下载目录，没有上传。';
}
qualityFixtures.cases.forEach((item) => {
  const option = document.createElement('option');
  option.value = item.id;
  option.textContent = `${item.id} · ${item.role === 'local' ? '中文' : '英文'}${item.kind === 'long' ? ' · 长讲话' : ''}`;
  elements.case.append(option);
});
elements.record.addEventListener('click', () => void start());
elements.stop.addEventListener('click', () => void stop());
elements.consent.addEventListener('change', refresh);
elements.case.addEventListener('change', refresh);
elements.export.addEventListener('click', download);
elements.next.addEventListener('click', () => {
  elements.case.selectedIndex =
    (elements.case.selectedIndex + 1) % qualityFixtures.cases.length;
  refresh();
});
window.addEventListener('pagehide', () => {
  generation++;
  if (active) {
    release(active);
    active.chunks = [];
    active = null;
  }
  if (pending) {
    pending.stream?.getTracks().forEach((track) => track.stop());
    pending.context?.close().catch(() => {});
    pending = null;
  }
  busy = false;
  samples.clear();
  refresh();
  elements.status.textContent = '录音已释放；返回后可重新录制。';
});
window.addEventListener('pageshow', refresh);
refresh();
