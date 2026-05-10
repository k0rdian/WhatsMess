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

  // DOM references
  const setupScreen = document.getElementById('setup-screen');
  const appScreen = document.getElementById('app-screen');
  const setupContinueBtn = document.getElementById('setup-continue-btn');
  const tabsContainer = document.getElementById('tabs-container');
  const webviewContainer = document.getElementById('webview-container');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const closeSettingsBtn = document.getElementById('close-settings-btn');

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

  // Notification throttle: don't spam same service
  const lastNotificationTime = {};
  const NOTIFICATION_COOLDOWN = 30000; // 30 seconds

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
  }

  function buildTabs() {
    tabsContainer.innerHTML = '';
    const enabledServices = Object.entries(settings.integrations)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);

    enabledServices.forEach((serviceKey, index) => {
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

      if (index === 0) {
        activeService = serviceKey;
        tab.classList.add('active');
      }
    });
  }

  function buildWebviews() {
    webviewContainer.innerHTML = '';
    const enabledServices = Object.entries(settings.integrations)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);

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
        if (e.channel === 'notification') {
          const data = e.args[0];
          sendThrottledNotification(serviceKey, data.title, data.body);
        }
      });

      webviewContainer.appendChild(webview);
      webviewContainer.appendChild(loading);
    });
  }

  function switchToService(serviceKey) {
    if (activeService === serviceKey) return;
    activeService = serviceKey;

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.service === serviceKey);
    });

    document.querySelectorAll('webview').forEach((wv) => {
      wv.classList.toggle('active', wv.id === `webview-${serviceKey}`);
    });
  }

  function sendThrottledNotification(serviceKey, title, body) {
    const now = Date.now();
    if (lastNotificationTime[serviceKey] && (now - lastNotificationTime[serviceKey]) < NOTIFICATION_COOLDOWN) {
      return; // Throttled
    }
    lastNotificationTime[serviceKey] = now;
    window.electronAPI.showNotification({
      title: title,
      body: body,
      service: serviceKey,
    });
  }

  function handleTitleChange(serviceKey, title) {
    const match = title.match(/\((\d+)\)/);
    const badge = document.getElementById(`badge-${serviceKey}`);
    if (badge) {
      badge.classList.toggle('visible', !!match && parseInt(match[1]) > 0);
    }

    // Forward notification if count increased and tab is not active
    if (match && parseInt(match[1]) > 0 && serviceKey !== activeService) {
      const count = parseInt(match[1]);
      sendThrottledNotification(
        serviceKey,
        SERVICES[serviceKey].name,
        `Masz ${count} nieprzeczytanych wiadomości`
      );
    }
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
          await window.electronAPI.saveSettings(settings);
          buildTabs();
          buildWebviews();
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

  // Listen for service switch from main process (when notification is clicked)
  window.electronAPI.onSwitchToService((service) => {
    switchToService(service);
  });

  // ===== INIT =====
  if (settings.setupDone) {
    showApp();
  } else {
    initSetup();
  }

  // Listen for messages from webviews (notification forwarding via postMessage)
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'WHATSMESS_NOTIFICATION') {
      sendThrottledNotification(event.data.service, event.data.title, event.data.body);
    }
  });
})();
