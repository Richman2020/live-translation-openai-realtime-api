/** Shared offline conversation reducer. Text correspondence must be explicit. */
const roles = new Set(['local', 'remote']);
const statuses = new Set(['queued', 'sent', 'played', 'cancelled', 'unconfirmed']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const validRevision = value => Number.isSafeInteger(value) && value >= 1;
const sourceTime = value => typeof value === 'number' ? value : Date.parse(value);

/** Older providers pair only IDs that explicitly share the same source turn. */
export function adaptTranscriptEvent(value, options = {}) {
  if (!value || !validId(value.id) || !roles.has(value.role)
    || !['original', 'translation'].includes(value.kind) || typeof value.text !== 'string'
    || value.conversationVisible === false) return null;
  const sessionId = value.sessionId || options.sessionId;
  if (!validId(sessionId)) return null;
  const match = /^(local|remote):(original|translation):([A-Za-z0-9_-]{1,256}):(0|[1-9]\d*)$/.exec(value.id);
  const paired = !!(match && match[1] === value.role && match[2] === value.kind);
  const at = sourceTime(value.at);
  if (!Number.isFinite(at)) return null;
  return {
    type: 'text', sessionId,
    utteranceId: value.utteranceId || (paired ? `${value.role}:${match[3]}:${match[4]}` : `unpaired:${value.id}`),
    role: value.role, kind: value.kind, text: value.text,
    final: value.final === true, revision: value.revision ?? options.revision ?? 1,
    at, sequence: value.sequence ?? options.sequence ?? 0,
    pairing: value.pairing || (paired ? 'explicit' : 'unpaired'),
    boundary: value.boundary || (paired ? 'utterance' : 'diagnostic'),
  };
}

/** Display segmentation only: never align two languages by punctuation count. */
export function splitSemanticText(text) {
  if (typeof text !== 'string' || !text.length) return [];
  const pieces = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const decimal = /\d/.test(text[index - 1] || '') && /\d/.test(text[index + 1] || '');
    const sentence = /[。！？；!?;\n]/u.test(character)
      || (character === '.' && !decimal && (index === text.length - 1 || /\s/u.test(text[index + 1])));
    const clause = index - start >= 100 && /[，,]/u.test(character) && !decimal;
    if (sentence || clause) {
      pieces.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

export function createConversationModel(options) {
  const sessionId = typeof options === 'string' ? options : options?.sessionId;
  if (!validId(sessionId)) throw new Error('INVALID_CONVERSATION_SESSION');
  const utterances = new Map();
  let receiptSequence = 0;
  let orderDirty = true;
  let orderedRows = [];
  let changedOrder = false;
  let lastChange = null;
  const visible = row => !!row && [row.original, row.translation]
    .some(part => part && (part.text.trim() || !part.final));
  function rowFor(event) {
    let row = utterances.get(event.utteranceId);
    if (row && row.role !== event.role) return null;
    if (!row) {
      row = {
        id: event.utteranceId, sessionId, role: event.role,
        at: event.at, sequence: event.sequence ?? 0,
        pairing: event.pairing || 'unpaired', boundary: event.boundary || 'diagnostic',
        original: null, translation: null, deliveries: new Map(),
        sealed: false, expectedDeliveryCount: null, lifecycle: null,
      };
      utterances.set(row.id, row);
      orderDirty = true;
      changedOrder = true;
    }
    return row;
  }
  function apply(event) {
    changedOrder = false;
    if (!event || event.sessionId !== sessionId || !validId(event.utteranceId)
      || !roles.has(event.role) || !validRevision(event.revision)
      || !Number.isFinite(event.at) || !Number.isSafeInteger(event.sequence ?? 0)
      || (event.sequence ?? 0) < 0) return false;
    if (event.type === 'text') {
      if (!['original', 'translation'].includes(event.kind) || typeof event.text !== 'string'
        || event.text.length > 32000 || typeof event.final !== 'boolean'
        || !['explicit', 'unpaired'].includes(event.pairing)
        || !['utterance', 'semantic', 'diagnostic'].includes(event.boundary)) return false;
      const row = rowFor(event);
      if (!row) return false;
      const part = row[event.kind];
      if (part && (event.revision <= part.revision || (part.final && part.text.trim() && !event.final))) return false;
      const wasVisible = visible(row);
      row[event.kind] = { text: event.text, final: event.final, revision: event.revision };
      row.snapshot = null;
      // Provider source time is preserved across late translations. A source
      // event can correct a translation-only placeholder's ordering.
      if (!Number.isFinite(row.at) || event.kind === 'original' || !row.original) {
        const at = event.kind === 'original' && !part ? event.at : Math.min(row.at, event.at);
        const sequence = Math.min(row.sequence, event.sequence ?? 0);
        if (row.at !== at || row.sequence !== sequence) { orderDirty = true; changedOrder = true; }
        row.at = at;
        row.sequence = sequence;
      }
      row.pairing = event.pairing;
      row.boundary = event.boundary;
      if (wasVisible !== visible(row)) changedOrder = true;
      lastChange = { id: row.id, orderChanged: changedOrder, event: Object.freeze({ ...event }) };
      return true;
    }
    if (event.type !== 'playback' || !statuses.has(event.status)
      || !['none', 'transport', 'twilio_mark'].includes(event.evidence)
      || (event.status === 'played' && event.evidence !== 'twilio_mark')
      || (event.deliveryId !== undefined && !validId(event.deliveryId))
      || (event.sealed === true && (!Number.isSafeInteger(event.expectedDeliveryCount)
        || event.expectedDeliveryCount < 1 || event.expectedDeliveryCount > 100000))) return false;
    const row = rowFor(event);
    if (!row) return false;
    const previous = event.deliveryId ? row.deliveries.get(event.deliveryId) : row.lifecycle;
    if (previous && (event.revision <= previous.revision
      || ['played', 'cancelled', 'unconfirmed'].includes(previous.status))) return false;
    // Reordered receipts cannot downgrade a delivery that was already sent.
    if (previous?.status === 'sent' && event.status === 'queued') return false;
    const next = { status: event.status, evidence: event.evidence, revision: event.revision };
    if (event.deliveryId) row.deliveries.set(event.deliveryId, next);
    else row.lifecycle = next;
    if (event.sealed === true) {
      row.sealed = true;
      row.expectedDeliveryCount = Math.max(row.expectedDeliveryCount || 0, event.expectedDeliveryCount);
    }
    row.snapshot = null;
    lastChange = { id: row.id, orderChanged: changedOrder, event: Object.freeze({ ...event }) };
    return true;
  }
  function playbackFor(row) {
    const deliveries = [...row.deliveries.values()];
    let status = row.lifecycle?.status || 'unknown';
    let evidence = row.lifecycle?.evidence || 'none';
    if (deliveries.length) {
      if (deliveries.some(item => item.status === 'cancelled')) status = 'cancelled';
      else if (deliveries.some(item => item.status === 'unconfirmed')) status = 'unconfirmed';
      else if (row.sealed && deliveries.length === row.expectedDeliveryCount
        && deliveries.every(item => item.status === 'played')) status = 'played';
      else if (deliveries.some(item => item.status === 'queued')) status = 'queued';
      else status = 'sent';
      evidence = status === 'played' ? 'twilio_mark' : 'transport';
    }
    if (row.lifecycle?.status === 'cancelled' && !['played', 'unconfirmed'].includes(status)) status = 'cancelled';
    return { status, evidence, sealed: row.sealed, deliveryCount: deliveries.length,
      playedCount: deliveries.filter(item => item.status === 'played').length };
  }
  function getUtterances() {
    if (orderDirty) {
      orderedRows = [...utterances.values()]
        .sort((a, b) => a.at - b.at || a.sequence - b.sequence || a.id.localeCompare(b.id));
      orderDirty = false;
    }
    return orderedRows.filter(visible).map(rowSnapshot);
  }
  function rowSnapshot(row) {
    if (!row.snapshot) row.snapshot = Object.freeze({
      id: row.id, sessionId, role: row.role, at: row.at, sequence: row.sequence,
      pairing: row.pairing, boundary: row.boundary,
      original: row.original && Object.freeze({ ...row.original }),
      translation: row.translation && Object.freeze({ ...row.translation }),
      playback: Object.freeze(playbackFor(row)),
    });
    return row.snapshot;
  }
  function getUtterance(id) {
    const row = utterances.get(id);
    return visible(row) ? rowSnapshot(row) : null;
  }
  function applyTranscript(value) {
    receiptSequence += 1;
    const event = adaptTranscriptEvent(value, { sessionId, sequence: receiptSequence });
    if (!event) return false;
    if (value.revision === undefined) event.revision = (utterances.get(event.utteranceId)?.[event.kind]?.revision ?? 0) + 1;
    return apply(event);
  }
  return { apply, applyTranscript, getUtterances, getUtterance,
    getLastChange: () => lastChange && { ...lastChange }, snapshot: getUtterances };
}
