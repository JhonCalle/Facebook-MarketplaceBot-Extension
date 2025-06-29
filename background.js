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
