document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBotButton');
  const stopBtn = document.getElementById('stopBotButton');
  const statusEl = document.getElementById('status');

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

  // Initial status
  setStatus('Ready.');
});
