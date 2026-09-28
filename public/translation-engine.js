const engineLabels = Object.freeze({ legacy: '当前版本', continuous: '连续翻译实验版', 'continuous-nano': '本人声线实验版', 'nano-captions': '英文原声＋中文字幕' });

export function usesNanoVoice(value) {
  return value === 'continuous-nano' || value === 'nano-captions';
}

export function translationEngineLabel(value) {
  return engineLabels[value] || '版本未记录';
}

// Selection is per page, never a persisted default or a mid-call engine change.
export function createTranslationEngineSelection() {
  let selected = 'legacy';
  let available = ['legacy'];
  let sessionEngine = null;
  let locked = true;
  return {
    update({ engines, session, locked: nextLocked }) {
      available = Array.isArray(engines) ? [...new Set(engines.filter(value => Object.hasOwn(engineLabels, value)))] : ['legacy'];
      if (!available.includes(selected)) selected = available.includes('legacy') ? 'legacy' : available[0] || 'legacy';
      sessionEngine = session ? (Object.hasOwn(engineLabels, session.translationEngine) ? session.translationEngine : 'legacy') : null;
      locked = Boolean(nextLocked || session);
    },
    select(value) {
      if (locked || !available.includes(value)) return false;
      selected = value;
      return true;
    },
    get snapshot() {
      return { selected, value: sessionEngine || selected, sessionEngine, locked, available: [...available] };
    },
  };
}

export function translationReadiness(session) {
  if (session?.status !== 'active') return null;
  const ownVoice = usesNanoVoice(session.translationEngine);
  const captions = session.translationEngine === 'nano-captions';
  if (session.translationReady !== true) {
    if (ownVoice) return { ready: false, label: '电话已接通 · 本人声线准备中', instruction: '电话已接通，正在准备翻译和本人声线；请等就绪后说话。' };
    return { ready: false, label: '电话已接通 · 翻译准备中', instruction: '电话已接通，正在准备翻译；请等就绪后说话。' };
  }
  if (captions) return { ready: true, label: '本人声线与英文原声已就绪', instruction: '你说中文，对方听本人英文本音；你直接听英文原声，并查看中英字幕。字幕状态单独显示；请用有明确句尾的短句。' };
  if (ownVoice) return { ready: true, label: '本人声线翻译已就绪', instruction: '可以开始说话；请用有明确句尾的短句，本人声线会在分句合成后播放。' };
  return { ready: true, label: '翻译已就绪', instruction: '翻译已就绪，可以开始说话。' };
}
