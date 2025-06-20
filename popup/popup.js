// Función que añade una entrada de log a la lista en el popup
function addLogEntry(entry) {
  const logList = document.getElementById('logEntries');
  if (!logList) return;
  const li = document.createElement('li');
  li.textContent = entry;
  logList.appendChild(li);
}

// Debug function to log messages
function debugLog(message, data) {
  console.log(`[Marketplace Bot - Popup] ${message}`, data || '');
  addLogEntry(`${message}${data ? ' - ' + JSON.stringify(data) : ''}`);
}

document.addEventListener('DOMContentLoaded', async () => {
  const toggleButton      = document.getElementById('toggleButton');
  const statusDot         = document.getElementById('statusDot');
  const statusText        = document.getElementById('statusText');
  const lastChecked       = document.getElementById('lastChecked');
  const messagesProcessed = document.getElementById('messagesProcessed');
  const logEntries        = document.getElementById('logEntries');

  let isActive = false;
  let messageCount = 0;

  // Load the current state from storage
  chrome.storage.local.get(['autoResponderActive', 'lastCheckedTime', 'messageCount'], (result) => {
    isActive = result.autoResponderActive || false;
    messageCount = result.messageCount || 0;

    updateUI();

    if (result.lastCheckedTime) {
      const date = new Date(result.lastCheckedTime);
      lastChecked.textContent = date.toLocaleString();
    }

    messagesProcessed.textContent = messageCount;
  });

  // Toggle button click handler
  toggleButton.addEventListener('click', () => {
    isActive = !isActive;
    chrome.runtime.sendMessage(
      { action: 'toggleAutoResponder' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('Error toggling auto-responder:', chrome.runtime.lastError);
          isActive = !isActive;
          updateUI();
          return;
        }
        isActive = response.isActive;
        updateUI();
        addLogEntry(`Auto-responder ${isActive ? 'enabled' : 'disabled'}`);
      }
    );
  });

  // Listen for updates from the background script
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'updateStatus') {
      const date = new Date();
      lastChecked.textContent = date.toLocaleString();
      if (request.messageProcessed) {
        messageCount++;
        messagesProcessed.textContent = messageCount;
        chrome.storage.local.set({ messageCount });
        addLogEntry(`Responded to message in "${request.chatTitle || 'Unknown'}"`);
      }
    }
  });

  // Update the UI based on the current state
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

  // Request the current status from the background script
  chrome.runtime.sendMessage(
    { action: 'getStatus' },
    (response) => {
      if (!chrome.runtime.lastError && response) {
        isActive = response.isActive || false;
        updateUI();
      }
    }
  );

  // --- Debugging functions ---
  const scanTitleButton = document.getElementById('scanTitleButton');
  const scanMessagesButton = document.getElementById('scanMessagesButton');
  let isContentScriptReady = false;

  async function checkContentScriptReady() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !tabs[0].id) {
        debugLog('No active tab found');
        return false;
      }
      const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      isContentScriptReady = response && response.status === 'active';
      if (!isContentScriptReady) {
        debugLog('Content script not responding to ping, trying to inject...');
        await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
        await new Promise(resolve => setTimeout(resolve, 500));
        const retryResponse = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
        isContentScriptReady = retryResponse && retryResponse.status === 'active';
      }
      debugLog(isContentScriptReady ? 'Content script is ready' : 'Could not initialize content script');
      return isContentScriptReady;
    } catch (error) {
      debugLog('Error checking content script:', error);
      return false;
    }
  }

  async function initialize() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0] && tabs[0].url.includes('messenger.com/marketplace')) {
        await checkContentScriptReady();
      } else {
        debugLog('Please open a Messenger Marketplace chat to use this extension');
      }
    } catch (error) {
      debugLog('Initialization error:', error);
    }
  }

  scanTitleButton.addEventListener('click', async () => {
    const isReady = await checkContentScriptReady();
    if (isReady) {
      sendMessageToContentScript({ action: 'scanTitle' });
    } else {
      debugLog('Cannot scan title: Content script not ready');
    }
  });

  scanMessagesButton.addEventListener('click', async () => {
    const isReady = await checkContentScriptReady();
    if (isReady) {
      sendMessageToContentScript({ action: 'scanMessages' });
    } else {
      debugLog('Cannot scan messages: Content script not ready');
    }
  });

  async function sendMessageToContentScript(message) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !tabs[0].id) {
        debugLog('No active tab found');
        return;
      }
      debugLog('Sending message to content script:', message.action);
      const response = await chrome.tabs.sendMessage(tabs[0].id, message);
      if (response) {
        if (response.error) {
          debugLog('Error from content script:', response.error);
        } else if (response.title) {
          debugLog('Chat Title:', response.title);
        } else if (response.messages) {
          debugLog(`Found ${response.messages.length} messages:`, response.messages.map(m => m.text));
        }
      } else {
        debugLog('No response from content script');
      }
    } catch (error) {
      debugLog('Error sending message to content script:', error.message);
      if (error.message.includes('Could not establish connection')) {
        debugLog('Attempting to inject content script...');
        const isReady = await checkContentScriptReady();
        if (isReady) {
          debugLog('Retrying original message...');
          await new Promise(resolve => setTimeout(resolve, 300));
          sendMessageToContentScript(message);
        }
      }
    }
  }

  // Listener para el botón de recarga de script
  const reloadScriptButton = document.getElementById('reloadScriptButton');
  reloadScriptButton.addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !tabs[0].id) {
        debugLog('No active tab found');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        files: ['content.js']
      });
      debugLog('Content script re-injected!');
    } catch (error) {
      debugLog('Error re-injecting script:', error.message);
    }
  });

  initialize();
});
