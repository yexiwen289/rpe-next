const { contextBridge, ipcRenderer } = require('electron');
// 只暴露白名单内的运行时环境变量（密钥来自本地 .env，不写入源码）。
contextBridge.exposeInMainWorld('rpenRuntimeEnv', {
  RPE_GLM_API_KEY: process.env.RPE_GLM_API_KEY || '',
  RPE_SENSENOVA_API_KEY: process.env.RPE_SENSENOVA_API_KEY || '',
});
contextBridge.exposeInMainWorld('rpenAgentCapture', { version: 1, capture: rect => ipcRenderer.invoke('rpen-agent-capture', rect) });
contextBridge.exposeInMainWorld('rpenNetease', {
  version: 1,
  call: (action, payload = {}) => ipcRenderer.invoke('rpen-netease', { ...payload, action }),
});
contextBridge.exposeInMainWorld('rpenAudioStorage', {
  version: 1,
  call: (action, options = {}) => ipcRenderer.invoke('rpen-audio-storage', { ...options, action }),
  onProgress: callback => { const handler = (event, value) => callback(value); ipcRenderer.on('rpen-audio-storage-progress', handler); return () => ipcRenderer.removeListener('rpen-audio-storage-progress', handler); }
});
contextBridge.exposeInMainWorld('rpenAgentWorkspace', {
  version: 1,
  call: (id, workspace, action, args) => ipcRenderer.invoke('rpen-agent-workspace', { id, workspace, action, args }),
  cancel: id => ipcRenderer.send('rpen-agent-workspace-cancel', id),
});
contextBridge.exposeInMainWorld('rpenAudioMapper', {
  version: 1,
  call: (action, ...args) => ipcRenderer.invoke('rpen-audio-mapper', { action, args }),
  onProgress: callback => { const handler = (event, value) => callback(value); ipcRenderer.on('rpen-audio-mapper-progress', handler); return () => ipcRenderer.removeListener('rpen-audio-mapper-progress', handler); },
});
contextBridge.exposeInMainWorld('rpenAudioOnsets', {
  version: 1,
  call: (action, ...args) => ipcRenderer.invoke('rpen-audio-onsets', { action, args }),
  onProgress: callback => { const handler = (event, value) => callback(value); ipcRenderer.on('rpen-audio-onsets-progress', handler); return () => ipcRenderer.removeListener('rpen-audio-onsets-progress', handler); },
});
contextBridge.exposeInMainWorld('rpenAudioSeparation', {
  version: 1,
  call: (action, ...args) => ipcRenderer.invoke('rpen-audio-separation', { action, args }),
  onProgress: callback => { const handler = (event, value) => callback(value); ipcRenderer.on('rpen-audio-separation-progress', handler); return () => ipcRenderer.removeListener('rpen-audio-separation-progress', handler); },
});
contextBridge.exposeInMainWorld('rpenAgentCredentials', {
  version: 1,
  read: provider => ipcRenderer.invoke('rpen-agent-credentials', { action: 'read', provider }),
  write: (provider, key) => ipcRenderer.invoke('rpen-agent-credentials', { action: 'write', provider, key }),
});
contextBridge.exposeInMainWorld('rpenAgentNetwork', {
  request: (id, path, key, body, baseUrl, timeoutMs) => ipcRenderer.invoke('rpen-agent-request', { id, path, key, body, baseUrl, timeoutMs }),
  cancel: id => ipcRenderer.send('rpen-agent-cancel', id),
  onChunk: (id, callback) => {
    const handler = (event, value) => { if (value.id === id) callback(value.chunk); };
    ipcRenderer.on('rpen-agent-chunk', handler); return () => ipcRenderer.removeListener('rpen-agent-chunk', handler);
  },
});

contextBridge.exposeInMainWorld('rpenWindowFullscreen', {
  version: 1,
  set: value => ipcRenderer.invoke('rpen-window-fullscreen', { action: 'set', value }),
  toggle: () => ipcRenderer.invoke('rpen-window-fullscreen', { action: 'toggle' }),
  get: () => ipcRenderer.invoke('rpen-window-fullscreen', { action: 'get' }),
  onState: callback => {
    const handler = (event, value) => callback(value);
    ipcRenderer.on('rpen-window-fullscreen-state', handler);
    return () => ipcRenderer.removeListener('rpen-window-fullscreen-state', handler);
  },
});

contextBridge.exposeInMainWorld('rpenDesktopStorage', {
  version: 1,
  call: (method, ...args) => ipcRenderer.invoke('rpen-native-storage', { method, args }),
});
