const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  showNotification: (data) => ipcRenderer.invoke('show-notification', data),
  getWebviewPreloadPath: () => ipcRenderer.invoke('get-webview-preload-path'),
  getIconUrl: () => ipcRenderer.invoke('get-icon-url'),
  onSwitchToService: (callback) => ipcRenderer.on('switch-to-service', (event, service) => callback(service)),
  requestNotificationPermission: () => ipcRenderer.invoke('request-notification-permission'),
  getNotificationStatus: () => ipcRenderer.invoke('get-notification-status'),
  openNotificationSettings: () => ipcRenderer.invoke('open-notification-settings'),
});
