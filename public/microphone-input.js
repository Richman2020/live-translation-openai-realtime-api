// This only enumerates devices. Selecting or refreshing never opens a microphone.
export function createMicrophoneInput({ mediaDevices, onChange = () => {} } = {}) {
  let sequence = 0; let disposed = false; let selectedLabel = '';
  let state = { devices: [], selectedId: '', selectedAvailable: true, status: 'idle', message: '使用系统默认麦克风；可选择耳机上的麦克风。' };
  const snapshot = () => ({ ...state, devices: state.devices.map(device => ({ ...device })) });
  const publish = update => {
    state = { ...state, ...update };
    try { onChange(snapshot()); } catch { /* UI errors must not open a capture stream. */ }
  };
  const unavailable = () => Object.assign(new Error('选定的麦克风已不可用，请连接设备或重新选择；本次不会改用其他麦克风。'), { code: 'MICROPHONE_SELECTED_UNAVAILABLE' });
  async function refresh() {
    if (disposed) return false;
    const version = ++sequence;
    publish({ status: 'refreshing', message: '正在读取麦克风设备列表。' });
    try {
      if (typeof mediaDevices?.enumerateDevices !== 'function') throw new Error();
      const list = await mediaDevices.enumerateDevices();
      if (disposed || version !== sequence) return false;
      const devices = Array.from(list || []).filter(device => device.kind === 'audioinput'
        && typeof device.deviceId === 'string' && device.deviceId && device.deviceId !== 'default')
        .map((device, index) => ({ deviceId: device.deviceId, label: typeof device.label === 'string' && device.label.trim()
          ? device.label.trim() : `麦克风 ${index + 1}（浏览器未提供名称）`, available: true }));
      const selected = devices.find(device => device.deviceId === state.selectedId);
      const available = !state.selectedId || Boolean(selected);
      if (selected) selectedLabel = selected.label;
      if (!available) devices.push({ deviceId: state.selectedId, label: `${selectedLabel || '已选麦克风'}（已不可用）`, available: false });
      publish({ devices, selectedAvailable: available, status: 'idle', message: !available ? unavailable().message
        : '设备列表已更新。选择不会启用麦克风；授权后看不到设备时，可再刷新。' });
      return true;
    } catch {
      if (disposed || version !== sequence) return false;
      publish({ status: 'idle', selectedAvailable: !state.selectedId, message: '无法读取麦克风列表。请检查浏览器权限后刷新；本次没有启用麦克风。' });
      return false;
    }
  }
  function select(deviceId) {
    if (disposed || state.status === 'refreshing') return false;
    const selected = state.devices.find(device => device.deviceId === deviceId && device.available);
    if (deviceId !== '' && !selected) return false;
    selectedLabel = selected?.label || '';
    publish({ selectedId: deviceId, selectedAvailable: true, message: deviceId
      ? `已选择：${selectedLabel}。拨号或接听时才启用。` : '使用系统默认麦克风；通话时会显示实际采音设备。' });
    return true;
  }
  async function constraints() {
    if (disposed) throw unavailable();
    const selectedId = state.selectedId;
    if (!selectedId) return { audio: true };
    if (!await refresh() || disposed || state.selectedId !== selectedId || !state.selectedAvailable) throw unavailable();
    return { audio: { deviceId: { exact: selectedId } } };
  }
  const changed = () => { refresh(); };
  mediaDevices?.addEventListener?.('devicechange', changed);
  return {
    refresh, select, constraints,
    get snapshot() { return snapshot(); },
    dispose() { disposed = true; ++sequence; mediaDevices?.removeEventListener?.('devicechange', changed); },
  };
}
