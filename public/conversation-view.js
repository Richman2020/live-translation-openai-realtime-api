/** Paired conversation rendering shared by the workbench and offline replay. */
import { groupConversationUtterances } from './conversation-model.js';
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

export function renderConversationUtterance(utterance, document = globalThis.document, segment = false) {
  const article = node(document, segment ? 'section' : 'article', `${segment ? 'conversation-segment' : 'utterance conversation-utterance'} ${utterance.role === 'remote' ? 'their' : 'mine'}`);
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
    let raw = null;
    if (kind === 'original') {
      const details = node(document, 'details', 'conversation-raw');
      const summary = node(document, 'summary', '', '核对原始识别');
      const rawText = node(document, 'p', 'conversation-raw-text');
      details.append(summary, rawText); row.append(details); raw = { details, text: rawText };
    }
    parts[kind] = { row, label, status, text, raw };
  }
  const delivery = node(document, 'p', 'utterance-playback');
  if (!segment) article.append(meta);
  article.append(bubble, delivery);
  article._conversationNodes = { boundary, time, parts, delivery };
  updateConversationUtterance(article, utterance);
  return article;
}

export function updateConversationUtterance(article, utterance) {
  const { boundary, time, parts, delivery } = article._conversationNodes;
  const nativeOutput = utterance.captionSource === 'native_output';
  const nativeInput = utterance.captionSource === 'native_input';
  const native = nativeOutput || nativeInput;
  const reference = utterance.captionSource === 'independent_text';
  if (utterance.captionSource) article.dataset.captionSource = utterance.captionSource;
  article.classList.toggle('conversation-native-output', native);
  article.classList.toggle('conversation-unpaired', utterance.pairing === 'unpaired');
  boundary.textContent = native ? `连续文字流 · 未与${nativeOutput ? '中文' : '英文'}逐句关联` : utterance.pairing === 'unpaired' ? '未配对文字' : utterance.boundary === 'semantic' ? '语义小节' : '';
  boundary.hidden = !boundary.textContent;
  const date = new Date(utterance.at);
  time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '';
  if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
  for (const [kind, part] of Object.entries(parts)) {
    const value = utterance[kind];
    const language = kind === 'original'
      ? utterance.role === 'local' ? '中文原文' : 'English 原文'
      : utterance.role === 'local' ? 'English 译文' : '中文译文';
    const hiddenNativePart = native && kind === (nativeOutput ? 'original' : 'translation');
    const organized = kind === 'original' && value?.displayText !== undefined && value.displayText !== value.text;
    part.row.hidden = hiddenNativePart;
    part.label.textContent = organized ? `${utterance.role === 'local' ? '中文' : 'English'} 整理显示`
      : native ? nativeOutput ? '原生英文译音文字' : '原生中文识别文字' : reference && kind === 'translation' ? 'English 参考翻译' : language;
    part.status.textContent = value ? native ? '持续更新' : value.final ? '已确定' : '临时 · 更新中' : '';
    part.row.classList.toggle('conversation-draft', !!value && !value.final);
    part.text.classList.toggle('conversation-pending', !value);
    const text = hiddenNativePart ? '' : value ? organized ? value.displayText : value.text
      : kind === 'translation' && utterance.translationPending ? '译文待对应原文更新后显示…' : utterance.pairing === 'unpaired'
      ? kind === 'original' ? '当前事件未提供对应原文' : '当前事件未提供对应译文'
      : kind === 'original' ? '等待原文…' : '等待译文…';
    if (part.text.textContent !== text) part.text.textContent = text;
    if (part.raw) { part.raw.details.hidden = !organized; part.raw.text.textContent = value?.text || ''; }
  }
  const status = utterance.playback?.status || 'unknown';
  delivery.dataset.playbackStatus = status;
  delivery.textContent = nativeOutput ? '英文译音生成文字 · 未与原文配对 · 播放未确认'
    : nativeInput ? '中文识别文字 · 未与译音配对 · 不代表译音播放'
    : reference ? '参考翻译 · 未关联实际译音播放'
    : utterance.role === 'remote' && status === 'unknown'
    ? '英文原声直达 · 字幕不代表已播放' : playbackLabels[status] || playbackLabels.unknown;
  delivery.title = status === 'played'
    ? 'Twilio 线路 mark 返回表示相应队列已播放；不等于人耳听到、听清或准确度已验收。'
    : '文字与译音播放是独立状态，文字确定不代表译音已播放。';
}

/** Retains article nodes and the reader's visible anchor across late text and order changes. */
export function createConversationView({ container, scrollContainer, emptyNode, latestButton, historyStatus,
  groupSpeakers = container.ownerDocument.documentElement?.dataset?.phoneSurface === 'controlled' }) {
  const document = container.ownerDocument;
  const rows = new Map();
  const blocks = new Map();
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
      if (!groupSpeakers) {
        for (let index = 0; index < utterances.length; index += 1) {
          const utterance = utterances[index];
          let row = rows.get(utterance.id);
          if (!row) { row = renderConversationUtterance(utterance, document); rows.set(utterance.id, row); }
          else updateConversationUtterance(row, utterance);
          if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
        }
        renderedIds = utterances.map(item => item.id);
      } else {
        const grouped = groupConversationUtterances(utterances);
        const nextBlocks = new Set(grouped.map(block => block.id));
        for (let index = 0; index < grouped.length; index += 1) {
          const block = grouped[index];
          let element = blocks.get(block.id);
          if (!element) {
            element = node(document, block.sourceUnassigned ? 'div' : 'article', `utterance ${block.sourceUnassigned ? 'conversation-auxiliary' : 'conversation-block'} ${block.role === 'remote' ? 'their' : 'mine'}`);
            element.dataset.speakerBlockId = block.id;
            const meta = node(document, 'div', block.sourceUnassigned ? 'conversation-auxiliary-label' : 'utterance-meta');
            meta.append(node(document, 'strong', '', block.sourceUnassigned ? '未关联来源轮次的文字' : block.role === 'remote' ? '对方' : '你'));
            element._blockTime = node(document, 'time'); meta.append(element._blockTime);
            element._blockBody = node(document, 'div', 'speech-bubble conversation-block-body');
            element.append(meta, element._blockBody); blocks.set(block.id, element);
          }
          const date = new Date(block.at);
          element._blockTime.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '';
          for (let segmentIndex = 0; segmentIndex < block.utterances.length; segmentIndex += 1) {
            const utterance = block.utterances[segmentIndex];
            let row = rows.get(utterance.id);
            if (!row) { row = renderConversationUtterance(utterance, document, true); rows.set(utterance.id, row); }
            else updateConversationUtterance(row, utterance);
            if (element._blockBody.children[segmentIndex] !== row) element._blockBody.insertBefore(row, element._blockBody.children[segmentIndex] || null);
          }
          if (container.children[index] !== element) container.insertBefore(element, container.children[index] || null);
        }
        for (const [id, element] of blocks) if (!nextBlocks.has(id)) { element.remove(); blocks.delete(id); }
        renderedIds = grouped.flatMap(block => block.utterances.map(item => item.id));
      }
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
      if (utterance?.sourceWithdrawn) return false;
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
    reset() { rows.clear(); blocks.clear(); renderedIds = []; container.replaceChildren(); following = true; if (emptyNode) emptyNode.hidden = false; showFollowState(); },
    latest,
    dispose() { scrollContainer?.removeEventListener('scroll', onScroll); latestButton?.removeEventListener('click', latest); rows.clear(); blocks.clear(); },
    get following() { return following; },
  };
}
