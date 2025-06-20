// Store the state of the auto-responder
let isAutoResponderActive = false;

// Debug logging function
function debugLog(message, data) {
  console.log(`[Marketplace Bot - Background] ${message}`, data || '');
}

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  debugLog('Received message:', request.action);
  
  try {
    switch (request.action) {
      case 'toggleAutoResponder':
        isAutoResponderActive = !isAutoResponderActive;
        // Save the state to chrome.storage
        chrome.storage.local.set({ autoResponderActive: isAutoResponderActive });
        
        // Start/stop the message checker based on the state
        if (isAutoResponderActive) {
          startMessageChecker();
        } else {
          stopMessageChecker();
        }
        
        // Send response back to the sender
        sendResponse({ isActive: isAutoResponderActive });
        debugLog('Auto-responder toggled:', isAutoResponderActive);
        return true; // Required for async sendResponse
        
      case 'getStatus':
        sendResponse({ isActive: isAutoResponderActive });
        return true;
        
      case 'processNewMessage':
        // Forward message processing to content script
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'processMessage',
              messageData: request.messageData
            }).catch(err => {
              debugLog('Error sending processMessage to tab:', err);
            });
          }
        });
        break;
        
      case 'log':
        // Forward logs to the popup if it's open
        chrome.runtime.sendMessage({
          action: 'logToPopup',
          message: request.message,
          data: request.data
        }).catch(err => {
          console.log(`[Marketplace Bot Log] ${request.message}`, request.data || '');
        });
        break;
        
      case 'ping':
        // Simple ping to check if background script is active
        sendResponse({ status: 'active' });
        return true;
    }
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
  // Check for new messages every 30 seconds
  messageCheckInterval = setInterval(() => {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && (tabs[0].url.includes('facebook.com/messages') || tabs[0].url.includes('messenger.com/marketplace'))) {
        // Send message to content script to check for new messages
        chrome.tabs.sendMessage(tabs[0].id, { action: 'checkForNewMessages' });
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
