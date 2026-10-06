// This preload script runs inside each webview (in Electron's isolated world).
// Messenger and WhatsApp have no public API, so new messages are detected in
// three layers, from the most to the least precise:
//   1. 'page'     - the web app's own notifications (Notification API and
//                   ServiceWorkerRegistration.showNotification) are intercepted
//                   in the page's main world: sender, text and avatar
//   2. 'chatlist' - the conversation list is watched; when an unread
//                   conversation gets a new last-message preview, it is reported
//   3. 'title'    - the unread counter in the page title went up, but nothing
//                   more specific is known: generic "new message" notification
// Notifications are sent to the host page with ipcRenderer.sendToHost().

const { contextBridge, ipcRenderer, webFrame } = require('electron');

(function () {
  'use strict';

  const SERVICE = getService();
  if (!SERVICE) return;

  // Time for the page to report a message itself before a fallback is used
  const FALLBACK_DELAY = 2500;
  // Changes right after loading are the initial state, not new messages
  const STARTUP_GRACE = 10000;
  // Messenger replays old notifications while loading; WhatsApp does not
  const PAGE_STARTUP_GRACE = SERVICE === 'whatsapp' ? 3000 : STARTUP_GRACE;
  const RESUME_GRACE = 15000;
  const startedAt = Date.now();
  let notificationSeq = 0;

  function getService() {
    const host = window.location.hostname;
    if (host.endsWith('facebook.com') || host.endsWith('messenger.com')) return 'messenger';
    if (host.endsWith('whatsapp.com')) return 'whatsapp';
    return null;
  }

  // Diagnostics, enabled with WHATSMESS_DEBUG=1 (printed in the terminal)
  let debug = false;
  function debugLog(message, details) {
    if (!debug) return;
    console.log(`[WhatsMess] ${SERVICE}: ${message}${details === undefined ? '' : ' ' + JSON.stringify(details)}`);
  }

  function sendNotification(data) {
    debugLog(`notify (${data.source})`, { title: data.title, body: data.body, hasIcon: !!data.icon });
    ipcRenderer.sendToHost('notification', {
      id: data.id || `${data.source}-${++notificationSeq}`,
      tag: String(data.tag || '').slice(0, 200),
      title: String(data.title || '').slice(0, 200),
      body: String(data.body || '').slice(0, 1000),
      icon: typeof data.icon === 'string' ? data.icon : '',
      silent: !!data.silent,
      source: data.source,
    });
  }

  // ===== LAYER 1: intercept the page's own notifications =====
  // Runs in the page's main world, before any page script. It is serialized,
  // so it must not reference anything from this file.
  function installPageHooks(report, reportClose) {
    const registry = new Map();
    // Unique per page load, so clicks on notifications from before a reload
    // never reach a different notification
    const idPrefix = `page-${Date.now().toString(36)}-`;
    let seq = 0;

    function absoluteUrl(url) {
      try { return url ? new URL(String(url), location.href).href : ''; } catch (e) { return ''; }
    }

    // blob: avatars only exist inside the page, so turn them into data: URLs here.
    // fetch() may be blocked by the page's CSP (connect-src), drawing the image
    // works whenever the page can display it.
    function blobToDataUrl(url) {
      return fetch(url)
        .then((response) => response.blob())
        .then((blob) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }));
    }

    function imageToDataUrl(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight, 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        image.onerror = reject;
        image.src = url;
      });
    }

    // The main process only decodes PNG and JPEG, so in-page images (blob:,
    // other data: formats) are redrawn as a small PNG
    function iconToDataUrl(url) {
      if (!url.startsWith('blob:') && !/^data:(?!image\/(png|jpeg))/.test(url)) return Promise.resolve(url);
      return Promise.race([
        imageToDataUrl(url).catch(() => blobToDataUrl(url)),
        new Promise((resolve) => setTimeout(() => resolve(''), 1500)),
      ]).catch(() => '');
    }

    // Messenger sometimes passes React-like objects ({props: {content: [...]}})
    // instead of strings
    function toText(value, depth) {
      depth = depth || 0;
      if (value == null || depth > 20) return '';
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.map((item) => toText(item, depth)).join('');
      if (typeof value !== 'object') return '';
      if (value.props) return toText(value.props.content ?? value.props.children, depth + 1);
      // Facebook's translated strings (fbt) and String objects have their own toString
      if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
        const text = String(value);
        return text === '[object Object]' ? '' : text;
      }
      return '';
    }

    // Messenger conversation id from the notification's tag/data, if any
    function findThreadId(options) {
      try {
        const text = JSON.stringify([options.tag, options.data, options.actions]);
        const match = text && text.match(/\/t\/(\d+)/);
        return match ? match[1] : '';
      } catch (e) {
        return '';
      }
    }

    function capture(title, options, target) {
      options = options || {};
      const id = idPrefix + (++seq);
      if (target) {
        registry.set(id, target);
        if (registry.size > 50) registry.delete(registry.keys().next().value);
      }
      const data = {
        id,
        title: toText(title),
        body: toText(options.body),
        tag: toText(options.tag),
        silent: !!options.silent,
        threadId: findThreadId(options),
      };
      iconToDataUrl(absoluteUrl(options.icon)).then((icon) => {
        data.icon = icon;
        report(data);
      });
      return id;
    }

    class WhatsMessNotification extends EventTarget {
      constructor(title, options) {
        super();
        if (arguments.length === 0) throw new TypeError("Failed to construct 'Notification': 1 argument required.");
        options = options || {};
        this.title = toText(title);
        this.body = toText(options.body);
        this.tag = toText(options.tag);
        this.icon = options.icon || '';
        this.image = options.image || '';
        this.badge = options.badge || '';
        this.data = options.data ?? null;
        this.dir = options.dir || 'auto';
        this.lang = options.lang || '';
        this.silent = !!options.silent;
        this.renotify = !!options.renotify;
        this.requireInteraction = !!options.requireInteraction;
        this.actions = [];
        this.vibrate = [];
        this.timestamp = Date.now();
        // on<type> handlers run during dispatch, like native event handlers
        for (const type of ['click', 'show', 'close', 'error']) {
          this[`on${type}`] = null;
          this.addEventListener(type, (event) => {
            const handler = this[`on${type}`];
            if (typeof handler === 'function' && handler.call(this, event) === false) event.preventDefault();
          });
        }
        this._closed = false;
        this._id = capture(title, options, this);
        setTimeout(() => this._fire('show'), 0);
      }

      _fire(type) {
        this.dispatchEvent(new Event(type, { cancelable: true }));
      }

      close() {
        if (this._closed) return;
        this._closed = true;
        registry.delete(this._id);
        reportClose(this._id);
        setTimeout(() => this._fire('close'), 0);
      }

      static get permission() { return 'granted'; }
      // 0 keeps WhatsApp's incoming-call alerts on this page-level path,
      // where clicking them can be routed back to the page
      static get maxActions() { return 0; }
      static requestPermission(callback) {
        if (typeof callback === 'function') callback('granted');
        return Promise.resolve('granted');
      }
    }

    Object.defineProperty(window, 'Notification', {
      value: WhatsMessNotification,
      writable: true,
      configurable: true,
    });

    // Notifications shown through the service worker registration from the page
    if (window.ServiceWorkerRegistration) {
      const proto = ServiceWorkerRegistration.prototype;
      proto.showNotification = function (title, options) {
        capture(title, options, null);
        return Promise.resolve();
      };
      proto.getNotifications = function () {
        return Promise.resolve([]);
      };
    }

    // An inactive tab is only transparent and may still hold keyboard focus.
    // Web apps skip notifications while they have focus (WhatsApp checks
    // document.hasFocus()), so report no focus for a tab that is not shown.
    // (document.hidden/visibilityState are locked by Electron in webviews.)
    let backgroundTab = false;
    const nativeHasFocus = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function () {
      return backgroundTab ? false : nativeHasFocus.call(this);
    };

    return {
      setBackground(value) {
        value = !!value;
        if (value === backgroundTab) return;
        backgroundTab = value;
        if (value) window.dispatchEvent(new FocusEvent('blur'));
        else if (nativeHasFocus.call(document)) window.dispatchEvent(new FocusEvent('focus'));
      },
      // The user clicked our native notification: run the page's own click
      // handler, which opens the right conversation
      click(id) {
        const notification = registry.get(id);
        if (!notification) return false;
        registry.delete(id);
        notification._fire('click');
        return true;
      },
    };
  }

  const recentPageNotifications = []; // forwarded page notifications: { title, body, at }
  const pageThreadIds = new Map(); // notification id -> conversation id
  let lastPageNotificationAt = 0; // any page notification, also filtered ones
  let pageNotificationsWork = false; // the page itself reported a message
  // After loading and after waking from sleep the pages replay older
  // notifications and their lists and counters resync: stay quiet meanwhile
  let pageQuietUntil = startedAt + PAGE_STARTUP_GRACE;
  let titleQuietUntil = startedAt + STARTUP_GRACE;

  function onPageNotification(data) {
    debugLog('page notification', { title: data.title, body: data.body, tag: data.tag, threadId: data.threadId, icon: String(data.icon || '').slice(0, 40) });
    const now = Date.now();
    lastPageNotificationAt = now;
    if (data.threadId) {
      pageThreadIds.set(data.id, data.threadId);
      if (pageThreadIds.size > 50) pageThreadIds.delete(pageThreadIds.keys().next().value);
    }
    if (now < pageQuietUntil) return debugLog('skipped: page is loading or catching up');
    if (SERVICE === 'messenger') {
      // facebook.com also reports likes, comments etc. under the title "Facebook"
      if (normalize(data.title) === 'facebook') return debugLog('skipped: Facebook activity');
      // Muted conversations can still produce notifications
      if (findChats(data.title).some((chat) => chat.muted)) return debugLog('skipped: muted conversation');
    }
    pageNotificationsWork = true;
    recentPageNotifications.push({ title: data.title, body: data.body, at: now });
    while (recentPageNotifications.length && now - recentPageNotifications[0].at > 60000) {
      recentPageNotifications.shift();
    }
    sendNotification({ ...data, source: 'page' });
  }

  let pageHooks = null;
  try {
    pageHooks = contextBridge.executeInMainWorld({
      func: installPageHooks,
      args: [
        onPageNotification,
        (id) => ipcRenderer.sendToHost('notification-close', { id }),
      ],
    });
  } catch (e) {
    console.warn('[WhatsMess] Could not hook page notifications:', e);
  }

  ipcRenderer.on('notification-click', (event, id) => {
    // Run the click as a user gesture, so the page may focus and navigate
    webFrame.executeJavaScript('void 0', true).catch(() => {}).then(() => {
      try {
        if (pageHooks && pageHooks.click(id)) return;
      } catch (e) {
        console.warn('[WhatsMess] Could not forward notification click:', e);
      }
      const chatKey = String(id).startsWith('chatlist-') ? String(id).slice('chatlist-'.length) : pageThreadIds.get(id);
      if (chatKey) openChat(chatKey);
    });
  });

  // Messenger's own switch for desktop notifications (kept if the user changed it)
  if (SERVICE === 'messenger') {
    try {
      if (localStorage.getItem('_cs_desktopNotifsEnabled') === null) {
        localStorage.setItem('_cs_desktopNotifsEnabled', JSON.stringify({ __t: Date.now(), __v: true }));
      }
    } catch (e) { /* storage unavailable */ }
  }

  // The Mac woke up: what arrives next is mostly catching up
  ipcRenderer.on('system-resumed', () => {
    const until = Date.now() + RESUME_GRACE;
    pageQuietUntil = Math.max(pageQuietUntil, until);
    titleQuietUntil = Math.max(titleQuietUntil, until);
    if (chatListQuietUntil !== null) chatListQuietUntil = Math.max(chatListQuietUntil, until);
    debugLog('system resumed: catching up quietly');
  });

  ipcRenderer.on('set-debug', (event, value) => {
    debug = !!value;
    debugLog('diagnostics on', { pageHooks: !!pageHooks, url: location.href });
  });

  // The host tells us whether this service's tab is currently shown
  ipcRenderer.on('set-background', (event, value) => {
    try {
      if (pageHooks) pageHooks.setBackground(value);
    } catch (e) {
      console.warn('[WhatsMess] Could not update tab visibility:', e);
    }
  });

  // ===== LAYER 2: watch the conversation list =====
  // Selectors are deliberately loose (roles, links, attributes rather than
  // generated class names), so they survive most redesigns.
  const UNREAD_MARKER = /unread message|nieprzeczytan\S* wiadomo|mark as read|oznacz jako przeczytan/i;
  const READ_MARKER = /mark as unread|oznacz jako nieprzeczytan/i;
  // Only the indicator itself ("pisze…", "Jan is typing...", "nagrywa audio…")
  const TYPING_PREVIEW = /(^|[\s:])(pisze|piszą|nagrywa(ją)?|typing|recording)(\s\S+)?\s*(…|\.\.\.)[\s\u200e\u200f]*\d*$/i;
  // Relative times and clock times shown next to a conversation
  const TIMESTAMP = /^(\d{1,2}\s?(s|sek|m|min|h|g|godz|d|dn|dni|w|tydz|tyg|mies|mo|r|y|lat)\.?|\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?|now|teraz|just now|przed chwilą|wczoraj|yesterday)$/i;
  const MAX_CHATLIST_NOTIFICATIONS_PER_SCAN = 3;

  function isUnreadLabel(text) {
    return !!text && UNREAD_MARKER.test(text) && !READ_MARKER.test(text);
  }

  // Visible text of an element; emoji drawn as <img alt="..."> are kept,
  // timestamps in <abbr> are skipped
  function textOf(element) {
    let text = '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => (node.nodeName === 'ABBR' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
      else if (node.tagName === 'IMG' && node.alt && node.width <= 32) text += node.alt;
    }
    return text.replace(/\s+/g, ' ').replace(/^[·\s]+|[·\s]+$/g, '');
  }

  // A real mouse click on the element, delivered by the main process (pages can
  // tell synthetic DOM events apart). Coordinates are in the page's viewport.
  function clickLikeUser(element) {
    let rect = element.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      element.scrollIntoView({ block: 'center' });
      rect = element.getBoundingClientRect();
    }
    const zoom = webFrame.getZoomFactor();
    ipcRenderer.sendToHost('click-at', {
      x: Math.round((rect.left + Math.min(rect.width / 2, 40)) * zoom),
      y: Math.round((rect.top + rect.height / 2) * zoom),
    });
  }

  // Elements matching the selector that are not nested in another match
  function outermost(root, selector) {
    return [...root.querySelectorAll(selector)].filter((element) => {
      const parent = element.parentElement && element.parentElement.closest(selector);
      return !parent || !root.contains(parent);
    });
  }

  function isBold(element) {
    return !!element && parseInt(getComputedStyle(element).fontWeight, 10) >= 600;
  }

  // The biggest picture in the row (Messenger draws avatars as <svg><image>),
  // ignoring emoji sprites
  function avatarOf(row) {
    let best = '';
    let bestSize = 0;
    for (const element of row.querySelectorAll('img, svg image')) {
      const url = element.tagName === 'IMG' ? element.src
        : element.getAttribute('href') || element.getAttribute('xlink:href') || '';
      if (!/^(https:|data:image\/)/.test(url) || /emoji/i.test(url)) continue;
      const size = element.getBoundingClientRect().width;
      if (size >= 24 && size > bestSize) {
        best = url;
        bestSize = size;
      }
    }
    return best;
  }

  // Messenger's "muted" bell icon (current and older versions of the path)
  const MESSENGER_MUTED_ICON = /^\s*M(2\.5 6c0-\.322|29\.676 7\.746|9\.244 24\.99)/;

  const CHAT_LIST_ADAPTERS = {
    messenger: {
      // Each conversation is a link to /messages/t/<id>/ (or /messages/e2ee/t/<id>/)
      links() {
        return document.querySelectorAll('[role="navigation"] a[href*="/t/"], [role="grid"] a[href*="/t/"]');
      },
      paths: new Map(), // conversation id -> link path, to open it when not rendered
      listPane() {
        const link = this.links()[0];
        return link && (link.closest('[role="navigation"]') || link.closest('[role="grid"]'));
      },
      scrollListToTop() {
        let element = this.links()[0];
        while (element && element !== document.body) {
          if (element.scrollHeight > element.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)) {
            element.scrollTop = 0;
            return;
          }
          element = element.parentElement;
        }
      },
      chats() {
        const chats = [];
        for (const link of this.links()) {
          const path = new URL(link.href, location.href).pathname;
          const match = path.match(/\/t\/([^/]+)/);
          if (!match) continue;
          this.paths.set(match[1], path);
          const row = link.closest('[role="row"], [role="listitem"]') || link;
          const parts = [];
          const elements = [];
          let unread = false;
          for (const element of outermost(row, '[dir="auto"]')) {
            const text = textOf(element);
            if (!text) continue;
            // Screen-reader-only label in front of the preview, e.g. "Unread message:"
            if (/:$/.test(text) && isUnreadLabel(text)) { unread = true; continue; }
            parts.push(text);
            elements.push(element);
          }
          // The time of the last message comes last ("5 min", "12:30"), unless
          // it is in an <abbr> (skipped already) and the preview itself looks like a time
          const abbr = row.querySelector('abbr');
          let timeLabel = abbr ? (abbr.textContent.trim() || abbr.getAttribute('aria-label') || '') : '';
          if (TIMESTAMP.test(parts[parts.length - 1]) && (parts.length >= 3 || !abbr)) timeLabel = parts.pop();
          else if (parts.length >= 3 && parts[parts.length - 1].length <= 15 && parseListTime(parts[parts.length - 1])) {
            timeLabel = parts[parts.length - 1];
          }
          if (parts.length < 2) continue;
          unread = unread || isBold(elements[1]) ||
            [...row.querySelectorAll('[aria-label]')].some((element) => isUnreadLabel(element.getAttribute('aria-label')));
          chats.push({
            key: match[1],
            name: parts[0],
            preview: parts[1],
            unread,
            muted: [...row.querySelectorAll('svg path')].some((path) => MESSENGER_MUTED_ICON.test(path.getAttribute('d') || '')),
            pinned: false,
            count: 0,
            timeLabel,
            selected: location.pathname.includes(`/t/${match[1]}`),
            icon: avatarOf(row),
            top: row.getBoundingClientRect().top,
          });
        }
        return chats;
      },
      open(key) {
        for (const link of this.links()) {
          if (new URL(link.href, location.href).pathname.match(/\/t\/([^/]+)/)?.[1] === key) {
            link.click();
            return;
          }
        }
        // Not rendered (the list only renders what is visible): load it directly
        location.assign(this.paths.get(key) || `/messages/t/${key}/`);
      },
    },
    whatsapp: {
      listPane() {
        return document.getElementById('side') || document.getElementById('pane-side');
      },
      scrollListToTop() {
        const pane = document.getElementById('pane-side');
        if (pane) pane.scrollTop = 0;
      },
      // Time of the last message, or another short text in the row that reads as a time
      timeOf(row, name, preview) {
        const detail = row.querySelector('[data-testid="cell-frame-primary-detail"]');
        if (detail) return textOf(detail);
        for (const element of row.querySelectorAll('div, span')) {
          if (element.firstElementChild) continue;
          const text = textOf(element);
          if (text && text.length <= 20 && text !== name && text !== preview && parseListTime(text)) return text;
        }
        return '';
      },
      // Rows of the chat list in the left pane; a chat is identified by its name
      rows() {
        const pane = document.getElementById('pane-side');
        return pane ? outermost(pane, '[role="listitem"], [role="row"]') : [];
      },
      nameOf(row) {
        const element = row.querySelector('[data-testid="cell-frame-title"] span[title], span[title]');
        return element ? (element.getAttribute('title') || textOf(element)) : '';
      },
      chats() {
        const chats = [];
        for (const row of this.rows()) {
          const name = this.nameOf(row);
          if (!name) continue;
          const secondary = row.querySelector('[data-testid="cell-frame-secondary"]');
          let preview = '';
          if (secondary) {
            const previewTitle = secondary.querySelector('span[title]');
            preview = previewTitle ? previewTitle.getAttribute('title') : textOf(secondary);
          } else {
            const parts = outermost(row, 'span[dir="auto"], span[dir="ltr"], span[title]')
              .map(textOf)
              .filter((text) => text && text !== name && !TIMESTAMP.test(text) && !/^\d+$/.test(text));
            preview = parts.sort((a, b) => b.length - a.length)[0] || '';
          }
          // The unread badge is a number with an accessible label ("3 unread messages")
          const badge = [...row.querySelectorAll('[aria-label]')].find((element) =>
            /^\d+$/.test(element.textContent.trim()) || isUnreadLabel(element.getAttribute('aria-label')));
          chats.push({
            key: name,
            name,
            preview: preview.replace(/\s+/g, ' ').trim(),
            unread: !!badge,
            count: badge ? parseInt(badge.textContent.trim(), 10) || 1 : 0,
            muted: !!row.querySelector('[data-testid="mute-notifications-refreshed"], [data-icon="ic-notifications-off"], [data-icon*="muted"]'),
            pinned: !!row.querySelector('[data-icon*="pinned"]'),
            timeLabel: this.timeOf(row, name, preview),
            selected: row.getAttribute('aria-selected') === 'true' || !!row.querySelector('[aria-selected="true"]'),
            icon: avatarOf(row),
            top: row.getBoundingClientRect().top,
          });
        }
        return chats;
      },
      open(key) {
        // "<name>\u0001<n>": the n-th conversation with that name, from the top
        const [name, nth] = String(key).split('\u0001');
        const row = this.rows()
          .filter((candidate) => this.nameOf(candidate) === name)
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[Number(nth) || 0];
        // WhatsApp ignores synthetic clicks: click the chat's name like a user would
        if (row) clickLikeUser(row.querySelector('span[title]') || row);
      },
    },
  };

  const adapter = CHAT_LIST_ADAPTERS[SERVICE];
  const lastPreviews = new Map(); // chat key -> { preview, unread } from the last scan
  const notifiedPreviews = new Map(); // chat key -> last preview we notified about
  let chatListQuietUntil = null; // null until the list shows up for the first time
  let lastChatListCandidateAt = 0;
  let lastMutedChangeAt = 0;
  let lastCountIncreaseAt = 0;

  function openChat(key) {
    try {
      adapter.open(key);
    } catch (e) {
      console.warn('[WhatsMess] Could not open conversation:', e);
    }
  }

  function normalize(text) {
    return String(text || '').replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .toLowerCase().replace(/[…\s]+/g, ' ').trim();
  }

  // Conversations in the list with this name
  function findChats(name) {
    const wanted = normalize(name);
    if (!wanted) return [];
    try {
      return adapter.chats().filter((chat) => normalize(chat.name) === wanted);
    } catch (e) {
      return [];
    }
  }

  // "Jan Kowalski" matches "Jan Kowalski" and "Jan Kowalski (Praca)", not "Jan"
  function sameName(a, b) {
    return !!a && !!b && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
  }

  function matchesPageNotification(chat, since) {
    const name = normalize(chat.name);
    const preview = normalize(chat.preview).slice(0, 30);
    return recentPageNotifications.some((notification) => notification.at >= since &&
      (sameName(normalize(notification.title), name) ||
        (preview.length >= 8 && normalize(notification.body).includes(preview))));
  }

  // ===== Conversation list for the "all messages" view (BETA) =====
  const activityAt = new Map(); // chat key -> when we saw its last message arrive
  let chatFeedEnabled = false;
  let lastFeed = '';
  let lastLayout = null; // last reported { listRight, width }

  // Whole labels only, so names like "Monika" or "Ptaki" are not dates
  const WEEKDAYS = [
    /^(nd|niedz|niedziela|sun|sunday)\.?$/, /^(pon|poniedziałek|poniedzialek|mon|monday)\.?$/,
    /^(wt|wtorek|tue|tues|tuesday)\.?$/, /^(śr|sr|środa|sroda|wed|wednesday)\.?$/,
    /^(czw|czwartek|thu|thur|thurs|thursday)\.?$/, /^(pt|pią|piątek|piatek|fri|friday)\.?$/,
    /^(sob|sobota|sat|saturday)\.?$/,
  ];
  const MONTHS = ['sty|jan', 'lut|feb', 'mar', 'kwi|apr', 'maj|may', 'cze|jun', 'lip|jul', 'sie|aug', 'wrz|sep', 'paź|paz|oct', 'lis|nov', 'gru|dec'];
  const UNITS = [
    [/^(s|sek|sec|secs|sekunda|sekundy|sekund|second|seconds)$/, 1000],
    [/^(m|min|mins|minut|minuty|minutę|minuta|minute|minutes)$/, 60000],
    [/^(h|g|godz|godzin|godziny|godzinę|godzina|hr|hrs|hour|hours)$/, 3600000],
    [/^(d|dn|dni|dzień|dzien|day|days)$/, 86400000],
    [/^(w|tydz|tyg|tydzień|tygodnie|tygodni|wk|wks|week|weeks)$/, 604800000],
    [/^(mies|miesiąc|miesiące|miesięcy|mo|mos|month|months)$/, 2592000000],
    [/^(r|rok|lata|lat|y|yr|yrs|year|years)$/, 31536000000],
  ];

  // Approximate time of a list label: "5 min", "1 godz.", "12:34", "wczoraj",
  // "pon.", "12 wrz", "06.10.2026"... 0 when unknown, never in the future
  function parseListTime(label) {
    return Math.min(parseListLabel(label), Date.now());
  }

  function parseListLabel(label) {
    const text = normalize(label).replace(/\.$/, '');
    if (!text) return 0;
    const now = new Date();
    const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59).getTime();
    const daysAgo = (days) => endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
    if (/^(teraz|now|just now|przed chwilą)$/.test(text)) return now.getTime();
    if (/^(wczoraj|yesterday)$/.test(text)) return daysAgo(1);
    let match = text.match(/^(\d{1,2})[:.](\d{2})(\s?([ap])\.?m)?$/);
    if (match) {
      let hours = Number(match[1]) % (match[4] ? 12 : 24);
      if (match[4] === 'p') hours += 12;
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, Number(match[2]));
      return date.getTime() > now.getTime() + 60000 ? date.getTime() - 86400000 : date.getTime();
    }
    match = text.match(/^(\d{1,3})\s?([a-ząćęłńóśźż]+)/);
    if (match) {
      const unit = UNITS.find(([pattern]) => pattern.test(match[2]));
      if (unit) return now.getTime() - Number(match[1]) * unit[1];
    }
    const weekday = WEEKDAYS.findIndex((pattern) => pattern.test(text));
    if (weekday >= 0) return daysAgo(((now.getDay() - weekday + 7) % 7) || 7);
    match = text.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/);
    if (match) {
      const [, a, b, c] = match.map(Number);
      if (a > 31) return endOfDay(new Date(a, b - 1, c)); // 2026-10-06
      // 6.10.2026 or 10/6/2026: the page's language decides, unless one part is > 12
      const dayFirst = a > 12 || (b <= 12 && isDayFirst());
      const year = c < 100 ? c + 2000 : c;
      return endOfDay(new Date(year, (dayFirst ? b : a) - 1, dayFirst ? a : b));
    }
    const monthNames = MONTHS.join('|');
    match = text.match(new RegExp(`^(\\d{1,2}) (${monthNames})[a-ząćęłńóśźż]*\\.?( \\d{4})?$`)) ||
      text.match(new RegExp(`^(${monthNames})[a-z]*\\.? (\\d{1,2})(,? \\d{4})?$`));
    if (match) {
      const dayFirst = /^\d/.test(match[1]);
      const monthText = dayFirst ? match[2] : match[1];
      const day = Number(dayFirst ? match[1] : match[2]);
      const monthIndex = MONTHS.findIndex((names) => new RegExp(`^(${names})`).test(monthText));
      const year = (text.match(/(\d{4})$/) || [])[1];
      let date = new Date(year ? Number(year) : now.getFullYear(), monthIndex, day);
      if (!year && date > now) date = new Date(now.getFullYear() - 1, monthIndex, day);
      return endOfDay(date);
    }
    return 0;
  }

  // Day before month in numeric dates, in the page's language (6.10 vs 10/6)
  let dayFirstCache = null;
  function isDayFirst() {
    if (dayFirstCache === null) {
      try {
        const parts = new Intl.DateTimeFormat(document.documentElement.lang || navigator.language)
          .formatToParts(new Date(2026, 11, 31));
        dayFirstCache = parts.findIndex((part) => part.type === 'day') < parts.findIndex((part) => part.type === 'month');
      } catch (e) {
        dayFirstCache = true;
      }
    }
    return dayFirstCache;
  }

  // Conversations for the shared list, newest first. A row lower in the list
  // is never newer than the one above it, whatever its label says.
  function sendChatFeed(chats) {
    if (!chatFeedEnabled) return;
    const sorted = [...chats].sort((a, b) => a.top - b.top).slice(0, 60);
    const times = sorted.map((chat) => Math.max(parseListTime(chat.timeLabel), activityAt.get(chat.key) || 0));
    // Rows without a readable time take the time of the row above them (or
    // below, at the top of the list); 0 when the service shows no times at all
    let previousTime = Infinity;
    sorted.forEach((chat, index) => {
      if (chat.pinned) return;
      let time = times[index];
      if (!time) {
        time = Number.isFinite(previousTime) ? previousTime
          : times.find((other, otherIndex) => otherIndex > index && other && !sorted[otherIndex].pinned) || 0;
      }
      times[index] = Math.min(time, previousTime);
      previousTime = times[index];
    });
    const sameName = new Map();
    const feed = sorted.map((chat, index) => {
      // Two conversations can share a name (WhatsApp): tell them apart by order
      const nth = sameName.get(chat.key) || 0;
      sameName.set(chat.key, nth + 1);
      return {
        key: nth ? `${chat.key}\u0001${nth}` : chat.key,
        name: chat.name, preview: chat.preview, unread: chat.unread, muted: chat.muted,
        icon: chat.icon, timeLabel: chat.timeLabel, time: times[index], selected: !!chat.selected,
      };
    });
    const signature = JSON.stringify(feed.map(({ time, ...chat }) => chat));
    if (signature === lastFeed) return;
    lastFeed = signature;
    ipcRenderer.sendToHost('chats', { chats: feed });
  }

  // Where the page's own conversation list ends: the shared view slides the
  // page left by this much, so only the conversation itself stays visible
  // (in the page's own pixels, with its width, so the host can account for zoom)
  function reportLayout() {
    if (!chatFeedEnabled) return;
    let right = 0;
    try {
      const pane = adapter.listPane();
      right = pane ? Math.round(pane.getBoundingClientRect().right) : 0;
    } catch (e) {
      right = 0;
    }
    if (right <= 0 || right > window.innerWidth * 0.75) right = 0;
    const width = window.innerWidth;
    if (lastLayout && Math.abs(right - lastLayout.listRight) < 2 && width === lastLayout.width) return;
    lastLayout = { listRight: right, width };
    ipcRenderer.sendToHost('layout', lastLayout);
  }

  ipcRenderer.on('set-chat-feed', (event, value) => {
    chatFeedEnabled = !!value;
    lastFeed = '';
    lastLayout = null;
    if (chatFeedEnabled) scanChatList();
  });

  // The shared view was opened: report the layout again, and bring the page's
  // list back to the top (only rendered rows can be read, and the user cannot
  // scroll the hidden list)
  ipcRenderer.on('unified-visible', () => {
    try {
      adapter.scrollListToTop();
    } catch (e) { /* no list yet */ }
    lastLayout = null;
    setTimeout(reportLayout, 300);
  });

  ipcRenderer.on('open-chat', (event, key) => {
    webFrame.executeJavaScript('void 0', true).catch(() => {}).then(() => openChat(String(key)));
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reportLayout, 200);
  });

  function scanChatList() {
    let chats;
    try {
      chats = adapter.chats();
    } catch (e) {
      return;
    }
    try {
      detectNewMessages(chats);
    } finally {
      sendChatFeed(chats);
      reportLayout();
    }
  }

  function detectNewMessages(chats) {
    if (!chats.length) return;

    // The list fills in and syncs for a while after loading: learn it first
    const now = Date.now();
    if (chatListQuietUntil === null) {
      // The list just appeared (e.g. after logging in): its counter catches up too
      chatListQuietUntil = now + STARTUP_GRACE;
      titleQuietUntil = Math.max(titleQuietUntil, chatListQuietUntil);
    }
    const armed = now >= chatListQuietUntil;
    const topChat = topOf(chats);
    logChatList(chats);

    const fresh = [];
    for (const chat of chats) {
      // "typing..." replaces the preview only for a moment
      if (!chat.preview || TYPING_PREVIEW.test(chat.preview)) continue;
      const previous = lastPreviews.get(chat.key);
      lastPreviews.set(chat.key, { preview: chat.preview, unread: chat.unread, count: chat.count });
      // New text, or the same text again (e.g. "ok"): the unread badge grew, or
      // the conversation became unread and moved to the top
      const changed = !!previous && (previous.preview !== chat.preview || chat.count > previous.count);
      // (not while the list catches up after loading or waking up: those messages are old)
      if (changed && armed) activityAt.set(chat.key, now);
      if (chat.muted) {
        if (changed) lastMutedChangeAt = now;
        continue;
      }
      if (!chat.unread) notifiedPreviews.delete(chat.key);
      if (!armed || !chat.unread) continue;
      const isNew = previous
        ? changed || (!previous.unread && chat === topChat)
        // Not seen before (e.g. scrolled into view): only when it just jumped
        // to the top or the unread counter just went up
        : chat === topChat || now - lastCountIncreaseAt < 5000;
      if (isNew) fresh.push(chat);
    }
    // A burst of changes means a resync, not new messages
    if (fresh.length > MAX_CHATLIST_NOTIFICATIONS_PER_SCAN) return debugLog('skipped: chat list resync', { changed: fresh.length });
    fresh.forEach(scheduleChatNotification);
  }

  let lastChatListLog = '';
  function logChatList(chats) {
    if (!debug) return;
    const sorted = [...chats].sort((a, b) => a.top - b.top);
    const summary = JSON.stringify({
      rows: chats.length,
      unread: chats.filter((chat) => chat.unread).length,
      muted: chats.filter((chat) => chat.muted).length,
      top: sorted.slice(0, 3).map((chat) => ({ name: chat.name, preview: chat.preview, unread: chat.unread, muted: chat.muted, icon: !!chat.icon })),
    });
    if (summary === lastChatListLog) return;
    lastChatListLog = summary;
    debugLog('chat list', JSON.parse(summary));
  }

  // WhatsApp's own notifications are reliable: once they are seen working, its
  // silence is deliberate (muted or archived chat, busy group, notifications
  // turned off in WhatsApp), so the fallbacks stay quiet as well
  function fallbacksSilenced() {
    return SERVICE === 'whatsapp' && pageNotificationsWork;
  }

  function scheduleChatNotification(chat) {
    const detectedAt = lastChatListCandidateAt = Date.now();
    debugLog('new message in chat list', { name: chat.name, preview: chat.preview });
    setTimeout(() => {
      // The page reported this message itself
      if (matchesPageNotification(chat, detectedAt - 5000)) return debugLog('skipped: the page reported it');
      if (fallbacksSilenced()) return debugLog('skipped: WhatsApp decided not to notify');
      notifiedPreviews.set(chat.key, chat.preview);
      sendNotification({
        source: 'chatlist',
        id: `chatlist-${chat.key}`,
        title: chat.name,
        body: chat.preview,
        icon: chat.icon,
      });
    }, FALLBACK_DELAY);
  }

  // The conversation at the top of the list, below pinned ones
  function topOf(chats) {
    const unpinned = chats.filter((chat) => !chat.pinned);
    const candidates = unpinned.length ? unpinned : chats;
    return candidates.reduce((top, chat) => (chat.top < top.top ? chat : top), candidates[0]);
  }

  function currentChats() {
    try {
      return adapter.chats();
    } catch (e) {
      return [];
    }
  }

  function topUnreadChat() {
    const chats = currentChats();
    if (!chats.length) return null;
    const top = topOf(chats);
    return top.unread && !top.muted && top.preview && !TYPING_PREVIEW.test(top.preview) ? top : null;
  }

  let scanTimer = null;
  function requestScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanChatList();
    }, 1000);
  }

  // ===== LAYER 3: unread counter in the title =====
  const SERVICE_NAME = SERVICE === 'whatsapp' ? 'WhatsApp' : 'Messenger';
  let lastTitle = null;
  let lastCount = null;
  let titleUnknown = false; // a title without counter waits for the list to tell
  let lastAlertTitle = { text: '', at: 0 };

  function checkTitle() {
    const title = document.title || '';
    if (title === lastTitle) return;
    lastTitle = title;
    const match = title.match(/\((\d[\d\s.,  ]*)\)/);
    if (!match && !/messenger|facebook|whatsapp/i.test(title)) {
      // Messenger flashes titles like "<Name> sent you a message"
      if (title) lastAlertTitle = { text: title, at: Date.now() };
      return;
    }
    if (!match) {
      // No counter: everything read, or (WhatsApp) offline/connecting, or
      // still loading. Only call it 0 when the list agrees - or when the list
      // cannot be read at all.
      const now = Date.now();
      const listReady = chatListQuietUntil !== null && now >= chatListQuietUntil;
      const listMissing = chatListQuietUntil === null && now - startedAt > 3 * STARTUP_GRACE;
      if (!listMissing && (!listReady || currentChats().some((chat) => chat.unread && !chat.muted))) {
        if (!titleUnknown) debugLog('unread counter unknown', { title });
        titleUnknown = true;
        return;
      }
    }
    titleUnknown = false;
    const count = match ? parseInt(match[1].replace(/\D/g, ''), 10) : 0;
    const previous = lastCount;
    lastCount = count;
    debugLog('unread counter', { title, count });
    if (previous === null || count <= previous || Date.now() < titleQuietUntil) return;

    const increasedAt = lastCountIncreaseAt = Date.now();
    requestScan();
    setTimeout(() => {
      // The list appeared meanwhile, already reported by the page, a
      // conversation-list notification is on its way, or a muted conversation
      if (Date.now() < titleQuietUntil) return;
      if (lastPageNotificationAt >= increasedAt - 1000) return;
      if (lastChatListCandidateAt >= increasedAt - 1000) return;
      if (lastMutedChangeAt >= increasedAt - 5000) return debugLog('skipped: muted conversation');
      if (fallbacksSilenced()) return debugLog('skipped: WhatsApp decided not to notify');
      const alert = Date.now() - lastAlertTitle.at < 10000 ? lastAlertTitle.text : '';
      // The conversation at the top of the list is the best guess (e.g. the
      // same text sent twice does not change its preview)
      const chat = topUnreadChat();
      if (chat && notifiedPreviews.get(chat.key) !== chat.preview &&
          (!alert || normalize(alert).includes(normalize(chat.name)))) {
        notifiedPreviews.set(chat.key, chat.preview);
        sendNotification({ source: 'title', id: `chatlist-${chat.key}`, title: chat.name, body: chat.preview, icon: chat.icon });
      } else {
        sendNotification({ source: 'title', id: 'title', title: SERVICE_NAME, body: alert || 'Masz nową wiadomość' });
      }
    }, FALLBACK_DELAY + 1000);
  }

  function start() {
    new MutationObserver(() => {
      checkTitle();
      requestScan();
    }).observe(document, { childList: true, subtree: true, characterData: true });
    setInterval(() => {
      if (titleUnknown) lastTitle = null; // look at it again
      checkTitle();
      scanChatList();
    }, 5000);
    checkTitle();
  }

  start();
})();
