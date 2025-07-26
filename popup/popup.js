document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBotButton');
  const stopBtn = document.getElementById('stopBotButton');
  const webhookInput = document.getElementById('webhookUrlInput');
  const statusEl = document.getElementById('status');
  const extractBtn = document.getElementById('extractLastMessagesButton');

  const DEFAULT_WEBHOOK = 'https://n8nimpulsa.zapto.org/webhook/ImpulsaAIbot';

  // Load saved webhook URL when popup opens
  chrome.storage.local.get(['webhookUrl'], (res) => {
    webhookInput.value = res.webhookUrl || DEFAULT_WEBHOOK;
  });

  // Persist webhook URL whenever the field changes
  webhookInput.addEventListener('change', () => {
    chrome.storage.local.set({ webhookUrl: webhookInput.value });
  });

  /**
   * Display a status message in the popup and optionally mark it as error.
   * @param {string|object} msg
   * @param {boolean} [isError=false]
   */
  function setStatus(msg, isError = false) {
    if (typeof msg === 'object' && msg !== null) {
      statusEl.textContent = JSON.stringify(msg, null, 2);
    } else {
      statusEl.textContent = msg || '';
    }
    statusEl.classList.toggle('error', !!isError);
  }

  /**
   * Ensure the content script is injected into the active tab.
   * Returns true when messaging is possible.
   */
  async function ensureContentScript() {
    setStatus('Checking page...');
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      setStatus('No active tab found.', true);
      return false;
    }
    try {
      const pong = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      if (pong?.status === 'active') return true;
    } catch {}
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
    } catch {}
    await new Promise(res => setTimeout(res, 300));
    try {
      const retry = await chrome.tabs.sendMessage(tabs[0].id, { action: 'ping' });
      return retry?.status === 'active';
    } catch {
      setStatus('Could not inject content script.', true);
      return false;
    }
  }

  // Start bot button handler
  startBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Starting bot...');
    chrome.storage.local.set({ webhookUrl: webhookInput.value });
    const ready = await ensureContentScript();
    if (!ready) {
      setStatus('Not a supported page. Open Facebook Messenger.', true);
      startBtn.disabled = false;
      stopBtn.disabled = false;
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'startBot' }, () => {
        setStatus('Bot started!');
        setTimeout(() => window.close(), 900);
      });
    });
  });

  // Stop bot button handler
  stopBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Stopping bot...');
    chrome.storage.local.set({ webhookUrl: webhookInput.value });
    const ready = await ensureContentScript();
    if (!ready) {
      setStatus('Not a supported page. Open Facebook Messenger.', true);
      startBtn.disabled = false;
      stopBtn.disabled = false;
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'stopBot' }, () => {
        setStatus('Bot stopped.');
        setTimeout(() => window.close(), 900);
      });
    });
  });

  // Extract Last Messages button handler
  extractBtn?.addEventListener('click', async () => {
    extractBtn.disabled = true;
    setStatus('Extracting last messages...');
    const ready = await ensureContentScript();
    if (!ready) {
      setStatus('Not a supported page. Open Facebook Messenger.', true);
      extractBtn.disabled = false;
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { action: 'scanMessages', limit: 20 },
        (response) => {
          if (chrome.runtime.lastError) {
            setStatus('Error: ' + chrome.runtime.lastError.message, true);
            extractBtn.disabled = false;
            return;
          }
          if (response && response.messages) {
            setStatus(response.messages);
          } else if (response && response.error) {
            setStatus('Error: ' + response.error, true);
          } else {
            setStatus('No messages found or unknown error.', true);
          }
          extractBtn.disabled = false;
        }
      );
    });
  });

  // Display initial status
  setStatus('Ready.');
});