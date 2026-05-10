// This preload script runs inside each webview
// It intercepts browser Notification API and forwards to the main app

(function () {
  'use strict';

  const OriginalNotification = window.Notification;

  // Determine which service this webview is for based on URL
  function getService() {
    const url = window.location.href;
    if (url.includes('facebook.com') || url.includes('messenger.com')) return 'messenger';
    if (url.includes('whatsapp.com')) return 'whatsapp';
    return 'unknown';
  }

  // Override the Notification constructor
  class CustomNotification {
    constructor(title, options = {}) {
      const service = getService();

      // Send to Electron main process via IPC
      window.postMessage(
        {
          type: 'WHATSMESS_NOTIFICATION',
          service: service,
          title: title,
          body: options.body || '',
          icon: options.icon || '',
        },
        '*'
      );

      // Still create the original notification as a fallback
      // (some sites check for notification support)
      this._notification = null;
      this.title = title;
      this.body = options.body || '';
      this.icon = options.icon || '';
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;
    }

    close() {
      if (this._notification) this._notification.close();
    }

    static get permission() {
      return 'granted';
    }

    static requestPermission(callback) {
      if (callback) callback('granted');
      return Promise.resolve('granted');
    }
  }

  // Replace the native Notification
  window.Notification = CustomNotification;

  // Also watch for title changes (fallback notification detection)
  let lastTitle = document.title;
  const titleObserver = new MutationObserver(() => {
    const newTitle = document.title;
    if (newTitle !== lastTitle) {
      // Check for unread message indicators in title
      const unreadMatch = newTitle.match(/\((\d+)\)/);
      const prevMatch = lastTitle.match(/\((\d+)\)/);

      if (unreadMatch) {
        const newCount = parseInt(unreadMatch[1]);
        const prevCount = prevMatch ? parseInt(prevMatch[1]) : 0;

        if (newCount > prevCount) {
          const service = getService();
          window.postMessage(
            {
              type: 'WHATSMESS_NOTIFICATION',
              service: service,
              title: service === 'whatsapp' ? 'WhatsApp' : 'Messenger',
              body: `You have ${newCount} unread message${newCount > 1 ? 's' : ''}`,
            },
            '*'
          );
        }
      }
      lastTitle = newTitle;
    }
  });

  // Observe document title changes
  const target = document.querySelector('title');
  if (target) {
    titleObserver.observe(target, { childList: true, characterData: true, subtree: true });
  } else {
    // If title element doesn't exist yet, wait for it
    const headObserver = new MutationObserver(() => {
      const titleEl = document.querySelector('title');
      if (titleEl) {
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
        headObserver.disconnect();
      }
    });
    headObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Also use a periodic check for title changes as a robust fallback
  setInterval(() => {
    const currentTitle = document.title;
    if (currentTitle !== lastTitle) {
      const unreadMatch = currentTitle.match(/\((\d+)\)/);
      const prevMatch = lastTitle.match(/\((\d+)\)/);

      if (unreadMatch) {
        const newCount = parseInt(unreadMatch[1]);
        const prevCount = prevMatch ? parseInt(prevMatch[1]) : 0;

        if (newCount > prevCount) {
          const service = getService();
          window.postMessage(
            {
              type: 'WHATSMESS_NOTIFICATION',
              service: service,
              title: service === 'whatsapp' ? 'WhatsApp' : 'Messenger',
              body: `You have ${newCount} unread message${newCount > 1 ? 's' : ''}`,
            },
            '*'
          );
        }
      }
      lastTitle = currentTitle;
    }
  }, 2000);
})();
