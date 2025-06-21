// popup.js – lógica del popup de la extensión con límite configurable + ciclo de chats
// -----------------------------------------------------------------------------

function addLogEntry(entry) {
  const logList = document.getElementById('logEntries');
  if (!logList) return;
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = entry;
  logList.prepend(div);
}

function debugLog(message, data) {
  console.log(`[Marketplace Bot - Popup] ${message}`, data || '');
  const logText = data !== undefined ? `${message} - ${JSON.stringify(data)}` : message;
  addLogEntry(logText);
}


document.addEventListener('DOMContentLoaded', () => {
  const toggleButton      = document.getElementById('toggleButton');
  const statusDot         = document.getElementById('statusDot');
  const statusText        = document.getElementById('statusText');
  const lastChecked       = document.getElementById('lastChecked');
  const messagesProcessed = document.getElementById('messagesProcessed');
  const scanLimitInput    = document.getElementById('scanLimitInput');
  const saveScanLimitBtn  = document.getElementById('saveScanLimitBtn');

  let isActive = false;
  let messageCount = 0;
  let scanLimit = 10;

  // Cargar estado
  chrome.storage.local.get(['autoResponderActive', 'lastCheckedTime', 'messageCount', 'scanLimit'], (result) => {
    isActive      = !!result.autoResponderActive;
    messageCount  = result.messageCount || 0;
    scanLimit     = parseInt(result.scanLimit, 10) || scanLimit;
    if (scanLimitInput) scanLimitInput.value = scanLimit;
    updateUI();
    if (result.lastCheckedTime) {
      lastChecked.textContent = new Date(result.lastCheckedTime).toLocaleString();
    }
    messagesProcessed.textContent = messageCount;

    // ────────────────────────────────────────────────────────────────────
    // Nueva UI minimalista: selector de cantidad + botón EMPEZAR
    // Ocultar secciones antiguas que ya no se usan
    document.querySelectorAll('.debug-section, .status-container, .info-section').forEach(el => {
      if (el) el.style.display = 'none';
    });

    const container = document.querySelector('.container');
    if (container && !document.getElementById('chatCountInput')) {
      const controlDiv = document.createElement('div');
      controlDiv.style.padding = '15px';
      controlDiv.innerHTML = `
        <label for="chatCountInput" style="font-size:13px;">Cantidad de chats a escanear:</label>
        <input type="number" id="chatCountInput" min="1" max="100" value="${scanLimit}" style="width:60px; margin-left:8px;" />
        <button id="startScanBtn" style="margin-left:8px; padding:6px 12px; background:#1877f2; color:#fff; border:none; border-radius:4px; cursor:pointer;">EMPEZAR</button>
      `;
      container.insertBefore(controlDiv, container.children[1]);

      const chatCountInput = document.getElementById('chatCountInput');
      const startScanBtn   = document.getElementById('startScanBtn');

      startScanBtn.addEventListener('click', async () => {
        let chatLimit = parseInt(chatCountInput.value, 10);
        if (isNaN(chatLimit) || chatLimit < 1) chatLimit = 1;
        if (chatLimit > 100) chatLimit = 100;
        chrome.storage.local.set({ chatLimit });

        const ready = await ensureContentScript();
        if (!ready) { debugLog('Content script no disponible.'); return; }

        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'startBot', chatLimit }, resp => {
            debugLog('Bot iniciado', resp);
          });
        });
      });
    }
  });

  // Guardar nuevo scanLimit
  saveScanLimitBtn?.addEventListener('click', () => {
    let newLimit = parseInt(scanLimitInput.value, 10);
    if (isNaN(newLimit) || newLimit < 1) newLimit = 1;
    if (newLimit > 100) newLimit = 100;
    scanLimit = newLimit;
    chrome.storage.local.set({ scanLimit }, () => debugLog(`Nuevo scanLimit guardado: ${scanLimit}`));
  });

  // Toggle auto‑responder
  toggleButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggleAutoResponder' }, response => {
      if (chrome.runtime.lastError) {
        debugLog('Error toggling auto-responder:', chrome.runtime.lastError.message);
        return;
      }
      isActive = response.isActive;
      updateUI();
      debugLog(`Auto-responder ${isActive ? 'enabled' : 'disabled'}`);
    });
  });

  // Listener de estado proveniente de background
  chrome.runtime.onMessage.addListener(request => {
    if (request.action === 'updateStatus') {
      lastChecked.textContent = new Date().toLocaleString();
      if (request.messageProcessed) {
        messageCount++;
        messagesProcessed.textContent = messageCount;
        chrome.storage.local.set({ messageCount });
        debugLog(`Responded to message in "${request.chatTitle || 'Unknown'}"`);
      }
    }
  });

  // Obtener estado inicial
  chrome.runtime.sendMessage({ action: 'getStatus' }, response => {
    if (!chrome.runtime.lastError && response) {
      isActive = !!response.isActive;
      updateUI();
    }
  });

  function updateUI() {
    if (isActive) {
      statusDot.classList.add('active');
      statusText.textContent = 'Active';
      toggleButton.classList.add('active');
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = 'Inactive';
      toggleButton.classList.remove('active');
    }
  }

  // ----- UTILITIES -----
  async function ensureContentScript() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) {
      debugLog('No active tab found');
      return false;
    }
    try {
      const pong = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      if (pong?.status === 'active') return true;
    } catch {}
    await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
    await new Promise(res => setTimeout(res, 300));
    try {
      const retry = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      return retry?.status === 'active';
    } catch {
      return false;
    }
  }

  // ---- Botones de debug / acciones ----
  const scanButtons = [
    { id: 'scanTitleButton',           action: 'scanTitle' },
    { id: 'scanMessagesButton',        action: 'scanMessages' },
    { id: 'scanTopChatsButton',        action: 'scanTopChats' },
    { id: 'scanChatsDetailedButton',   action: 'scanChatsDetailed' },
    { id: 'sendTestReplyButton',       action: 'sendTestReply' },   // <‑‑ NUEVO
    { id: 'cycleChatsButton',          action: 'cycleChats' }
  ];

  scanButtons.forEach(({ id, action }) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      debugLog(`Ejecutando acción: ${action}`);
      const ready = await ensureContentScript();
      if (!ready) { debugLog('Content script no disponible.'); return; }

      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { action }, response => {
          if (!response) { debugLog('Sin respuesta del content script.'); return; }

          if (action === 'sendTestReply') {
            debugLog(response.sent ? 'Mensaje enviado ✔️' : 'No se pudo enviar el mensaje ❌');
            return;
          }

          // --- manejadores existentes ---
          if (response.chatsData) {
            const jsonStr = JSON.stringify(response.chatsData, null, 2);
            debugLog('JSON chatsData:', jsonStr);
            return;
          }
          if (response.chats) {
            response.chats.forEach((c, i) => debugLog(`#${i + 1}: ${c.title} (ID: ${c.id})`));
          } else if (response.messages) {
            response.messages.forEach((m, i) => debugLog(`#${i + 1} [${m.sender}]: ${m.text}`));
          } else if (response.title) {
            debugLog(`Chat title: ${response.title}`);
          }
        });
      });
    });
  });
});