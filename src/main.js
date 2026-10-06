const { app, BrowserWindow, ipcMain, Notification, session, nativeImage, systemPreferences, shell, powerMonitor, webContents } = require('electron');
const path = require('path');
const fs = require('fs');

// Simple JSON settings store
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaults = {
  integrations: { messenger: true, whatsapp: true },
  notifications: { messenger: true, whatsapp: true },
  notificationPreview: true,
  unifiedInbox: false,
  setupDone: false,
};

const SERVICE_NAMES = { messenger: 'Messenger', whatsapp: 'WhatsApp' };
// WHATSMESS_DEBUG=1 npm start - prints how messages are detected in the webviews
const DEBUG = process.env.WHATSMESS_DEBUG === '1';

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

  // Keep the web apps' timers running while the window is hidden in the Dock,
  // so new messages are noticed (and notified) right away
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    webPreferences.backgroundThrottling = false;
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

  if (DEBUG && contents.getType() === 'webview') {
    contents.on('console-message', (event) => {
      if (String(event.message).startsWith('[WhatsMess]')) console.log(event.message);
    });
  }

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
    notificationPreview: settingsData.notificationPreview,
    unifiedInbox: settingsData.unifiedInbox,
    setupDone: settingsData.setupDone,
    debug: DEBUG,
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  if (settings.integrations) settingsData.integrations = settings.integrations;
  if (settings.notifications) settingsData.notifications = settings.notifications;
  if (settings.notificationPreview !== undefined) settingsData.notificationPreview = !!settings.notificationPreview;
  if (settings.unifiedInbox !== undefined) settingsData.unifiedInbox = !!settings.unifiedInbox;
  if (settings.setupDone !== undefined) settingsData.setupDone = settings.setupDone;
  saveSettingsToFile(settingsData);
  return { success: true };
});

// ===== NOTIFICATIONS =====
// Live native notifications, keyed by "<service>:<id>". Holding a reference is
// required - otherwise Electron garbage-collects them and 'click' never fires.
const activeNotifications = new Map();
const MAX_ACTIVE_NOTIFICATIONS = 50;
// "<service>#<tag>" -> key of the notification currently shown for that tag
const notificationTags = new Map();
// Notifications the page closed before they were shown (icon still loading)
const closedBeforeShown = new Set();
// Latest request per id/tag: a slow avatar must not let an older message
// replace a newer one
const latestRequests = new Map();
let requestSeq = 0;
const MAX_ICON_BYTES = 5 * 1024 * 1024;
// Avatars come from these CDNs; other URLs from the page are not fetched
const ICON_HOSTS = /(^|\.)(fbcdn\.net|facebook\.com|whatsapp\.net|whatsapp\.com)$/;

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // bidi marks used by WhatsApp
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function limitSize(collection, maxSize) {
  while (collection.size > maxSize) {
    collection.delete(collection.keys().next().value);
  }
}

function closeNotification(key) {
  const notification = activeNotifications.get(key);
  if (!notification) return false;
  activeNotifications.delete(key);
  notification.close();
  return true;
}

// Avatar of the sender: data: URLs come straight from the page (blob: avatars are
// converted there), https: URLs are fetched with the service's own session.
async function loadNotificationIcon(icon, service) {
  try {
    if (typeof icon !== 'string' || !icon) return null;
    if (icon.startsWith('data:image/')) {
      if (icon.length > 2 * 1024 * 1024) return null;
      const image = nativeImage.createFromDataURL(icon);
      return image.isEmpty() ? null : image;
    }
    if (icon.startsWith('https://') && ICON_HOSTS.test(new URL(icon).hostname)) {
      // Avatar URLs are signed CDN links: no cookies needed
      const ses = session.fromPartition(`persist:${service}`);
      const response = await ses.fetch(icon, { credentials: 'omit', signal: AbortSignal.timeout(3000) });
      if (!response.ok || !/^image\/(png|jpeg)/.test(response.headers.get('content-type') || '')) return null;
      if (Number(response.headers.get('content-length')) > MAX_ICON_BYTES) return null;
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_ICON_BYTES) return null;
        chunks.push(chunk);
      }
      const image = nativeImage.createFromBuffer(Buffer.concat(chunks));
      return image.isEmpty() ? null : image;
    }
  } catch (e) { /* fall back to the app icon */ }
  return null;
}

ipcMain.handle('show-notification', async (event, data = {}) => {
  const service = SERVICE_NAMES[data.service] ? data.service : null;
  if (!service || !settingsData.notifications[service]) return { shown: false };

  const serviceName = SERVICE_NAMES[service];
  const sender = cleanText(data.title, 200);
  const message = cleanText(data.body, 1000);
  const showPreview = settingsData.notificationPreview !== false;

  const options = {
    title: sender || serviceName,
    body: showPreview ? (message || 'Nowa wiadomość') : 'Nowa wiadomość',
    silent: !!data.silent,
  };
  if (sender && sender !== serviceName) options.subtitle = serviceName;
  const key = `${service}:${cleanText(data.id, 100)}`;
  const tag = cleanText(data.tag, 200);
  const tagKey = tag ? `${service}#${tag}` : null;
  const seq = ++requestSeq;
  for (const requestKey of [key, tagKey]) {
    if (requestKey) latestRequests.set(requestKey, seq);
  }
  limitSize(latestRequests, MAX_ACTIVE_NOTIFICATIONS * 2);

  const avatar = showPreview ? await loadNotificationIcon(data.icon, service) : null;
  options.icon = avatar || path.join(__dirname, 'assets', 'ikona.png');
  if (closedBeforeShown.delete(key)) return { shown: false };
  if ([key, tagKey].some((requestKey) => requestKey && latestRequests.get(requestKey) > seq)) {
    return { shown: false };
  }

  // A newer notification replaces the one with the same id or tag
  closeNotification(key);
  if (tagKey) {
    const previousKey = notificationTags.get(tagKey);
    if (previousKey) closeNotification(previousKey);
    notificationTags.set(tagKey, key);
    limitSize(notificationTags, MAX_ACTIVE_NOTIFICATIONS);
  }

  const notification = new Notification(options);
  const forget = () => {
    if (activeNotifications.get(key) === notification) activeNotifications.delete(key);
  };
  notification.on('click', () => {
    forget();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('notification-clicked', { service, id: data.id });
    }
  });
  notification.on('close', forget);
  notification.on('failed', forget);

  activeNotifications.set(key, notification);
  limitSize(activeNotifications, MAX_ACTIVE_NOTIFICATIONS);

  notification.show();
  return { shown: true };
});

// The page closed its notification (e.g. the chat was read in the web app)
ipcMain.handle('close-notification', (event, { service, id } = {}) => {
  const key = `${service}:${cleanText(id, 100)}`;
  const closed = closeNotification(key);
  if (!closed) {
    closedBeforeShown.add(key);
    limitSize(closedBeforeShown, MAX_ACTIVE_NOTIFICATIONS);
  }
  return { closed };
});

// A real mouse click inside one of our webviews (used to open a conversation:
// WhatsApp does not react to synthetic DOM clicks)
ipcMain.handle('click-in-webview', (event, { webContentsId, x, y } = {}) => {
  const guest = webContents.fromId(Number(webContentsId));
  if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== event.sender) return { clicked: false };
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0)) return { clicked: false };
  guest.sendInputEvent({ type: 'mouseMove', x, y });
  guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  return { clicked: true };
});

// Total unread count shown on the Dock icon
ipcMain.handle('set-badge-count', (event, count) => {
  const total = Math.max(0, parseInt(count, 10) || 0);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(total > 0 ? String(total) : '');
  }
  return { success: true };
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
app.whenReady().then(() => {
  createWindow();
  // After waking from sleep the web apps catch up and replay older messages;
  // the webviews stay quiet for a moment
  powerMonitor.on('resume', () => {
    mainWindow?.webContents.send('system-resumed');
  });
});

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
