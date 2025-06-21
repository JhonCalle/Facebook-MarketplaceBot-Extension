// popup.js – lógica del popup de la extensión modificada con límite configurable
// -----------------------------------------------------------------------------

// Añade una entrada de log a la lista en el popup
function addLogEntry(entry) {
  const logList = document.getElementById('logEntries');
  if (!logList) return;
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = entry;
  logList.prepend(div);
}

// Debug function para loguear mensajes y mostrarlos en el popup
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
  let scanLimit = 10; // valor por defecto, puede configurarse

  // Cargar estado actual y límite de mensajes desde storage
  chrome.storage.local.get(['autoResponderActive', 'lastCheckedTime', 'messageCount', 'scanLimit'], (result) => {
    isActive = !!result.autoResponderActive;
    messageCount = result.messageCount || 0;
    scanLimit = parseInt(result.scanLimit, 10) || scanLimit;

    // Reflejar valor en input
    if (scanLimitInput) scanLimitInput.value = scanLimit;

    updateUI();

    // Mostrar última verificación
    if (result.lastCheckedTime) {
      const date = new Date(result.lastCheckedTime);
      lastChecked.textContent = date.toLocaleString();
    }

    messagesProcessed.textContent = messageCount;
  });

  // Guardar nuevo valor de scanLimit
  if (saveScanLimitBtn && scanLimitInput) {
    saveScanLimitBtn.addEventListener('click', () => {
      let newLimit = parseInt(scanLimitInput.value, 10);
      if (isNaN(newLimit) || newLimit < 1) newLimit = 1;
      if (newLimit > 100) newLimit = 100;
      scanLimit = newLimit;
      chrome.storage.local.set({ scanLimit: scanLimit }, () => {
        debugLog(`Nuevo scanLimit guardado: ${scanLimit}`);
      });
    });
  }

  // Toggle handler
  toggleButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggleAutoResponder' }, (response) => {
      if (chrome.runtime.lastError) {
        debugLog('Error toggling auto-responder:', chrome.runtime.lastError.message);
        return;
      }
      isActive = response.isActive;
      updateUI();
      debugLog(`Auto-responder ${isActive ? 'enabled' : 'disabled'}`);
    });
  });

  // Recibe actualizaciones del background
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'updateStatus') {
      const date = new Date();
      lastChecked.textContent = date.toLocaleString();
      if (request.messageProcessed) {
        messageCount++;
        messagesProcessed.textContent = messageCount;
        chrome.storage.local.set({ messageCount });
        debugLog(`Responded to message in "${request.chatTitle || 'Unknown'}"`);
      }
    }
  });

  // Solicitar estado inicial
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (!chrome.runtime.lastError && response) {
      isActive = !!response.isActive;
      updateUI();
    }
  });

  // Actualiza UI basado en estado activo
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

  // --- Debugging functions ---
  const scanButtons = [
    { id: 'scanTitleButton', action: 'scanTitle' },
    { id: 'scanMessagesButton', action: 'scanMessages' },
    { id: 'scanTopChatsButton', action: 'scanTopChats' }
  ];

  // Asegura que content script esté inyectado y respondiendo
  async function ensureContentScript() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || !tabs[0].id) {
      debugLog('No active tab found');
      return false;
    }
    try {
      const pong = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      if (pong && pong.status === 'active') return true;
    } catch {}
    // Inyectar script si no responde
    await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
    await new Promise(res => setTimeout(res, 300));
    try {
      const retry = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      return retry && retry.status === 'active';
    } catch {
      return false;
    }
  }

  // Registrar listener de scan para cada botón
  function registerScan(buttonInfo) {
    const btn = document.getElementById(buttonInfo.id);
    btn.addEventListener('click', async () => {
      debugLog(`Scanning ${buttonInfo.action === 'scanMessages' ? `last ${scanLimit} messages` : buttonInfo.action}`);
      const ready = await ensureContentScript();
      if (!ready) {
        debugLog('Content script no disponible.');
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { action: buttonInfo.action }, response => {
          if (response) {
            if (response.title) {
              debugLog('Chat Title:', response.title);
            } else if (response.messages) {
              // Mostrar últimos N mensajes en lugar de primeros
              const msgs = response.messages.slice(-scanLimit);
              msgs.forEach((m, i) => {
                debugLog(`#${i+1} [${m.sender}]: ${m.text}`);
              });
            } else if (response.chats) {
              response.chats.forEach((c, i) => {
                debugLog(`#${i+1}: ${c.title} (ID: ${c.id})`);
              });
            }
          } else {
            debugLog('No response from content script');
          }
        });
      });
    });
  }

  scanButtons.forEach(registerScan);
});
