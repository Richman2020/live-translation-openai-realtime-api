const sessionId = 'offline-conversation-v1';
const startedAt = Date.UTC(2026, 9, 9, 9, 30, 0);
const text = (utteranceId, role, kind, content, final, revision, offset, sequence, boundary = 'utterance') => ({
  type: 'text', sessionId, utteranceId, role, kind, text: content, final, revision,
  at: startedAt + offset, sequence, pairing: 'explicit', boundary,
});
const playbackSources = { greeting: [0, 0], 'details-0': [2500, 2], 'details-1': [4500, 4] };
const playback = (utteranceId, status, revision, extra = {}) => ({
  at: startedAt + playbackSources[utteranceId][0], sequence: playbackSources[utteranceId][1],
  type: 'playback', sessionId, utteranceId, role: 'local', status, revision,
  evidence: status === 'played' ? 'twilio_mark' : 'transport', ...extra,
});

export const conversationFixture = {
  sessionId,
  steps: [
    { label: '中文临时识别出现，译文位置保留。', event: text('greeting', 'local', 'original', '你好，我想预', false, 1, 0, 0) },
    { label: '同一句中文确定，临时文字原地更新。', event: text('greeting', 'local', 'original', '你好，我想预约明天下午三点。', true, 2, 0, 0) },
    { label: '对方开始回答；双方按说话时间交替。', event: text('reply', 'remote', 'original', 'We have a slot at three.', true, 1, 1500, 1) },
    { label: '前一句英文译文晚到，回到原中文下方。', event: text('greeting', 'local', 'translation', 'Hello, I would like to book an appointment for three tomorrow afternoon.', true, 1, 0, 0) },
    { label: '文字已确定，但英文译音仍待播放。', event: playback('greeting', 'queued', 1) },
    { label: '译音已送出，还没有线路播放确认。', event: playback('greeting', 'sent', 2, { deliveryId: 'greeting-a' }) },
    { label: '对方中文字幕到达，与英文原文配对。', event: text('reply', 'remote', 'translation', '我们三点有空位。', true, 1, 1500, 1) },
    { label: '模拟线路 mark 确认，独立更新播放状态。', event: playback('greeting', 'played', 3, { deliveryId: 'greeting-a', sealed: true, expectedDeliveryCount: 1 }) },
    { label: '长讲话第一个语义小节，不等待整段说完。', event: text('details-0', 'local', 'original', '我们一共三个人，需要一间安静的房间。', true, 1, 2500, 2, 'semantic') },
    { label: '第一个小节英译出现。', event: text('details-0', 'local', 'translation', 'There are three of us, and we need a quiet room.', true, 1, 2500, 2, 'semantic') },
    { label: '后续中文仍在识别，保留数字与否定修订。', event: text('details-1', 'local', 'original', '不是十五', false, 1, 4500, 4, 'semantic') },
    { label: '插话事件晚到；按源时间插在两个小节之间。', event: text('interruption', 'remote', 'original', 'Just to check, did you say fifteen?', true, 1, 3800, 3) },
    { label: '插话中文译文原地出现。', event: text('interruption', 'remote', 'translation', '确认一下，你说的是十五吗？', true, 1, 3800, 3) },
    { label: '第二个语义小节确定，十五修订为五十。', event: text('details-1', 'local', 'original', '不是十五美元，是五十美元以内。', true, 2, 4500, 4, 'semantic') },
    { label: '否定与数字英译配对到正确的小节。', event: text('details-1', 'local', 'translation', 'Not fifteen dollars. Our budget is under fifty dollars.', true, 1, 4500, 4, 'semantic') },
    { label: '过时的识别草稿乱序到达，已确定原文保持。', event: text('details-1', 'local', 'original', '十五美元', false, 1, 4500, 4, 'semantic') },
    { label: '第一小节音频已送出，仍待确认。', event: playback('details-0', 'sent', 1, { deliveryId: 'details-a' }) },
    { label: '第二小节译音排队，不能以文字确定冒充播放。', event: playback('details-1', 'queued', 1) },
    { label: '插话取消了排队小节；保留完整文字与取消状态。', event: playback('details-1', 'cancelled', 2) },
    { label: '第一小节线路播放确认。', event: playback('details-0', 'played', 2, { deliveryId: 'details-a', sealed: true, expectedDeliveryCount: 1 }) },
    { label: '对方后一句中文译文先到，留出英文原文位置。', event: text('confirmation', 'remote', 'translation', '没问题，我们会为你保留安静的房间。', true, 1, 6500, 5) },
    { label: '对应英文原文后到；仍是同一张逐句卡片。', event: text('confirmation', 'remote', 'original', 'No problem. We will keep a quiet room for you.', true, 1, 6500, 5) },
    { label: '安全文字显示：特殊字符按普通文字渲染。', event: text('safe-text', 'local', 'original', '备注：<img src=x onerror=alert(1)> & "窗边"。', true, 1, 7500, 6) },
    { label: '最后一句译文就地更新。', event: text('safe-text', 'local', 'translation', 'Note: a window-side table, please.', true, 1, 7500, 6) },
  ],
};

export function historyFixtureEvents(count = 30) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const role = index % 2 ? 'remote' : 'local';
    const id = `history-${index}`;
    const original = role === 'local' ? `第 ${index + 1} 句：请确认预约时间和费用。` : `Turn ${index + 1}: Your booking is confirmed for three.`;
    const translation = role === 'local' ? `Turn ${index + 1}: Please confirm the appointment time and fee.` : `第 ${index + 1} 句：已确认预约时间为三点。`;
    events.push(text(id, role, 'original', original, true, 1, 10000 + index * 2000, 10 + index));
    events.push(text(id, role, 'translation', translation, true, 1, 10000 + index * 2000, 10 + index));
  }
  return events;
}
