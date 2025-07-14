/**
 * background.js – service worker keeping global extension state.
 * It relays messages between the popup and content scripts and
 * starts/stops the polling that checks for new Marketplace chats.
 */

// Keeps track of whether the auto-responder is enabled.
let isAutoResponderActive = false;

// Convenience logger used across handlers.
function debugLog(message, data) {
  console.log(`[Marketplace Bot - Background] ${message}`, data || '');
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Individual message handlers keyed by the action name.
 * Each handler returns `true` when `sendResponse` should remain open.
 */
const messageHandlers = {
  // Fetch image as data URL to bypass CORS for content script
  async fetchImage(req, sendResponse) {
    debugLog('[fetchImage] Start', req.url);
    try {
      debugLog('[fetchImage] Fetching URL', req.url);
      const response = await fetch(req.url);
      debugLog('[fetchImage] Fetch response', response);
      if (!response.ok) {
        debugLog('[fetchImage] Response not OK', response.status);
        sendResponse({ success: false, error: 'HTTP error: ' + response.status });
        return true;
      }
      const blob = await response.blob();
      debugLog('[fetchImage] Blob created', blob);
      const reader = new FileReader();
      reader.onloadend = () => {
        debugLog('[fetchImage] FileReader onloadend', reader.result);
        sendResponse({ success: true, dataUrl: reader.result });
      };
      reader.onerror = (err) => {
        debugLog('[fetchImage] FileReader onerror', err);
        sendResponse({ success: false, error: 'Failed to read image blob' });
      };
      debugLog('[fetchImage] Reading blob as data URL');
      reader.readAsDataURL(blob);
    } catch (e) {
      debugLog('[fetchImage] Exception', e);
      sendResponse({ success: false, error: e.message });
    }
    debugLog('[fetchImage] Handler end');
    return true; // keep channel open for async sendResponse
  },
  toggleAutoResponder(_req, sendResponse) {
    isAutoResponderActive = !isAutoResponderActive;
    chrome.storage.local.set({ autoResponderActive: isAutoResponderActive });

    if (isAutoResponderActive) {
      startMessageChecker();
    } else {
      stopMessageChecker();
    }

    sendResponse({ isActive: isAutoResponderActive });
    debugLog('Auto-responder toggled:', isAutoResponderActive);
    return true;
  },

  getStatus(_req, sendResponse) {
    sendResponse({ isActive: isAutoResponderActive });
    return true;
  },

  processNewMessage(req) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'processMessage',
          messageData: req.messageData
        }).catch(err => debugLog('Error forwarding processMessage:', err));
      }
    });
    return false;
  },

  log(req) {
    chrome.runtime.sendMessage({
      action: 'logToPopup',
      message: req.message,
      data: req.data
    }).catch(err => {
      console.log(`[Marketplace Bot Log] ${req.message}`, req.data || '');
      debugLog('Error forwarding log:', err);
    });
    return false;
  },

  ping(_req, sendResponse) {
    sendResponse({ status: 'active' });
    return true;
  }
};

// Central message dispatcher
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  debugLog('Received message:', request.action);

  const handler = messageHandlers[request.action];
  if (!handler) return false;

  try {
    return handler(request, sendResponse);
  } catch (error) {
    debugLog('Error in message handler:', error);
    sendResponse({ error: error.message });
    return true;
  }
});

// Load the saved state when the extension starts
chrome.runtime.onStartup.addListener(loadState);
chrome.runtime.onInstalled.addListener(loadState);

function loadState() {
  chrome.storage.local.get(['autoResponderActive'], (result) => {
    isAutoResponderActive = result.autoResponderActive || false;
    
    if (isAutoResponderActive) {
      startMessageChecker();
    }
  });
}

let messageCheckInterval;

function startMessageChecker() {
  // Process unread chats every 30 seconds
  messageCheckInterval = setInterval(() => {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && (tabs[0].url.includes('facebook.com/messages') || tabs[0].url.includes('messenger.com/marketplace'))) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'processOldestUnread' }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.processed) {
            debugLog('Processed unread chat:', res.chatTitle);
          }
        });
      }
    });
  }, 30000); // 30 seconds
}

function stopMessageChecker() {
  if (messageCheckInterval) {
    clearInterval(messageCheckInterval);
    messageCheckInterval = null;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchImage') {
    console.log('Background script received fetchImage request', request); // ADDED
    try {
      fetch(request.url)
        .then(response => {
          console.log('Background script fetch response', response); // ADDED
          return response.blob();
        })
        .then(blob => {
          console.log('Background script got blob', blob); // ADDED
          const reader = new FileReader();
          reader.onloadend = () => {
            console.log('Background script sending dataUrl response'); // ADDED
            sendResponse({ success: true, dataUrl: reader.result });
          };
          reader.readAsDataURL(blob);
        })
        .catch(error => {
          console.error('Background script fetch error', error); // ADDED
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep the message channel open for sendResponse
    } catch (e) {
      console.error('Background script error', e); // ADDED
      sendResponse({ success: false, error: e.message });
      return true;
    }
  }
});
