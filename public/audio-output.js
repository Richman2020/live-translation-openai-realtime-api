// Device identifiers stay in this page's memory. No capture or provider calls are needed.
export function createAudioOutput({ onChange = () => {}, createAudio = () => new Audio(), testUrl = '/assets/speaker-test.wav', timeoutMs = 8000 } = {}) {
  let helper = null;
  let binding = 0;
  let deviceListener = null;
  let activeTest = null;
  let activeSelection = null;
  let state = { supported: false, devices: [], selectedId: '', status: 'idle', message: '可播放测试音，检查系统默认输出。' };
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
  const snapshot = () => ({ ...state, devices: state.devices.map(device => ({ ...device })) });
  const publish = update => {
    state = { ...state, ...update };
    try { onChange(snapshot()); } catch { /* Rendering must not break audio cleanup. */ }
    return snapshot();
  };
  function read() {
    const supported = helper?.isOutputSelectionSupported === true
      && typeof helper?.speakerDevices?.get === 'function'
      && typeof helper?.speakerDevices?.set === 'function';
    let devices = []; let activeIds = [];
    try {
      devices = Array.from(helper?.availableOutputDevices?.values?.() || [])
        .filter(device => device && typeof device.deviceId === 'string')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: typeof device.label === 'string' && device.label.trim() ? device.label.trim()
            : device.deviceId === 'default' ? '系统默认输出'
              : device.deviceId === 'communications' ? '默认通信输出' : `音频输出 ${index + 1}`,
        }));
      activeIds = Array.from(helper?.speakerDevices?.get?.() || [])
        .map(device => device?.deviceId).filter(id => typeof id === 'string');
    } catch { /* Missing enumeration remains visible as unavailable, never a fabricated headset. */ }
    return { supported, devices, activeIds, selectedId: supported && activeIds.length === 1 ? activeIds[0] : '' };
  }
  function applyRead(value) {
    const { supported, devices, selectedId } = value;
    state = { ...state, supported, devices, selectedId };
  }
  function refresh() {
    const value = read();
    applyRead(value);
    if (activeTest && (activeTest.supported !== value.supported || (value.supported
      && (value.activeIds.length !== 1 || value.selectedId !== activeTest.deviceId
        || !value.devices.some(device => device.deviceId === activeTest.deviceId))))) {
      activeTest.finish(false, '输出设备已改变，测试已停止，请重新测试。');
    }
    return publish({});
  }
  function cancelTest() {
    activeTest?.finish(false, '测试已停止。');
  }
  function bind(nextHelper) {
    ++binding;
    activeTest?.finish(false, '测试已停止。');
    activeSelection?.retire();
    if (helper && deviceListener) {
      if (typeof helper.off === 'function') helper.off('deviceChange', deviceListener);
      else helper.removeListener?.('deviceChange', deviceListener);
    }
    helper = nextHelper || null;
    const version = binding;
    deviceListener = () => { if (binding === version) refresh(); };
    helper?.on?.('deviceChange', deviceListener);
    const value = read();
    applyRead(value);
    return publish({ status: 'idle', message: value.supported
      ? '请选择耳机输出，并播放测试音确认。'
      : '当前浏览器不能选择输出设备，可测试系统默认输出。' });
  }
  async function select(deviceId) {
    if (state.status === 'selecting') return false;
    cancelTest();
    const value = read();
    applyRead(value);
    if (!value.supported) { publish({ message: '当前浏览器不能选择输出设备，请在系统声音设置中选择。' }); return false; }
    if (typeof deviceId !== 'string' || !value.devices.some(device => device.deviceId === deviceId)) {
      publish({ message: '这个输出设备已不可用，请重新选择。' }); return false;
    }
    const version = binding; const owner = helper;
    return new Promise(resolve => {
      let retired = false; let returned = false;
      const returnOnce = value => { if (!returned) { returned = true; resolve(value); } };
      const operation = { retire() {
        retired = true; clearTimeout(timer);
        if (activeSelection === operation) activeSelection = null;
        returnOnce(false);
      } };
      // SDK set() cannot be cancelled. Keep this helper locked after a timeout so
      // a late switch cannot override another selection or a new call's route.
      const timer = setTimeout(() => {
        if (retired || binding !== version || activeSelection !== operation) return;
        publish({ message: '输出切换超时。请关闭通话再重新开启，然后选择耳机。' });
        returnOnce(false);
      }, duration);
      function complete(ok) {
        clearTimeout(timer);
        if (retired || version !== binding || activeSelection !== operation) { returnOnce(false); return; }
        activeSelection = null;
        const actual = read(); applyRead(actual);
        const confirmed = ok && actual.activeIds.length === 1 && actual.selectedId === deviceId
          && actual.devices.some(device => device.deviceId === deviceId);
        publish({ status: 'idle', message: !ok ? '输出切换失败，请检查设备连接或浏览器声音权限。'
          : confirmed ? '输出已切换，请播放测试音确认。' : '未确认输出切换，请重新选择后测试。' });
        returnOnce(confirmed);
      }
      activeSelection = operation;
      publish({ status: 'selecting', message: '正在切换音频输出。' });
      if (retired) return;
      try { Promise.resolve(owner.speakerDevices.set(deviceId)).then(() => complete(true), () => complete(false)); }
      catch { complete(false); }
    });
  }
  function test() {
    if (state.status === 'selecting') { publish({ message: '正在切换输出，请稍后测试。' }); return Promise.resolve(false); }
    cancelTest();
    const value = read();
    applyRead(value);
    if (value.supported && (value.activeIds.length !== 1 || !value.devices.some(device => device.deviceId === value.selectedId))) {
      publish({ message: '请先选择一个可用的耳机输出，再播放测试音。' }); return Promise.resolve(false);
    }
    const version = binding;
    let audio;
    try { audio = createAudio(); } catch {
      publish({ status: 'idle', message: '浏览器无法创建测试播放器。' }); return Promise.resolve(false);
    }
    return new Promise(resolve => {
      let settled = false;
      const ended = () => finish(true, '测试音播放流程已完成，请自行确认耳机中是否听到。');
      const failed = () => finish(false, '测试音无法播放，请检查页面声音权限和本地音频文件。');
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener?.('ended', ended);
        audio.removeEventListener?.('error', failed);
        try { audio.pause(); } catch { /* Always release the source too. */ }
        try { audio.srcObject = null; } catch { /* Older audio elements may not support srcObject. */ }
        try { audio.removeAttribute('src'); audio.load(); } catch { /* Resource already released. */ }
      };
      function finish(ok, message) {
        if (settled) return;
        settled = true;
        cleanup();
        if (activeTest === operation) activeTest = null;
        if (version === binding) publish({ status: 'idle', message });
        resolve(ok);
      }
      const operation = { finish, supported: value.supported, deviceId: value.selectedId };
      const timer = setTimeout(() => finish(false, '测试音播放超时，已停止。请检查输出设备后重试。'), duration);
      activeTest = operation;
      publish({ status: 'testing', message: '正在准备测试音。' });
      if (settled) return;
      try {
        audio.addEventListener('ended', ended);
        audio.addEventListener('error', failed);
        audio.preload = 'auto'; audio.loop = false; audio.volume = 0.7; audio.src = testUrl;
        if (value.supported && typeof audio.setSinkId !== 'function') {
          finish(false, '浏览器无法将测试音送往已选设备，请检查音频输出支持。'); return;
        }
        // Match the SDK's confirmed route. Do not silently test another device after a routing failure.
        const routed = value.supported ? audio.setSinkId(value.selectedId) : Promise.resolve();
        Promise.resolve(routed).then(() => {
          if (settled || version !== binding) return;
          return audio.play();
        }).then(() => {
          if (!settled && version === binding) publish({ message: '测试音正在播放，请确认耳机中的声音。' });
        }).catch(error => {
          finish(false, error?.name === 'NotAllowedError'
            ? '浏览器阻止了声音播放，请允许页面声音后再次点击测试。'
            : '测试音播放失败，请检查输出设备和页面声音权限。');
        });
      } catch { failed(); }
    });
  }
  return { bind, refresh, select, test, cancelTest, get snapshot() { return snapshot(); } };
}
