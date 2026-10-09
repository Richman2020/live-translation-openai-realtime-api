/** Paired conversation rendering shared by the workbench and offline replay. */
const playbackLabels = {
  unknown: '译音播放尚未关联',
  queued: '译音待播放',
  sent: '译音已送出 · 待线路确认',
  played: '线路已确认播放',
  cancelled: '译音已取消',
  unconfirmed: '译音播放未确认',
};

function node(document, tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export function renderConversationUtterance(utterance, document = globalThis.document) {
  const article = node(document, 'article', `utterance conversation-utterance ${utterance.role === 'remote' ? 'their' : 'mine'}`);
  article.dataset.utteranceId = utterance.id;
  const meta = node(document, 'div', 'utterance-meta');
  const speaker = node(document, 'strong', '', utterance.role === 'remote' ? '对方' : '你');
  const boundary = node(document, 'span', 'utterance-boundary');
  const time = node(document, 'time');
  meta.append(speaker, boundary, time);
  const bubble = node(document, 'div', 'speech-bubble');
  const parts = {};
  for (const kind of ['original', 'translation']) {
    const row = node(document, 'div', `conversation-part conversation-${kind}`);
    const heading = node(document, 'div', 'conversation-part-heading');
    const label = node(document, 'span', 'conversation-language');
    const status = node(document, 'span', 'draft-label');
    const text = node(document, 'p', `transcript-text ${kind === 'original' ? 'original-text' : 'translation-text'}`);
    heading.append(label, status); row.append(heading, text); bubble.append(row);
    parts[kind] = { row, label, status, text };
  }
  const delivery = node(document, 'p', 'utterance-playback');
  article.append(meta, bubble, delivery);
  article._conversationNodes = { boundary, time, parts, delivery };
  updateConversationUtterance(article, utterance);
  return article;
}

export function updateConversationUtterance(article, utterance) {
  const { boundary, time, parts, delivery } = article._conversationNodes;
  article.classList.toggle('conversation-unpaired', utterance.pairing === 'unpaired');
  boundary.textContent = utterance.pairing === 'unpaired' ? '未配对文字' : utterance.boundary === 'semantic' ? '语义小节' : '';
  boundary.hidden = !boundary.textContent;
  const date = new Date(utterance.at);
  time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '';
  if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
  for (const [kind, part] of Object.entries(parts)) {
    const value = utterance[kind];
    const language = kind === 'original'
      ? utterance.role === 'local' ? '中文原文' : 'English 原文'
      : utterance.role === 'local' ? 'English 译文' : '中文译文';
    part.label.textContent = language;
    part.status.textContent = value ? value.final ? '已确定' : '临时 · 更新中' : '';
    part.row.classList.toggle('conversation-draft', !!value && !value.final);
    part.text.classList.toggle('conversation-pending', !value);
    const text = value ? value.text : utterance.pairing === 'unpaired'
      ? kind === 'original' ? '当前事件未提供对应原文' : '当前事件未提供对应译文'
      : kind === 'original' ? '等待原文…' : '等待译文…';
    if (part.text.textContent !== text) part.text.textContent = text;
  }
  const status = utterance.playback?.status || 'unknown';
  delivery.dataset.playbackStatus = status;
  delivery.textContent = utterance.role === 'remote' && status === 'unknown'
    ? '英文原声直达 · 字幕不代表已播放' : playbackLabels[status] || playbackLabels.unknown;
  delivery.title = status === 'played'
    ? 'Twilio 线路 mark 返回表示相应队列已播放；不等于人耳听到、听清或准确度已验收。'
    : '文字与译音播放是独立状态，文字确定不代表译音已播放。';
}

/** Retains article nodes and the reader's visible anchor across late text and order changes. */
export function createConversationView({ container, scrollContainer, emptyNode, latestButton, historyStatus }) {
  const document = container.ownerDocument;
  const rows = new Map();
  let following = true;
  let renderedIds = [];
  const nearBottom = () => !scrollContainer || scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 64;
  function showFollowState() {
    if (latestButton) latestButton.hidden = following;
    if (historyStatus) { historyStatus.hidden = following; historyStatus.textContent = '正在阅读历史 · 新字幕继续更新'; }
  }
  function latest() {
    following = true;
    if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    showFollowState();
  }
  function onScroll() { following = nearBottom(); showFollowState(); }
  scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
  latestButton?.addEventListener('click', latest);
  function anchor() {
    if (following || !scrollContainer) return null;
    const top = scrollContainer.getBoundingClientRect().top;
    // Geometry is ordered with the DOM; binary search avoids scanning long calls.
    let left = 0; let right = renderedIds.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (rows.get(renderedIds[middle]).getBoundingClientRect().bottom > top) right = middle;
      else left = middle + 1;
    }
    if (left < renderedIds.length) {
      const id = renderedIds[left];
      return { id, offset: rows.get(id).getBoundingClientRect().top - top };
    }
    return null;
  }
  return {
    render(utterances) {
      const readingAnchor = anchor();
      const scrollTop = scrollContainer?.scrollTop || 0;
      const nextIds = new Set(utterances.map(item => item.id));
      for (const [id, row] of rows) if (!nextIds.has(id)) { row.remove(); rows.delete(id); }
      for (let index = 0; index < utterances.length; index += 1) {
        const utterance = utterances[index];
        let row = rows.get(utterance.id);
        if (!row) { row = renderConversationUtterance(utterance, document); rows.set(utterance.id, row); }
        else updateConversationUtterance(row, utterance);
        if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
      }
      renderedIds = utterances.map(item => item.id);
      if (emptyNode) emptyNode.hidden = utterances.length > 0;
      if (scrollContainer) {
        if (following) scrollContainer.scrollTop = scrollContainer.scrollHeight;
        else if (readingAnchor && rows.has(readingAnchor.id)) {
          const currentOffset = rows.get(readingAnchor.id).getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
          scrollContainer.scrollTop += currentOffset - readingAnchor.offset;
        } else scrollContainer.scrollTop = scrollTop;
      }
      showFollowState();
    },
    update(utterance) {
      const row = utterance && rows.get(utterance.id);
      if (!row) return false;
      const readingAnchor = anchor();
      updateConversationUtterance(row, utterance);
      if (scrollContainer) {
        if (following) scrollContainer.scrollTop = scrollContainer.scrollHeight;
        else if (readingAnchor) {
          const currentOffset = rows.get(readingAnchor.id).getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
          scrollContainer.scrollTop += currentOffset - readingAnchor.offset;
        }
      }
      showFollowState(); return true;
    },
    get count() { return renderedIds.length; },
    reset() { rows.clear(); renderedIds = []; container.replaceChildren(); following = true; if (emptyNode) emptyNode.hidden = false; showFollowState(); },
    latest,
    dispose() { scrollContainer?.removeEventListener('scroll', onScroll); latestButton?.removeEventListener('click', latest); rows.clear(); },
    get following() { return following; },
  };
}
