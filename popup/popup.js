// popup.js – UI logic for the extension popup
// This script drives the popup controls and debug tools.

function addLogEntry(entry) {
  const logList = document.getElementById('logEntries');
  if (!logList) return;
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = entry;
  logList.prepend(div);
  while (logList.children.length > 10) {
    logList.removeChild(logList.lastChild);
  }
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
  const stepEl            = document.getElementById('currentStep');
  const titleEl           = document.getElementById('chatTitle');
  const clientEl          = document.getElementById('clientName');
  const chatListEl        = document.getElementById('chatList');
  const apiStatusEl       = document.getElementById('apiStatus');
  const apiRespEl         = document.getElementById('apiResponse');

  let isActive = false;
  let messageCount = 0;

  // Cargar estado
  chrome.storage.local.get(['autoResponderActive', 'lastCheckedTime', 'messageCount'], (result) => {
    isActive      = !!result.autoResponderActive;
    messageCount  = result.messageCount || 0;
    updateUI();
    if (result.lastCheckedTime) {
      lastChecked.textContent = new Date(result.lastCheckedTime).toLocaleString();
    }
    messagesProcessed.textContent = messageCount;
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
    } else if (request.action === 'logToPopup') {
      if (request.message) debugLog(request.message, request.data);
      const data = request.data || {};
      if (data.step && stepEl) {
        stepEl.textContent = data.step;
        stepEl.className = `state ${data.state || 'waiting'}`;
      }
      if (data.chatTitle && titleEl) {
        titleEl.textContent = data.chatTitle;
      }
      if (data.clientName && clientEl) {
        clientEl.textContent = data.clientName;
      }
      if (Array.isArray(data.chatList) && chatListEl) {
        chatListEl.innerHTML = '';
        data.chatList.forEach(c => {
          const li = document.createElement('li');
          li.textContent = c.title;
          if (c.unread) li.classList.add('unread');
          chatListEl.appendChild(li);
        });
      }
      if (data.apiStatus && apiStatusEl) {
        apiStatusEl.textContent = data.apiStatus;
      }
      if (data.reply && apiRespEl) {
        apiRespEl.textContent = data.reply;
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

  // Refresh popup controls based on current extension state
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
  // Ensures the content script is loaded on the active tab.
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

});