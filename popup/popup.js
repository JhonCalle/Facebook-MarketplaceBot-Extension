document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBotButton');
  const stopBtn = document.getElementById('stopBotButton');
  const statusEl = document.getElementById('status');
  const sendImageBtn = document.getElementById('sendImageButton');
  const imageUrlInput = document.getElementById('imageUrlInput');
  const imageMethodSelect = document.getElementById('imageMethodSelect');

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

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

  startBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Starting bot...');
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

  stopBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Stopping bot...');
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

  sendImageBtn?.addEventListener('click', async () => {
    const url = imageUrlInput.value.trim();
    const method = imageMethodSelect.value;
    // Accept any http(s) URL for testing
    const valid = /^https?:\/\/.+/i.test(url);
    if (!valid) {
      setStatus('Enter a valid image URL.', true);
      return;
    }
    sendImageBtn.disabled = true;
    setStatus('Sending image...');
    const ready = await ensureContentScript();
    if (!ready) {
      setStatus('Not a supported page. Open Facebook Messenger.', true);
      sendImageBtn.disabled = false;
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { action: 'sendTestImage', url, method },
        res => {
          sendImageBtn.disabled = false;
          if (chrome.runtime.lastError || !res?.sent) {
            setStatus('Failed to send image.', true);
          } else {
            setStatus('Image sent!');
          }
        }
      );
    });
  });

  // Initial status
  setStatus('Ready.');
});
