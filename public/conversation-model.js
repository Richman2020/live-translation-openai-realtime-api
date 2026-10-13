/** Shared offline conversation reducer. Text correspondence must be explicit. */
const roles = new Set(['local', 'remote']);
const statuses = new Set(['queued', 'sent', 'played', 'cancelled', 'unconfirmed']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const validRevision = value => Number.isSafeInteger(value) && value >= 1;
const sourceTime = value => typeof value === 'number' ? value : Date.parse(value);
// Text evidence only, matching the speaker registry; not an acoustic noise test.
const hasSourceText = text => typeof text === 'string' && /[\p{L}\p{N}]/u.test(text);
const withdrawnSource = row => row?.original?.final === true && !hasSourceText(row.original.text);
const turnMetadata = value => value.speakerTurnId === undefined && value.speakerTurnSequence === undefined && value.speakerTurnRevision === undefined && value.speakerSourceSequence === undefined
  || validId(value.speakerTurnId) && Number.isSafeInteger(value.speakerTurnSequence) && value.speakerTurnSequence > 0
    && (value.speakerTurnRevision === undefined || validRevision(value.speakerTurnRevision))
    && (value.speakerSourceSequence === undefined || validRevision(value.speakerSourceSequence));
const compareSources = (a, b) => a.at - b.at || (a.speakerSourceSequence ?? a.sequence) - (b.speakerSourceSequence ?? b.sequence) || a.id.localeCompare(b.id);

/** Older providers pair only IDs that explicitly share the same source turn. */
export function adaptTranscriptEvent(value, options = {}) {
  if (!value || !validId(value.id) || !roles.has(value.role)
    || !['original', 'translation'].includes(value.kind) || typeof value.text !== 'string'
    || !turnMetadata(value)
    || (value.conversationVisible === false && !['native_output', 'native_input'].includes(value.captionSource))) return null;
  const native = ['native_output', 'native_input'].includes(value.captionSource);
  const nativeOutput = value.captionSource === 'native_output';
  if (native && (value.role !== 'local' || value.kind !== (nativeOutput ? 'translation' : 'original')
    || value.pairing !== 'unpaired' || value.boundary !== 'diagnostic'
    || value.audioCorrespondence !== (nativeOutput ? 'generated_only' : 'none'))) return null;
  if (value.captionSource !== undefined && !['native_output', 'native_input', 'independent_text'].includes(value.captionSource)) return null;
  if (value.captionSource === 'independent_text' && value.audioCorrespondence !== 'none') return null;
  const sessionId = value.sessionId || options.sessionId;
  if (!validId(sessionId)) return null;
  const match = /^(local|remote):(original|translation):([A-Za-z0-9_-]{1,256}):(0|[1-9]\d*)$/.exec(value.id);
  const paired = !!(match && match[1] === value.role && match[2] === value.kind);
  const at = sourceTime(value.at);
  if (!Number.isFinite(at)) return null;
  return {
    type: 'text', sessionId,
    utteranceId: native ? `${nativeOutput ? 'native' : 'native-input'}:${value.id}` : value.utteranceId || (paired ? `${value.role}:${match[3]}:${match[4]}` : `unpaired:${value.id}`),
    role: value.role, kind: value.kind, text: value.text,
    final: value.final === true, revision: value.revision ?? options.revision ?? 1,
    at, sequence: value.sequence ?? options.sequence ?? 0,
    pairing: value.pairing || (paired ? 'explicit' : 'unpaired'),
    boundary: value.boundary || (paired ? 'utterance' : 'diagnostic'),
    ...(value.captionSource ? { captionSource: value.captionSource, audioCorrespondence: value.audioCorrespondence } : {}),
    ...(value.speakerTurnId !== undefined ? { speakerTurnId: value.speakerTurnId, speakerTurnSequence: value.speakerTurnSequence, speakerTurnRevision: value.speakerTurnRevision, speakerSourceSequence: value.speakerSourceSequence } : {}),
    ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}),
    ...(value.displayText !== undefined ? { displayText: value.displayText, normalization: value.normalization } : {}),
  };
}

/** Speaker blocks are a display projection. Individual source IDs and revisions
 * stay intact; provider finals and semantic sections never create speaker turns. */
export function groupConversationUtterances(utterances) {
  const ordered = utterances.filter(row => !withdrawnSource(row)).sort(compareSources);
  const blocks = new Map();
  const owners = new Map();
  let previousSource = null;
  const make = (id, row, unassigned = false) => {
    let block = blocks.get(id);
    if (!block) {
      block = { id, role: row.role, at: row.at, sequence: row.speakerTurnSequence ?? row.sequence,
        speakerTurnSequence: row.speakerTurnSequence,
        sourceUnassigned: unassigned, utterances: [] };
      blocks.set(id, block);
    }
    return block;
  };
  for (const row of ordered) {
    const source = hasSourceText(row.original?.text);
    if (row.speakerTurnId !== undefined) {
      const block = make(`turn:${row.role}:${row.speakerTurnId}`, row);
      owners.set(row.id, block);
      if (source) previousSource = block;
    } else if (source) {
      const block = previousSource?.role === row.role ? previousSource : make(`source:${row.id}`, row);
      owners.set(row.id, block); previousSource = block;
    }
  }
  for (const row of ordered) {
    let block = owners.get(row.id);
    // A different utterance's same role/time cannot prove source association.
    // Keep each unbound excerpt separate; late output never seizes an A-B-A run.
    if (!block) block = make(`unassigned:${row.id}`, row, true);
    block.utterances.push(row);
  }
  return [...blocks.values()].filter(block => block.utterances.length)
    .sort((a, b) => Number(a.sourceUnassigned) - Number(b.sourceUnassigned)
      || (a.speakerTurnSequence !== undefined && b.speakerTurnSequence !== undefined ? a.speakerTurnSequence - b.speakerTurnSequence : a.at - b.at)
      || a.sequence - b.sequence || a.id.localeCompare(b.id));
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
  const visible = row => !!row && !withdrawnSource(row) && [row.original, row.translation]
    .some(part => part && (part.text.trim() || !part.final));
  function rowFor(event) {
    let row = utterances.get(event.utteranceId);
    if (row && row.role !== event.role) return null;
    if (row && event.type === 'text' && (row.captionSource !== event.captionSource || row.audioCorrespondence !== event.audioCorrespondence)) return null;
    if (!row) {
      row = {
        id: event.utteranceId, sessionId, role: event.role,
        at: event.at, sequence: event.sequence ?? 0,
        pairing: event.pairing || 'unpaired', boundary: event.boundary || 'diagnostic',
        ...(event.captionSource ? { captionSource: event.captionSource, audioCorrespondence: event.audioCorrespondence } : {}),
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
        || !['utterance', 'semantic', 'diagnostic'].includes(event.boundary)
        || !turnMetadata(event) || (event.sourceRevision !== undefined && !validRevision(event.sourceRevision))
        || (event.displayText !== undefined && (event.kind !== 'original' || typeof event.displayText !== 'string' || event.displayText.length > 32000))
        || (event.normalization !== undefined && (event.normalization !== 'conservative' || event.displayText === undefined))) return false;
      if (event.captionSource !== undefined && !['native_output', 'native_input', 'independent_text'].includes(event.captionSource)) return false;
      if (['native_output', 'native_input'].includes(event.captionSource) && (event.role !== 'local'
        || event.kind !== (event.captionSource === 'native_output' ? 'translation' : 'original')
        || event.pairing !== 'unpaired' || event.boundary !== 'diagnostic'
        || event.audioCorrespondence !== (event.captionSource === 'native_output' ? 'generated_only' : 'none'))) return false;
      if (event.captionSource === 'independent_text' && event.audioCorrespondence !== 'none') return false;
      const row = rowFor(event);
      if (!row) return false;
      const part = row[event.kind];
      if (event.sourceRevision === undefined && (part?.sourceRevision !== undefined
        || event.kind === 'translation' && row.original?.sourceRevision !== undefined)) return false;
      // A versioned binding cannot be erased by an unversioned/partial replay.
      if (row.speakerTurnRevision !== undefined && (event.speakerTurnId === undefined
        || event.speakerTurnSequence === undefined || event.speakerTurnRevision === undefined
        || row.speakerSourceSequence !== undefined && event.speakerSourceSequence === undefined)) return false;
      if (event.speakerTurnRevision !== undefined && row.speakerTurnRevision !== undefined && event.speakerTurnRevision < row.speakerTurnRevision) return false;
      const bindingChanged = event.speakerTurnId !== undefined && (row.speakerTurnId !== event.speakerTurnId || row.speakerTurnSequence !== event.speakerTurnSequence || row.speakerSourceSequence !== event.speakerSourceSequence);
      if (bindingChanged && row.speakerTurnId !== undefined && !(event.speakerTurnRevision > (row.speakerTurnRevision || 0))) return false;
      const rebinding = event.speakerTurnRevision > (row.speakerTurnRevision || 0) && part
        && event.revision === part.revision && event.text === part.text && event.final === part.final
        && event.sourceRevision === part.sourceRevision && event.displayText === part.displayText && event.normalization === part.normalization;
      const sourceAdvanced = event.sourceRevision !== undefined && part?.sourceRevision !== undefined && event.sourceRevision > part.sourceRevision;
      if (part && !rebinding && (event.revision <= part.revision || (part.final && part.text.trim() && !event.final && !sourceAdvanced))) return false;
      if (event.sourceRevision !== undefined && (event.sourceRevision < (part?.sourceRevision || 0)
        || event.kind === 'translation' && event.sourceRevision < (row.original?.sourceRevision || 0)
        || event.kind === 'original' && event.sourceRevision === part?.sourceRevision && event.text !== part.text)) return false;
      const wasVisible = visible(row);
      const hadSource = hasSourceText(row.original?.text);
      row[event.kind] = { text: event.text, final: event.final, revision: event.revision,
        ...(event.sourceRevision !== undefined ? { sourceRevision: event.sourceRevision } : {}),
        ...(event.displayText !== undefined ? { displayText: event.displayText, normalization: event.normalization } : {}) };
      if (event.speakerTurnId !== undefined) {
        if (bindingChanged) { orderDirty = true; changedOrder = true; }
        row.speakerTurnId = event.speakerTurnId; row.speakerTurnSequence = event.speakerTurnSequence;
        row.speakerTurnRevision = event.speakerTurnRevision;
        row.speakerSourceSequence = event.speakerSourceSequence;
      }
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
      if (hadSource !== hasSourceText(row.original?.text)) changedOrder = true;
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
    if (['native_output', 'native_input', 'independent_text'].includes(utterances.get(event.utteranceId)?.captionSource)) return false;
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
        .sort(compareSources);
      orderDirty = false;
    }
    return orderedRows.filter(visible).map(rowSnapshot);
  }
  function rowSnapshot(row) {
    if (!row.snapshot) row.snapshot = Object.freeze({
      id: row.id, sessionId, role: row.role, at: row.at, sequence: row.sequence,
      pairing: row.pairing, boundary: row.boundary,
      ...(row.captionSource ? { captionSource: row.captionSource, audioCorrespondence: row.audioCorrespondence } : {}),
      ...(row.speakerTurnId !== undefined ? { speakerTurnId: row.speakerTurnId, speakerTurnSequence: row.speakerTurnSequence, speakerTurnRevision: row.speakerTurnRevision, speakerSourceSequence: row.speakerSourceSequence } : {}),
      ...(withdrawnSource(row) ? { sourceWithdrawn: true } : {}),
      original: row.original && Object.freeze({ ...row.original }),
      translation: row.translation && row.translation.sourceRevision === row.original?.sourceRevision
        ? Object.freeze({ ...row.translation }) : null,
      ...(row.translation && row.translation.sourceRevision !== row.original?.sourceRevision ? { translationPending: true } : {}),
      playback: Object.freeze(playbackFor(row)),
    });
    return row.snapshot;
  }
  function getUtterance(id) {
    const row = utterances.get(id);
    // Keep withdrawn raw/version/binding evidence available without listing a card.
    return visible(row) || withdrawnSource(row) ? rowSnapshot(row) : null;
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
