const passages = [
  {
    id: 'trial',
    title: '先试录 · 30 秒',
    text: `今天我想用平常聊天的声音，录一小段自己的讲话。现在坐得舒服一些，肩膀放松，慢慢吸一口气。我会保持自然的语速，不刻意提高音量。如果听到风声或者碰到麦克风，就重新调整位置。接下来，我想说说今天的天气，以及刚刚做过的一件小事。`,
  },
  {
    id: 'morning',
    title: '第 1 段 · 一天的开始',
    text: `早晨起床以后，我通常先拉开窗帘，看看外面的天气。阳光好的时候，房间里会显得很明亮；如果下雨，我就把出门的时间提前一点。洗漱完，我会喝一杯温水，再准备简单的早餐。吃饭时不必着急，先想好今天最重要的一件事。
有些事情看起来很小，比如整理桌面、给手机充电，或者把钥匙放回固定的位置，却能让接下来的一天更顺利。我希望忙的时候也能保持自己的节奏，一件一件地完成事情。现在回想一下，今天早上我做了什么，哪一个细节让我觉得舒服，又有什么事情可以明天再改进。`,
  },
  {
    id: 'walk',
    title: '第 2 段 · 出门走一走',
    text: `如果有空，我喜欢到附近走一走。沿着熟悉的路慢慢往前，可能会看见有人遛狗，有人骑车，也有人提着刚买的菜往家里走。路口的红灯亮了，我就在斑马线前停下来，等车辆过去。走过树荫的时候，风会凉快一些，树叶轻轻晃动，声音也很安静。
散步不一定要有明确的目的地。有时只是换个环境，让眼睛离开屏幕，活动一下肩膀和脖子。要是走累了，就找一个合适的地方坐一会儿。我会观察周围的小店，想一想下次想去哪里，也留意回家的方向，不让自己赶得太急。`,
  },
  {
    id: 'meal',
    title: '第 3 段 · 准备一顿饭',
    text: `做饭之前，先看看冰箱里还有什么。今天如果有鸡蛋、番茄和一些青菜，就可以做一顿简单的家常饭。把蔬菜洗干净，切好以后分开放，再准备锅和碗。油热了不要急着下手，注意别让水滴溅进去。调味可以少放一点，尝过以后再慢慢调整。
我觉得吃饭最重要的是适合自己的口味，不必每一顿都做得很复杂。忙的时候可以简单一些，有时间再尝试新的做法。饭做好了，先把灶台关好，再把餐具摆整齐。吃完以后收拾厨房，留下一个干净的台面，下一次做饭的时候，心情也会轻松一点。`,
  },
  {
    id: 'schedule',
    title: '第 4 段 · 安排时间',
    text: `我们先确认一下明天的安排。上午九点半开始，预计需要四十五分钟。如果你十点以后才方便，也可以提前告诉我，我们再商量合适的时间。地址和路线请发文字给我，我出门之前会再核对一次，尽量提前十分钟到达。
如果路上遇到堵车，我会及时联系你，不让你一直等。到了以后，我们先把要做的事情列清楚，再决定从哪一项开始。比较紧急的事情今天完成，不着急的部分可以留到下周。安排时间时，最好给自己留一点余地，这样即使中间有变化，也能比较从容地处理。`,
  },
  {
    id: 'shopping',
    title: '第 5 段 · 买东西时的对话',
    text: `你好，我想看看这件东西的具体尺寸。这个颜色还有别的款式吗？如果我买回去发现不合适，可以按照什么流程处理？我不着急下决定，想先比较一下实际需要和价格。请把包含的配件告诉我，如果有需要另外准备的部分，也请一起说明。
买东西之前，我通常会想一想：它会放在哪里，我多久用一次，现有的东西是不是已经够用。有些东西看上去很方便，但真正拿到手里，才知道是否适合自己。把这些问题弄清楚以后，选择就容易多了。如果暂时没有合适的，也可以先记下来，过几天再看看。`,
  },
  {
    id: 'room',
    title: '第 6 段 · 整理房间',
    text: `我准备花一点时间整理房间。先把桌上暂时用不到的东西收起来，再擦一擦屏幕旁边和键盘下面。文件按照用途放好，常用的留在手边，不常用的放进抽屉。电线尽量理顺，杯子放在不容易碰倒的位置，给自己留出一块舒服的工作空间。
整理不需要一次做完所有事情。今天处理桌面，明天收拾书架，也是一种办法。有时候，真正让人轻松的不是房间变得多漂亮，而是知道自己需要的东西在哪里。以后每次用完随手放回去，就不用反复寻找，也能少一点不必要的着急。`,
  },
  {
    id: 'weather',
    title: '第 7 段 · 天气与出行',
    text: `最近早晚的温差有点大。早上出门觉得凉，中午太阳出来以后又会暖和不少。我打算穿一件方便脱下来的外套，包里放一把小伞，以防天气突然变化。出门前再看一下路线，如果公共交通更方便，就不用自己开车。
旅行的时候，我更喜欢把安排留得宽松一些。一天看两三个地方就够了，中间找个安静的地方吃饭、休息。遇到喜欢的街道，可以多走一会儿；如果天气不好，也可以改变计划。照片可以慢慢拍，风景可以慢慢看，最重要的是人舒服，同行的人也都能照顾到。`,
  },
  {
    id: 'work',
    title: '第 8 段 · 把事情讲清楚',
    text: `我想先把目前的情况说明白。已经完成的部分，我们可以直接检查；还没有确认的地方，先列出来，不急着下结论。如果出现问题，就把当时的步骤重新看一遍，弄清楚从哪里开始发生变化。一次只调整一个地方，会更容易比较前后的区别。
讨论的时候，如果我的表达不够清楚，请随时打断我。我也会先听完你的意见，再说自己的想法。我们不一定马上得到答案，但可以先确定下一步要验证什么。把重要的信息记录下来，约好下一次查看的时间，然后按照这个顺序继续推进。`,
  },
  {
    id: 'weekend',
    title: '第 9 段 · 一个轻松的周末',
    text: `如果这个周末没有特别的安排，我想睡到自然醒，再慢慢准备早餐。上午处理一点家里的事情，下午出去透透气。可以和朋友见面，也可以一个人找个地方坐坐。最近有没有读到有意思的内容，或者发现一家不错的小店，都可以随意聊一聊。
休息的时候，不一定非要做出什么成果。把平时来不及做的小事补上，或者干脆留一段空白时间，也挺好。晚上回家以后，我会准备好下周需要的东西，但不会把所有安排都挤在一起。希望新的一周开始时，自己是放松的，也有足够的精神面对新的事情。`,
  },
  {
    id: 'story',
    title: '第 10 段 · 回忆与自然聊天',
    text: `有些小事，过了很久还会记得。也许是一次出门时得到别人的帮助，也许是一顿和家人一起吃的饭，或者某个下午安静地坐着，看窗外的人来来往往。当时觉得很普通，后来想起来，却有一种熟悉的感觉。
我想用自己的话，再说一说最近的一段经历。事情发生在什么时候，当时我在哪里，先做了什么，后来又发生了什么？可以讲得慢一点，也可以停下来想一想。不需要编一个很精彩的故事，就像平时和熟悉的人聊天一样，把自己真正想说的话自然地说出来。`,
  },
];

const elements = Object.fromEntries(
  [
    'consent',
    'microphone',
    'passage',
    'prompt',
    'reading-hint',
    'record',
    'stop',
    'next',
    'status',
    'elapsed',
    'limit',
    'meter',
    'level',
    'total',
    'progress',
    'progress-hint',
    'settings',
    'manifest',
    'clips',
    'empty',
  ].map((id) => [id, document.getElementById(id)]),
);
const clips = [];
const MAX_STORED_SECONDS = 900;
const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
let active = null;
let sequence = 0;
let trialReviewed = false;

function selected() {
  return passages.find((item) => item.id === elements.passage.value);
}
function duration(value) {
  const seconds = Math.floor(value);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function status(message) {
  elements.status.textContent = message;
}
function storedSeconds() {
  return clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
}

function refresh() {
  const passage = selected();
  const trial = passage.id === 'trial';
  const total = clips
    .filter((clip) => !clip.trial)
    .reduce((sum, clip) => sum + clip.durationSeconds, 0);
  elements.prompt.textContent = passage.text;
  elements['reading-hint'].textContent = trial
    ? '先读这段，再随意说两句。30 秒自动停止；你也可以随时停止。'
    : '每段建议 60–90 秒，最多 90 秒自动停止。读完后可以继续聊这个话题，不必反复读同一句。';
  elements.record.textContent = trial ? '开始 30 秒试录' : '开始录制这一段';
  elements.record.disabled =
    !!active ||
    !elements.consent.checked ||
    (!trial && !trialReviewed) ||
    storedSeconds() >= MAX_STORED_SECONDS - 1;
  elements.stop.disabled = !active || active.phase === 'stopping';
  elements.stop.textContent = active?.phase === 'pending' ? '取消开启' : '停止';
  elements.passage.disabled = !!active;
  elements.microphone.disabled = !!active;
  elements.next.disabled = !!active || !trialReviewed;
  elements.manifest.disabled = !!active || !clips.length;
  elements.limit.textContent = `/ ${duration(trial ? 30 : 90)}`;
  elements.total.textContent = duration(total);
  elements.progress.value = Math.min(total, 600);
  elements['progress-hint'].textContent =
    total >= 600
      ? '已达到约 10 分钟录音时长。请逐段试听、保存；有效讲话量及训练适用性仍需检查。'
      : '累计为录音时长，含停顿，并非有效讲话时长。';
  elements.empty.hidden = clips.length > 0;
}

function release(session) {
  clearTimeout(session.timer);
  clearTimeout(session.flushTimer);
  for (const track of session.stream?.getTracks() || []) {
    if (session.onEnded) track.removeEventListener('ended', session.onEnded);
    track.stop();
  }
  for (const node of [session.source, session.processor, session.mute]) {
    try {
      node?.disconnect();
    } catch {
      /* A partially created graph is already disconnected. */
    }
  }
  if (session.processor) {
    session.processor.port.onmessage = null;
    session.processor.port.close();
  }
  session.context?.close().catch(() => {});
}

function cancel(message) {
  const session = active;
  if (!session) return;
  active = null;
  session.cancelled = true;
  release(session);
  session.chunks = [];
  elements.meter.value = 0;
  elements.level.textContent = '已停止';
  status(message);
  refresh();
}

function actualSettings(session) {
  const track = session.stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const toggle = (value) =>
    typeof value === 'boolean' ? (value ? '开启' : '关闭') : '未知';
  session.settings = {
    trackSampleRate: settings.sampleRate ?? null,
    trackChannelCount: settings.channelCount ?? null,
    echoCancellation:
      typeof settings.echoCancellation === 'boolean'
        ? settings.echoCancellation
        : null,
    noiseSuppression:
      typeof settings.noiseSuppression === 'boolean'
        ? settings.noiseSuppression
        : null,
    autoGainControl:
      typeof settings.autoGainControl === 'boolean'
        ? settings.autoGainControl
        : null,
  };
  elements.settings.textContent = `麦克风：${track.label || '浏览器未提供名称'}\nWAV 采样率：${session.rate.toLocaleString()} Hz（AudioContext 实际值）\n音轨采样率：${settings.sampleRate ?? '未知'}${settings.sampleRate ? ' Hz' : ''}\n音轨声道：${settings.channelCount ?? '未知'} → 保存为单声道\n回声消除：${toggle(settings.echoCancellation)}\n降噪：${toggle(settings.noiseSuppression)}\n自动增益：${toggle(settings.autoGainControl)}\n这些开关不代表已经验证音质。`;
  if (Number.isFinite(settings.sampleRate) && settings.sampleRate < 44100)
    elements.settings.textContent +=
      '\n注意：源音轨低于 44.1 kHz，保存较高采样率 WAV 不能恢复细节。建议更换设备或音频设置后重录。';
}

async function listMicrophones(session) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (active !== session) return;
    const selectedId = session.stream
      .getAudioTracks()[0]
      .getSettings().deviceId;
    for (const option of Array.from(elements.microphone.options).slice(1))
      option.remove();
    for (const device of devices.filter(
      (device) =>
        device.kind === 'audioinput' &&
        device.deviceId &&
        device.deviceId !== 'default',
    )) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || '未命名麦克风';
      elements.microphone.append(option);
    }
    if (
      Array.from(elements.microphone.options).some(
        (option) => option.value === selectedId,
      )
    )
      elements.microphone.value = selectedId;
  } catch {
    /* Recording remains usable without device enumeration. */
  }
}

async function start() {
  if (
    active ||
    !elements.consent.checked ||
    (selected().id !== 'trial' && !trialReviewed)
  )
    return;
  const availableSeconds = MAX_STORED_SECONDS - storedSeconds();
  if (availableSeconds < 1) {
    status('页面暂存已满，请保存并删除旧片段后继续。');
    return;
  }
  if (
    !navigator.mediaDevices?.getUserMedia ||
    !window.AudioContext ||
    !window.AudioWorkletNode
  ) {
    status(
      '此浏览器不支持本页录音。请用新版 Chrome 或 Edge，从 localhost 打开。',
    );
    return;
  }
  document.querySelectorAll('audio').forEach((player) => player.pause());
  const session = {
    phase: 'pending',
    passage: selected(),
    chunks: [],
    length: 0,
    cancelled: false,
    startedAt: null,
  };
  active = session;
  elements.elapsed.textContent = '00:00';
  elements.meter.value = 0;
  elements.level.textContent = '等待授权';
  status('请允许麦克风访问。看到“正在录制”后再开始说话；可以随时取消。');
  refresh();
  try {
    session.context = new AudioContext();
    await session.context.resume();
    if (active !== session) return;
    const deviceId = elements.microphone.value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
        ...(deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    if (active !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState !== 'live')
      throw new Error('MICROPHONE_ENDED');
    session.onEnded = () => {
      if (active === session) stop('麦克风已断开，本段可能不完整');
    };
    audioTrack.addEventListener('ended', session.onEnded);
    session.rate = session.context.sampleRate;
    if (
      !Number.isFinite(session.rate) ||
      session.rate < 44100 ||
      session.rate > 192000
    )
      throw new Error('UNSUPPORTED_RATE');
    actualSettings(session);
    void listMicrophones(session);
    await session.context.audioWorklet.addModule('/voice-capture-worklet.js');
    if (active !== session) return;
    if (audioTrack.readyState !== 'live') throw new Error('MICROPHONE_ENDED');
    const seconds = Math.min(
      session.passage.id === 'trial' ? 30 : 90,
      availableSeconds,
    );
    session.maxFrames = Math.floor(session.rate * seconds);
    session.source = session.context.createMediaStreamSource(stream);
    session.processor = new AudioWorkletNode(
      session.context,
      'voice-capture-pcm',
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { maxFrames: session.maxFrames },
      },
    );
    session.mute = session.context.createGain();
    session.mute.gain.value = 0;
    session.processor.port.onmessage = (event) => receive(session, event.data);
    session.processor.onprocessorerror = () => {
      if (active === session)
        cancel('录音处理发生错误，本段未保存。请刷新页面后重新试录。');
    };
    session.source.connect(session.processor);
    session.processor.connect(session.mute);
    session.mute.connect(session.context.destination);
    session.phase = 'recording';
    session.startedAt = new Date().toISOString();
    session.timer = setTimeout(
      () => stop('已到本段时间上限'),
      seconds * 1000 + 1500,
    );
    status(
      session.passage.id === 'trial'
        ? '正在试录。请自然说话，30 秒后自动停止。'
        : '正在录制。建议说满 60–90 秒；随时可点停止。',
    );
    elements.level.textContent = '等待读入';
    refresh();
  } catch (error) {
    release(session);
    if (active !== session) return;
    active = null;
    const messages = {
      NotAllowedError:
        '麦克风访问未获允许。请在浏览器地址栏允许麦克风，然后重试。',
      NotFoundError: '没有找到麦克风。连接设备后重新试录。',
      NotReadableError:
        '麦克风暂时无法读取。检查设备连接，以及其他程序是否占用。',
      OverconstrainedError:
        '所选麦克风已不可用。切回默认麦克风或重新连接设备。',
      UNSUPPORTED_RATE:
        '浏览器实际采样率不足 44.1 kHz 或不受支持。本段未录制；请更换设备或系统音频设置。',
      MICROPHONE_ENDED: '麦克风在准备时已断开。本段未录制，请检查设备后重试。',
    };
    status(
      messages[error.name] ||
        messages[error.message] ||
        '录音未能启动。请确认使用 localhost、设备已连接，并用新版 Chrome 或 Edge 重试。',
    );
    elements.level.textContent = '未录制';
    refresh();
  }
}

function receive(session, message) {
  if (active !== session) return;
  if (message.type === 'chunk') {
    const bytes = message.bytes;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length % 2 ||
      session.length + bytes.length / 2 > session.maxFrames
    ) {
      cancel('录音数据不完整，本段未保存，请重新试录。');
      return;
    }
    session.chunks.push(bytes);
    session.length += bytes.length / 2;
    elements.elapsed.textContent = duration(session.length / session.rate);
    elements.meter.value = Math.min(1, Math.sqrt(Math.max(0, message.rms)));
    elements.level.textContent =
      message.rms > 0
        ? `${(20 * Math.log10(message.rms)).toFixed(0)} dBFS`
        : '静音';
  } else if (message.type === 'done') finish(session, message);
}

function stop(reason = '') {
  const session = active;
  if (!session || session.phase === 'stopping') return;
  if (session.phase === 'pending') {
    cancel('已取消开启麦克风，没有保存录音。');
    return;
  }
  session.phase = 'stopping';
  session.stopReason = reason;
  clearTimeout(session.timer);
  for (const track of session.stream.getTracks()) {
    track.removeEventListener('ended', session.onEnded);
    track.stop();
  }
  session.processor.port.postMessage({ type: 'stop' });
  session.flushTimer = setTimeout(() => {
    if (active === session) cancel('录音收尾超时，本段未保存。请重新试录。');
  }, 1500);
  status('麦克风已停止，正在保存当前片段到页面内存…');
  refresh();
}

function wave(chunks, frames, rate) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  for (const [offset, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ]) {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  }
  view.setUint32(4, 36 + frames * 2, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frames * 2, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

function finish(session, stats) {
  if (active !== session) return;
  active = null;
  release(session);
  elements.meter.value = 0;
  elements.level.textContent = '已停止';
  if (
    stats.frames !== session.length ||
    !Number.isFinite(stats.energy) ||
    !Number.isFinite(stats.peak) ||
    stats.invalid ||
    session.length < session.rate / 2
  ) {
    session.chunks = [];
    status('本段太短或包含无效数据，没有保存。请重新试录。');
    refresh();
    return;
  }
  const seconds = session.length / session.rate;
  const rms = Math.sqrt(stats.energy / session.length);
  const advisory = [];
  if (session.stopReason) advisory.push(session.stopReason);
  if (rms < 0.005)
    advisory.push('平均音量很低，可能过轻或接近静音，请重点试听');
  if (
    Number.isFinite(session.settings.trackSampleRate) &&
    session.settings.trackSampleRate < 44100
  )
    advisory.push(
      `源音轨仅 ${session.settings.trackSampleRate} Hz，WAV 可能经过浏览器升采样，不能恢复原始细节；建议换设备或设置后重录`,
    );
  if (stats.clipped)
    advisory.push(
      `有 ${stats.clipped} 个采样点接近满幅，可能削波；可降低输入增益后重录`,
    );
  if (session.passage.id !== 'trial' && seconds < 60)
    advisory.push('本段不足 60 秒，可保存或补录');
  if (
    [
      session.settings.echoCancellation,
      session.settings.noiseSuppression,
      session.settings.autoGainControl,
    ].some((setting) => setting !== false)
  )
    advisory.push('部分音频处理仍开启或未知，浏览器未确认全部关闭');
  const blob = wave(session.chunks, session.length, session.rate);
  session.chunks = [];
  const clip = {
    id: ++sequence,
    trial: session.passage.id === 'trial',
    passageId: session.passage.id,
    title: session.passage.title,
    promptText: session.passage.text,
    startedAt: session.startedAt,
    durationSeconds: seconds,
    frames: session.length,
    sampleRate: session.rate,
    format: 'PCM16LE',
    channels: 1,
    actualTrackSettings: session.settings,
    rms,
    peak: stats.peak,
    clippingSampleCount: stats.clipped,
    advisory,
    filename: `own-voice-${sessionId}-${String(sequence).padStart(2, '0')}-${session.passage.id}.wav`,
    blob,
    url: URL.createObjectURL(blob),
    downloadRequested: false,
  };
  clips.push(clip);
  renderClip(clip);
  status(
    clip.trial
      ? '试录已结束，麦克风已释放。请在下方试听，然后确认继续。'
      : '本段已结束，麦克风已释放。请试听、下载 WAV，再手动开始下一段。',
  );
  refresh();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function renderClip(clip) {
  const article = document.createElement('article');
  article.className = 'clip';
  const heading = document.createElement('h3');
  heading.textContent = `${String(clip.id).padStart(2, '0')} · ${clip.title}`;
  const detail = document.createElement('p');
  detail.className = 'hint';
  detail.textContent = `${duration(clip.durationSeconds)} · ${clip.sampleRate.toLocaleString()} Hz · 单声道 PCM16 WAV · ${(clip.blob.size / 1048576).toFixed(1)} MB`;
  const advice = document.createElement('p');
  advice.className = clip.advisory.length ? 'warning' : 'hint';
  advice.textContent = clip.advisory.length
    ? clip.advisory.join('；')
    : '电平检查未触发提醒；仍需听一遍，确认没有噪声、回声或漏音。';
  const player = document.createElement('audio');
  player.controls = true;
  player.preload = 'metadata';
  player.src = clip.url;
  player.setAttribute('aria-label', `${clip.title}试听`);
  player.addEventListener('play', () => {
    if (active) {
      player.pause();
      status('请先停止录音再试听，避免播放声进入素材。');
    } else
      document.querySelectorAll('audio').forEach((other) => {
        if (other !== player) other.pause();
      });
  });
  const controls = document.createElement('div');
  controls.className = 'controls';
  const save = document.createElement('button');
  save.textContent = '下载 WAV';
  save.addEventListener('click', () => {
    downloadBlob(clip.blob, clip.filename);
    clip.downloadRequested = true;
    save.textContent = '再次下载 WAV';
    status(
      '已请求浏览器下载。请在下载列表核对 WAV 文件；页面无法确认文件是否落盘。',
    );
  });
  const remove = document.createElement('button');
  remove.textContent = '删除本页片段';
  remove.addEventListener('click', () => {
    if (active) {
      status('请先停止录音，再删除片段。');
      return;
    }
    if (!window.confirm('从本页删除这段录音？请先确认需要保留的 WAV 已下载。'))
      return;
    player.pause();
    player.removeAttribute('src');
    player.load();
    URL.revokeObjectURL(clip.url);
    clips.splice(clips.indexOf(clip), 1);
    article.remove();
    status('已从本页移除该片段。浏览器已下载的文件不受影响。');
    refresh();
  });
  controls.append(save, remove);
  if (clip.trial) {
    const accept = document.createElement('button');
    accept.className = 'primary';
    accept.textContent = '我已试听，开始准备正式录音';
    accept.addEventListener('click', () => {
      if (active) return;
      trialReviewed = true;
      elements.passage.value = passages[1].id;
      status('已切换到正式稿件。准备好后手动点“开始录制这一段”。');
      refresh();
    });
    controls.append(accept);
  }
  article.append(heading, detail, advice, player, controls);
  elements.clips.append(article);
}

for (const passage of passages) {
  const option = document.createElement('option');
  option.value = passage.id;
  option.textContent = passage.title;
  elements.passage.append(option);
}
elements.record.addEventListener('click', () => void start());
elements.stop.addEventListener('click', () => stop());
elements.consent.addEventListener('change', () => {
  if (!elements.consent.checked && active)
    cancel('已取消本人录音确认并释放麦克风，当前片段未保存。');
  refresh();
});
elements.passage.addEventListener('change', () => {
  if (selected().id !== 'trial' && !trialReviewed)
    status('请先完成 30 秒试录，并在试听后确认继续。');
  refresh();
});
elements.next.addEventListener('click', () => {
  if (active || !trialReviewed) return;
  elements.passage.selectedIndex =
    elements.passage.selectedIndex >= passages.length - 1
      ? 1
      : elements.passage.selectedIndex + 1;
  elements.elapsed.textContent = '00:00';
  refresh();
});
elements.manifest.addEventListener('click', () => {
  if (active || !clips.length) return;
  const manifest = {
    version: 'own-voice-recordings/1',
    createdAt: new Date().toISOString(),
    purpose: '本人声音模型实验素材；尚未完成音质或训练验收',
    consent: '用户在开始录音前勾选本人声音及本机保存、后续本项目实验确认',
    downloadedFilesMustBeCheckedManually: true,
    clips: clips.map(({ blob, url, ...metadata }) => metadata),
  };
  downloadBlob(
    new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    `own-voice-${sessionId}-manifest.json`,
  );
  status('已请求下载本机清单。清单不含声音，WAV 仍需逐段下载。');
});
window.addEventListener('beforeunload', (event) => {
  if (active || clips.length) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('pagehide', () => {
  cancel('麦克风已释放。');
  document.querySelectorAll('audio').forEach((player) => {
    player.pause();
    player.removeAttribute('src');
    player.load();
  });
  for (const clip of clips) URL.revokeObjectURL(clip.url);
  clips.length = 0;
  elements.clips.querySelectorAll('.clip').forEach((clip) => clip.remove());
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    elements.clips.querySelectorAll('.clip').forEach((clip) => clip.remove());
    trialReviewed = false;
    elements.consent.checked = false;
    elements.passage.value = 'trial';
    status('返回页面后录音内存已清空。请先重新试录。');
    refresh();
  }
});
refresh();
