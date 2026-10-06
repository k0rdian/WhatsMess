(async function () {
  'use strict';

  const SERVICES = {
    messenger: {
      name: 'Messenger',
      url: 'https://www.facebook.com/messages',
      iconSVG: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2C6.36 2 2 6.13 2 11.7C2 14.61 3.33 17.12 5.47 18.76V22L8.57 20.36C9.64 20.66 10.79 20.83 12 20.83C17.64 20.83 22 16.7 22 11.13C22 6.13 17.64 2 12 2Z" fill="url(#mg)"/><path d="M7.5 13.5L10.5 9.5L13 12L16.5 9.5L13.5 13.5L11 11L7.5 13.5Z" fill="white"/><defs><linearGradient id="mg" x1="2" y1="22" x2="22" y2="2"><stop stop-color="#0078FF"/><stop offset="1" stop-color="#00C6FF"/></linearGradient></defs></svg>',
    },
    whatsapp: {
      name: 'WhatsApp',
      url: 'https://web.whatsapp.com',
      iconSVG: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12C2 13.85 2.5 15.55 3.35 17.04L2 22L7.08 20.68C8.51 21.41 10.21 21.83 12 21.83C17.52 21.83 22 17.35 22 11.83C22 6.48 17.52 2 12 2Z" fill="url(#wg)"/><path d="M8.5 7.5C8.7 7.1 9.3 6.7 9.7 7.1L10.5 8.3C10.7 8.6 10.6 9 10.3 9.2L9.8 9.6C9.6 9.8 9.5 10.1 9.7 10.3C10.1 11 11 12 11.7 12.5C12 12.7 12.2 12.6 12.4 12.4L12.8 11.9C13 11.6 13.4 11.5 13.7 11.7L15 12.5C15.3 12.7 15.4 13.2 15.1 13.5C14.5 14.2 13.5 14.8 12.5 14.5C11 14 9.5 13 8.5 11.5C7.8 10.4 7.8 8.5 8.5 7.5Z" fill="white"/><defs><linearGradient id="wg" x1="2" y1="22" x2="22" y2="2"><stop stop-color="#25D366"/><stop offset="1" stop-color="#128C7E"/></linearGradient></defs></svg>',
    },
  };

  // Icon of the "Wszystkie" tab (all messages view, BETA)
  const ALL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="url(#ag)" stroke-width="2" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" stroke="url(#ag)" stroke-width="2" stroke-linecap="round"/><defs><linearGradient id="ag" x1="3" y1="21" x2="21" y2="3"><stop stop-color="#3B82F6"/><stop offset="1" stop-color="#06B6D4"/></linearGradient></defs></svg>';

  // DOM references
  const setupScreen = document.getElementById('setup-screen');
  const appScreen = document.getElementById('app-screen');
  const setupContinueBtn = document.getElementById('setup-continue-btn');
  const tabsContainer = document.getElementById('tabs-container');
  const webviewContainer = document.getElementById('webview-container');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const unifiedPanel = document.getElementById('unified-panel');
  const unifiedList = document.getElementById('unified-list');

  let settings = await window.electronAPI.getSettings();
  let activeService = null;
  let webviewPreloadPath = null;

  // Get paths from main process (since __dirname is not available here)
  try {
    webviewPreloadPath = await window.electronAPI.getWebviewPreloadPath();
    const iconUrl = await window.electronAPI.getIconUrl();
    // Set all icon images to the correct URL
    document.querySelectorAll('.logo-img, .about-logo').forEach((img) => {
      img.src = iconUrl;
    });
  } catch (e) {
    console.error('Failed to get paths from main process:', e);
  }

  // Notification de-duplication: the same message can be reported twice
  // (e.g. by the page itself and by the chat list watcher)
  const recentNotifications = new Map(); // normalized "service|title|body" -> { time, source, tag }
  const NOTIFICATION_DEDUP_WINDOW = 10000; // 10 seconds
  const unreadCounts = {};

  // All messages view (BETA): conversations reported by each webview
  let unifiedView = null; // the "Wszystkie" tab is shown (null until the tabs are built)
  const chatsByService = {};
  let selectedChat = null; // "<service>:<key>" clicked in the shared list
  let feedRequestedAt = Date.now(); // the lists were last requested from the webviews
  let emptyTimer = null;
  let pointerDown = false; // a click on the shared list is in progress
  let renderPending = false;
  // Page list widths reported since the window was last resized (per service):
  // breakpoints in the page can make the slide amount flip back and forth
  const clipHistory = {};

  // ===== SETUP SCREEN =====
  function initSetup() {
    ['messenger', 'whatsapp'].forEach((service) => {
      const toggle = document.getElementById(`setup-${service}-toggle`);
      const card = document.getElementById(`setup-${service}-card`);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle.classList.toggle('active');
        card.classList.toggle('disabled', !toggle.classList.contains('active'));
        settings.integrations[service] = toggle.classList.contains('active');
      });

      card.addEventListener('click', () => {
        toggle.classList.toggle('active');
        card.classList.toggle('disabled', !toggle.classList.contains('active'));
        settings.integrations[service] = toggle.classList.contains('active');
      });
    });

    setupContinueBtn.addEventListener('click', async () => {
      const anyEnabled = Object.values(settings.integrations).some((v) => v);
      if (!anyEnabled) {
        setupContinueBtn.style.animation = 'shake 0.4s ease';
        setTimeout(() => (setupContinueBtn.style.animation = ''), 400);
        return;
      }
      settings.setupDone = true;
      await window.electronAPI.saveSettings(settings);
      showApp();
    });
  }

  // ===== APP SCREEN =====
  function showApp() {
    setupScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    buildTabs();
    buildWebviews();
    applyView();
  }

  function getEnabledServices() {
    return Object.entries(settings.integrations)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);
  }

  function buildTabs() {
    tabsContainer.innerHTML = '';
    const enabledServices = getEnabledServices();
    if (!enabledServices.includes(activeService)) activeService = enabledServices[0] || null;
    if (unifiedView === null || !settings.unifiedInbox) unifiedView = !!settings.unifiedInbox;

    if (settings.unifiedInbox && enabledServices.length) {
      const tab = document.createElement('div');
      tab.className = 'tab all';
      tab.dataset.service = 'all';
      tab.innerHTML = `
        <div class="tab-icon">${ALL_ICON_SVG}</div>
        <span>Wszystkie</span>
        <div class="tab-badge" id="badge-all"></div>
      `;
      tab.addEventListener('click', () => showUnifiedView());
      tabsContainer.appendChild(tab);
    }

    enabledServices.forEach((serviceKey) => {
      const service = SERVICES[serviceKey];
      const tab = document.createElement('div');
      tab.className = `tab ${serviceKey}`;
      tab.dataset.service = serviceKey;
      tab.innerHTML = `
        <div class="tab-icon">${service.iconSVG}</div>
        <span>${service.name}</span>
        <div class="tab-badge" id="badge-${serviceKey}"></div>
      `;
      tab.addEventListener('click', () => switchToService(serviceKey));
      tabsContainer.appendChild(tab);
    });
    updateBadges();
  }

  function buildWebviews() {
    webviewContainer.querySelectorAll('webview, .loading-overlay').forEach((element) => element.remove());
    Object.keys(clipHistory).forEach((service) => delete clipHistory[service]);
    const enabledServices = getEnabledServices();
    Object.keys(chatsByService).forEach((service) => {
      if (!enabledServices.includes(service)) delete chatsByService[service];
    });

    enabledServices.forEach((serviceKey) => {
      const service = SERVICES[serviceKey];

      // Create loading overlay
      const loading = document.createElement('div');
      loading.className = 'loading-overlay';
      loading.id = `loading-${serviceKey}`;
      loading.innerHTML = `
        <div class="loading-spinner"></div>
        <div class="loading-text">Ładowanie ${service.name}...</div>
      `;

      // Create webview
      const webview = document.createElement('webview');
      webview.id = `webview-${serviceKey}`;
      webview.dataset.service = serviceKey;
      webview.src = service.url;
      webview.setAttribute('partition', `persist:${serviceKey}`);
      webview.setAttribute('useragent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

      // Set preload only if we have a valid path from main process
      if (webviewPreloadPath) {
        webview.setAttribute('preload', `file://${webviewPreloadPath}`);
      }

      if (serviceKey === activeService) {
        webview.classList.add('active');
      }

      // Handle webview events
      // The preload starts fresh on every page load: tell it whether its tab is shown
      webview.addEventListener('dom-ready', () => {
        sendVisibility(webview, serviceKey);
        if (settings.debug) webview.send('set-debug', true);
        webview.send('set-chat-feed', !!settings.unifiedInbox);
        if (settings.unifiedInbox) feedRequestedAt = Date.now();
        delete clipHistory[serviceKey]; // a (re)loaded page settles from scratch
        if (unifiedView) webview.send('unified-visible');
        if (serviceKey === activeService && !webview.dataset.focused) {
          webview.dataset.focused = 'true';
          webview.focus();
        }
      });

      webview.addEventListener('did-finish-load', () => {
        setTimeout(() => {
          loading.classList.add('fade-out');
          setTimeout(() => loading.remove(), 500);
        }, 500);
      });

      webview.addEventListener('did-fail-load', (e) => {
        console.log(`Webview ${serviceKey} failed to load:`, e.errorDescription);
        loading.querySelector('.loading-text').textContent = `Błąd ładowania ${service.name}. Kliknij by spróbować ponownie.`;
        loading.style.cursor = 'pointer';
        loading.onclick = () => {
          webview.loadURL(service.url);
          loading.querySelector('.loading-text').textContent = `Ładowanie ${service.name}...`;
          loading.style.cursor = 'default';
          loading.classList.remove('fade-out');
        };
      });

      webview.addEventListener('page-title-updated', (e) => {
        handleTitleChange(serviceKey, e.title);
      });

      // Listen for IPC messages from webview preload
      webview.addEventListener('ipc-message', (e) => {
        const data = e.args[0] || {};
        if (e.channel === 'notification') {
          forwardNotification(serviceKey, data);
        } else if (e.channel === 'notification-close') {
          window.electronAPI.closeNotification({ service: serviceKey, id: data.id });
        } else if (e.channel === 'chats') {
          chatsByService[serviceKey] = Array.isArray(data.chats) ? data.chats : [];
          if (unifiedView) renderUnifiedList();
        } else if (e.channel === 'layout') {
          applyClip(webview, serviceKey, data);
        } else if (e.channel === 'click-at') {
          window.electronAPI.clickInWebview(webview.getWebContentsId(), data.x, data.y);
        }
      });

      webviewContainer.appendChild(webview);
      webviewContainer.appendChild(loading);
    });
  }

  function normalizeText(text) {
    return String(text || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function switchToService(serviceKey) {
    const webview = document.getElementById(`webview-${serviceKey}`);
    if (!webview || (activeService === serviceKey && !unifiedView)) return;
    activeService = serviceKey;
    unifiedView = false;
    selectedChat = null;
    applyView();
    // Keyboard focus follows the visible tab (pages notify only when unfocused)
    webview.focus();
  }

  // "Wszystkie" tab: the shared list on the left, the conversation of
  // `serviceKey` (or of the service shown last) on the right
  function showUnifiedView(serviceKey) {
    const service = serviceKey || activeService;
    const webview = document.getElementById(`webview-${service}`);
    if (!settings.unifiedInbox || !webview) return;
    activeService = service;
    unifiedView = true;
    applyView();
    webview.focus();
  }

  let unifiedShown = false;
  function applyView() {
    const showUnified = !!unifiedView && !!activeService;
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.service === (showUnified ? 'all' : activeService));
    });
    webviewContainer.classList.toggle('unified', showUnified);
    unifiedPanel.classList.toggle('hidden', !showUnified);
    document.querySelectorAll('webview').forEach((wv) => {
      wv.classList.toggle('active', wv.dataset.service === activeService);
      sendVisibility(wv, wv.dataset.service);
      // Entering the shared view: the pages measure their lists again
      if (showUnified && !unifiedShown) {
        delete clipHistory[wv.dataset.service];
        try {
          wv.send('unified-visible');
        } catch (e) {
          // Not attached yet - 'dom-ready' will send it
        }
      }
    });
    unifiedShown = showUnified;
    if (showUnified) renderUnifiedList();
  }

  // Slide the page left by the width of its own conversation list (reported in
  // the page's pixels, so zoom is taken into account). If the reports keep
  // changing without the window being resized, the page's breakpoints make it
  // flip between widths: settle on the smallest one (a strip of the page's
  // list may show, but no part of the conversation is hidden).
  function applyClip(webview, serviceKey, { listRight, width }) {
    if (!unifiedView) return; // full width in the service tabs: keep the shared view's value
    const scale = width > 0 ? webview.getBoundingClientRect().width / width : 1;
    const clip = Math.max(0, Math.round((Number(listRight) || 0) * scale));
    if (!clip) {
      // No list (page loading, logged out): show the whole page, start over later
      delete clipHistory[serviceKey];
      webview.style.setProperty('--clip', '0px');
      return;
    }
    const history = clipHistory[serviceKey] || (clipHistory[serviceKey] = { values: [], frozen: false });
    if (history.frozen) return;
    // Converging reports never come back to an earlier value; a cycle does
    const cycleStart = history.values.findIndex((value) => Math.abs(value - clip) < 2);
    history.values.push(clip);
    if (cycleStart >= 0) {
      history.frozen = true;
      webview.style.setProperty('--clip', `${Math.min(...history.values.slice(cycleStart))}px`);
      return;
    }
    if (history.values.length >= 12) history.frozen = true;
    webview.style.setProperty('--clip', `${clip}px`);
  }

  // A window resize gives the pages a new chance to settle
  new ResizeObserver(() => {
    Object.keys(clipHistory).forEach((serviceKey) => delete clipHistory[serviceKey]);
  }).observe(webviewContainer);

  // ===== ALL MESSAGES VIEW (BETA) =====
  // Conversations of all services, newest first. The times come from the
  // services' own lists, so the order between services is approximate.
  function renderUnifiedList() {
    // Replacing the rows between mousedown and mouseup would lose the click
    if (pointerDown) {
      renderPending = true;
      return;
    }
    const chats = [];
    getEnabledServices().forEach((service, serviceIndex) => {
      (chatsByService[service] || []).forEach((chat, index) => {
        chats.push({ ...chat, service, serviceIndex, index });
      });
    });
    chats.sort((a, b) => (b.time - a.time) || (a.serviceIndex - b.serviceIndex) || (a.index - b.index));

    if (!chats.length) {
      const empty = document.createElement('div');
      empty.className = 'unified-empty';
      const loadingLeft = feedRequestedAt + 20000 - Date.now();
      if (loadingLeft > 0) {
        empty.textContent = 'Wczytywanie rozmów...';
        clearTimeout(emptyTimer);
        emptyTimer = setTimeout(() => unifiedView && renderUnifiedList(), loadingLeft + 50);
      } else {
        empty.textContent = 'Nie widać jeszcze żadnych rozmów. Sprawdź w zakładkach Messenger i WhatsApp, czy jesteś zalogowany.';
      }
      unifiedList.replaceChildren(empty);
      return;
    }
    // The conversation open on the right, as the page reports it (or as clicked)
    const shown = chats.find((chat) => chat.service === activeService && chat.selected);
    const selected = shown ? `${shown.service}:${shown.key}` : selectedChat;
    unifiedList.replaceChildren(...chats.map((chat) => chatRow(chat, selected)));
  }

  unifiedList.addEventListener('pointerdown', () => {
    pointerDown = true;
  });
  const releasePointer = () => {
    if (!pointerDown) return;
    pointerDown = false;
    if (renderPending) {
      renderPending = false;
      setTimeout(renderUnifiedList, 0); // after the click has been dispatched
    }
  };
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);

  // Built with textContent only: names and messages come from the web pages
  function chatRow(chat, selected) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.classList.toggle('unread', !!chat.unread);
    row.classList.toggle('muted', !!chat.muted);
    row.classList.toggle('selected', selected === `${chat.service}:${chat.key}`);

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    const initials = document.createElement('div');
    initials.className = 'chat-initials';
    initials.textContent = String(chat.name || '?').trim().charAt(0).toUpperCase();
    if (/^(https:|data:image\/)/.test(chat.icon || '')) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.replaceWith(initials);
      img.src = chat.icon;
      avatar.appendChild(img);
    } else {
      avatar.appendChild(initials);
    }
    const serviceIcon = document.createElement('div');
    serviceIcon.className = 'chat-service';
    serviceIcon.innerHTML = SERVICES[chat.service].iconSVG;
    avatar.appendChild(serviceIcon);

    const main = document.createElement('div');
    main.className = 'chat-main';
    const top = document.createElement('div');
    top.className = 'chat-top';
    const name = document.createElement('div');
    name.className = 'chat-name';
    name.textContent = chat.name || '';
    const time = document.createElement('div');
    time.className = 'chat-time';
    time.textContent = chat.timeLabel || '';
    top.append(name, time);
    const preview = document.createElement('div');
    preview.className = 'chat-preview';
    preview.textContent = chat.preview || '';
    main.append(top, preview);

    row.append(avatar, main);
    row.addEventListener('click', () => openUnifiedChat(chat));
    return row;
  }

  function openUnifiedChat(chat) {
    selectedChat = `${chat.service}:${chat.key}`;
    showUnifiedView(chat.service);
    const webview = document.getElementById(`webview-${chat.service}`);
    try {
      webview.send('open-chat', chat.key);
    } catch (e) {
      console.error('Failed to open conversation:', e);
    }
  }

  // A tab that is not shown must not look focused to its page, otherwise the
  // page skips its own notifications
  function sendVisibility(webview, serviceKey) {
    try {
      webview.send('set-background', serviceKey !== activeService);
    } catch (e) {
      // Not attached yet - 'dom-ready' will send it
    }
  }

  // data: { id, tag, title, body, icon, silent, source: 'page' | 'chatlist' | 'title' }
  function forwardNotification(serviceKey, data) {
    // Fallback notifications (not issued by the page itself) are skipped
    // when the user is already looking at this service (or at the shared list)
    if (data.source !== 'page' && document.hasFocus() && (unifiedView || activeService === serviceKey)) return;

    const now = Date.now();
    for (const [key, entry] of recentNotifications) {
      if (now - entry.time > NOTIFICATION_DEDUP_WINDOW) recentNotifications.delete(key);
    }
    // Two notifications from the page itself with different tags are separate
    // messages (e.g. "ok" sent twice); reports from different layers are merged
    const dedupKey = normalizeText(`${serviceKey}|${data.title}|${data.body}`);
    const previous = recentNotifications.get(dedupKey);
    const separateMessages = previous && previous.source === 'page' && data.source === 'page' &&
      (previous.tag || '') !== (data.tag || '');
    if (previous && !separateMessages) return;
    recentNotifications.set(dedupKey, { time: now, source: data.source, tag: data.tag });

    window.electronAPI.showNotification({
      id: data.id,
      tag: data.tag,
      title: data.title,
      body: data.body,
      icon: data.icon,
      silent: data.silent,
      service: serviceKey,
    });
  }

  function handleTitleChange(serviceKey, title) {
    const match = title.match(/\((\d[\d\s.,\u00a0\u202f]*)\)/);
    // Messenger briefly flashes titles like "<Name> sent you a message": keep the last count
    if (!match && !/messenger|facebook|whatsapp/i.test(title)) return;
    const count = match ? parseInt(match[1].replace(/\D/g, '')) : 0;

    // Notifications for new messages are produced by the webview preload;
    // here we only keep the badges in sync
    unreadCounts[serviceKey] = count;
    updateBadges();
    updateDockBadge();
  }

  function updateBadges() {
    let total = 0;
    getEnabledServices().forEach((serviceKey) => {
      const count = unreadCounts[serviceKey] || 0;
      total += count;
      document.getElementById(`badge-${serviceKey}`)?.classList.toggle('visible', count > 0);
    });
    document.getElementById('badge-all')?.classList.toggle('visible', total > 0);
  }

  function updateDockBadge() {
    const total = Object.entries(unreadCounts)
      .filter(([serviceKey]) => settings.integrations[serviceKey])
      .reduce((sum, [, count]) => sum + count, 0);
    window.electronAPI.setBadgeCount(total);
  }

  // ===== SETTINGS =====
  settingsBtn.addEventListener('click', () => {
    settingsOverlay.classList.remove('hidden');
    syncSettingsUI();
    checkNotificationStatus();
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsOverlay.classList.add('hidden');
  });

  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) {
      settingsOverlay.classList.add('hidden');
    }
  });

  function syncSettingsUI() {
    ['messenger', 'whatsapp'].forEach((service) => {
      const intToggle = document.getElementById(`toggle-integration-${service}`);
      const notifToggle = document.getElementById(`toggle-notification-${service}`);

      if (intToggle) {
        intToggle.classList.toggle('active', settings.integrations[service]);
        intToggle.onclick = async () => {
          settings.integrations[service] = !settings.integrations[service];
          intToggle.classList.toggle('active', settings.integrations[service]);
          if (!settings.integrations[service]) delete unreadCounts[service];
          updateDockBadge();
          await window.electronAPI.saveSettings(settings);
          buildTabs();
          buildWebviews();
          applyView();
        };
      }

      if (notifToggle) {
        notifToggle.classList.toggle('active', settings.notifications[service]);
        notifToggle.onclick = async () => {
          settings.notifications[service] = !settings.notifications[service];
          notifToggle.classList.toggle('active', settings.notifications[service]);
          await window.electronAPI.saveSettings(settings);
        };
      }
    });

    const unifiedToggle = document.getElementById('toggle-unified-inbox');
    if (unifiedToggle) {
      unifiedToggle.classList.toggle('active', !!settings.unifiedInbox);
      unifiedToggle.onclick = async () => {
        settings.unifiedInbox = !settings.unifiedInbox;
        unifiedToggle.classList.toggle('active', settings.unifiedInbox);
        await window.electronAPI.saveSettings(settings);
        unifiedView = settings.unifiedInbox;
        feedRequestedAt = Date.now();
        buildTabs();
        document.querySelectorAll('webview').forEach((webview) => {
          try {
            webview.send('set-chat-feed', settings.unifiedInbox);
          } catch (e) {
            // Not attached yet - 'dom-ready' will send it
          }
        });
        applyView();
      };
    }

    const previewToggle = document.getElementById('toggle-notification-preview');
    if (previewToggle) {
      previewToggle.classList.toggle('active', settings.notificationPreview !== false);
      previewToggle.onclick = async () => {
        settings.notificationPreview = settings.notificationPreview === false;
        previewToggle.classList.toggle('active', settings.notificationPreview);
        await window.electronAPI.saveSettings(settings);
      };
    }
  }

  // ===== NOTIFICATION PERMISSION =====
  const requestPermissionBtn = document.getElementById('request-permission-btn');
  const openSystemSettingsBtn = document.getElementById('open-system-settings-btn');
  const permissionBadge = document.getElementById('permission-badge');
  const permissionBadgeText = document.getElementById('permission-badge-text');
  const permissionStatus = document.getElementById('notification-permission-status');

  async function checkNotificationStatus() {
    try {
      const status = await window.electronAPI.getNotificationStatus();
      if (status.supported) {
        permissionBadge.className = 'permission-status-badge granted';
        permissionBadgeText.textContent = 'Obsługiwane';
        permissionStatus.textContent = 'Powiadomienia systemowe są dostępne';
      } else {
        permissionBadge.className = 'permission-status-badge denied';
        permissionBadgeText.textContent = 'Niedostępne';
        permissionStatus.textContent = 'Powiadomienia systemowe nie są dostępne';
      }
    } catch (e) {
      permissionBadge.className = 'permission-status-badge unknown';
      permissionBadgeText.textContent = 'Nieznany';
      permissionStatus.textContent = 'Nie udało się sprawdzić statusu';
    }
  }

  if (requestPermissionBtn) {
    requestPermissionBtn.addEventListener('click', async () => {
      const btnSpan = requestPermissionBtn.querySelector('span');
      const originalText = btnSpan.textContent;
      
      btnSpan.textContent = 'Wysyłanie zapytania...';
      requestPermissionBtn.style.pointerEvents = 'none';

      try {
        const result = await window.electronAPI.requestNotificationPermission();
        
        if (result.triggered) {
          btnSpan.textContent = 'Zapytanie wysłane! ✓';
          requestPermissionBtn.classList.add('btn-permission-success');
          
          // Update status after a short delay
          setTimeout(async () => {
            await checkNotificationStatus();
          }, 1000);

          // Reset button after 3 seconds
          setTimeout(() => {
            btnSpan.textContent = originalText;
            requestPermissionBtn.classList.remove('btn-permission-success');
            requestPermissionBtn.style.pointerEvents = '';
          }, 3000);
        }
      } catch (e) {
        btnSpan.textContent = 'Błąd - spróbuj ponownie';
        setTimeout(() => {
          btnSpan.textContent = originalText;
          requestPermissionBtn.style.pointerEvents = '';
        }, 2000);
      }
    });
  }

  if (openSystemSettingsBtn) {
    openSystemSettingsBtn.addEventListener('click', async () => {
      await window.electronAPI.openNotificationSettings();
    });
  }

  // The Mac woke up from sleep: the pages will catch up on missed messages
  window.electronAPI.onSystemResumed(() => {
    document.querySelectorAll('webview').forEach((webview) => {
      try {
        webview.send('system-resumed');
      } catch (e) {
        // Not attached yet
      }
    });
  });

  // Notification clicked: show the service and let the page open the conversation
  window.electronAPI.onNotificationClicked(({ service, id }) => {
    const webview = document.getElementById(`webview-${service}`);
    if (!webview) return; // the service was turned off meanwhile
    selectedChat = null;
    if (unifiedView) showUnifiedView(service);
    else switchToService(service);
    if (id) {
      try {
        webview.focus();
        webview.send('notification-click', id);
      } catch (e) {
        console.error('Failed to forward notification click:', e);
      }
    }
  });

  // ===== INIT =====
  if (settings.setupDone) {
    showApp();
  } else {
    initSetup();
  }

})();
