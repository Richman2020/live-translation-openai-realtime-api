const engineLabels = Object.freeze({ legacy: '当前版本', continuous: '连续翻译实验版', 'continuous-nano': '本人声线实验版', 'nano-captions': '英文原声＋中文字幕', 'continuous-captions': '连续直出＋中文字幕（测试候选）', 'pocket-captions': 'Pocket 美式男声＋中文字幕（测试候选）', 'pocket-prefix': 'Pocket 边讲边播（新测试版）' });

export function usesNanoVoice(value) {
  return value === 'continuous-nano' || value === 'nano-captions';
}

export function usesPocketVoice(value) {
  return value === 'pocket-captions' || value === 'pocket-prefix';
}

export function usesLocalVoice(value) {
  return usesNanoVoice(value) || usesPocketVoice(value);
}

export function usesRemoteCaptions(value) {
  return value === 'nano-captions' || value === 'continuous-captions' || usesPocketVoice(value);
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
  const pocketVoice = usesPocketVoice(session.translationEngine);
  const captions = usesRemoteCaptions(session.translationEngine);
  if (session.translationReady !== true) {
    if (pocketVoice) return { ready: false, label: '电话已接通 · Pocket 男声准备中', instruction: '电话已接通，正在准备翻译和 Pocket 固定男声；请等就绪后说话。' };
    if (ownVoice) return { ready: false, label: '电话已接通 · 本人声线准备中', instruction: '电话已接通，正在准备翻译和本人声线；请等就绪后说话。' };
    return { ready: false, label: '电话已接通 · 翻译准备中', instruction: '电话已接通，正在准备翻译；请等就绪后说话。' };
  }
  if (session.translationEngine === 'pocket-prefix') return { ready: true, label: 'Pocket 边讲边播与英文原声已就绪', instruction: '你说中文，已确认的短词组依次生成 Michael 固定美式男声，继续接收后文；你直接听英文原声，并查看中英字幕。短词组衔接与实际起声等待需要本轮测试，尚未验证 0.5–1 秒。本测试接通后最多 5 分钟自动结束。' };
  if (pocketVoice) return { ready: true, label: 'Pocket 男声与英文原声已就绪', instruction: '你说中文，对方听 Michael 固定美式男声；完整英文小节确认后开始流式播放，后文继续翻译。你直接听英文原声，并查看中英字幕；字幕状态单独显示。本测试接通后最多 5 分钟自动结束。' };
  if (captions && ownVoice) return { ready: true, label: '本人声线与英文原声已就绪', instruction: '你说中文，对方听本人英文本音；你直接听英文原声，并查看中英字幕。字幕状态单独显示；请用有明确句尾的短句。' };
  if (captions) return { ready: true, label: '连续直出与英文原声已就绪', instruction: '你说中文，对方听模型声音的连续英文译音；你直接听英文原声，并查看中英字幕。字幕状态单独显示；请测试开始出声、持续跟随和句尾等待。' };
  if (ownVoice) return { ready: true, label: '本人声线翻译已就绪', instruction: '可以开始说话；请用有明确句尾的短句，本人声线会在分句合成后播放。' };
  return { ready: true, label: '翻译已就绪', instruction: '翻译已就绪，可以开始说话。' };
}
