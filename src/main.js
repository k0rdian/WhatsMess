const { app, BrowserWindow, ipcMain, Notification, session, nativeImage, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Simple JSON settings store
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaults = {
  integrations: { messenger: true, whatsapp: true },
  notifications: { messenger: true, whatsapp: true },
  setupDone: false,
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
    }
  } catch (e) { /* ignore */ }
  return { ...defaults };
}

function saveSettingsToFile(data) {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

let settingsData = loadSettings();
let mainWindow = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'ikona.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'WhatsMess',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
    },
    backgroundColor: '#0f0f1a',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Keep app running when window is closed (minimize to dock)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

// Handle permissions for ALL sessions (including webview partitions)
app.on('web-contents-created', (event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['notifications', 'media', 'mediaKeySystem', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowedPermissions.includes(permission));
  });

  // Set user agent for all webcontents
  contents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });
});

// IPC Handlers
ipcMain.handle('get-settings', () => {
  return {
    integrations: settingsData.integrations,
    notifications: settingsData.notifications,
    setupDone: settingsData.setupDone,
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  if (settings.integrations) settingsData.integrations = settings.integrations;
  if (settings.notifications) settingsData.notifications = settings.notifications;
  if (settings.setupDone !== undefined) settingsData.setupDone = settings.setupDone;
  saveSettingsToFile(settingsData);
  return { success: true };
});

ipcMain.handle('show-notification', (event, { title, body, service }) => {
  const notificationsEnabled = settingsData.notifications[service];
  if (!notificationsEnabled) return { shown: false };

  const iconPath = path.join(__dirname, 'assets', 'ikona.png');
  const notification = new Notification({
    title: title || service,
    body: body || 'New message',
    icon: iconPath,
    silent: false,
  });

  notification.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('switch-to-service', service);
    }
  });

  notification.show();
  return { shown: true };
});

// Request macOS notification permission by firing a test notification
ipcMain.handle('request-notification-permission', async () => {
  if (process.platform === 'darwin') {
    // On macOS, showing a Notification for the first time triggers the system permission dialog
    const testNotification = new Notification({
      title: 'WhatsMess',
      body: 'Powiadomienia zostały włączone! 🎉',
      silent: true,
    });
    testNotification.show();

    // Short delay to let the system process
    await new Promise(resolve => setTimeout(resolve, 500));
    testNotification.close();

    return {
      supported: Notification.isSupported(),
      triggered: true,
    };
  } else {
    return {
      supported: Notification.isSupported(),
      triggered: true,
    };
  }
});

// Check current notification permission status
ipcMain.handle('get-notification-status', () => {
  const supported = Notification.isSupported();
  let systemStatus = 'unknown';

  if (process.platform === 'darwin') {
    // Check macOS notification permission
    systemStatus = systemPreferences.getNotificationState?.() || 'unknown';
  }

  return {
    supported,
    systemStatus,
    platform: process.platform,
  };
});

// Open system notification preferences
ipcMain.handle('open-notification-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings');
  }
  return { opened: true };
});

// Return the absolute path to the webview preload script
ipcMain.handle('get-webview-preload-path', () => {
  return path.join(__dirname, 'webview-preload.js');
});

// Return the icon path as a file:// URL for the renderer
ipcMain.handle('get-icon-url', () => {
  return 'file://' + path.join(__dirname, 'assets', 'ikona.png').replace(/\\/g, '/');
});

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
