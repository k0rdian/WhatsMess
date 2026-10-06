const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  showNotification: (data) => ipcRenderer.invoke('show-notification', data),
  closeNotification: (data) => ipcRenderer.invoke('close-notification', data),
  onNotificationClicked: (callback) => ipcRenderer.on('notification-clicked', (event, data) => callback(data)),
  setBadgeCount: (count) => ipcRenderer.invoke('set-badge-count', count),
  onSystemResumed: (callback) => ipcRenderer.on('system-resumed', () => callback()),
  clickInWebview: (webContentsId, x, y) => ipcRenderer.invoke('click-in-webview', { webContentsId, x, y }),
  getWebviewPreloadPath: () => ipcRenderer.invoke('get-webview-preload-path'),
  getIconUrl: () => ipcRenderer.invoke('get-icon-url'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  requestNotificationPermission: () => ipcRenderer.invoke('request-notification-permission'),
  getNotificationStatus: () => ipcRenderer.invoke('get-notification-status'),
  openNotificationSettings: () => ipcRenderer.invoke('open-notification-settings'),
});
