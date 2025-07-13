// Minimal popup for production

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBotButton');

  async function ensureContentScript() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return false;
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
      return false;
    }
  }

  startBtn?.addEventListener('click', async () => {
    const ready = await ensureContentScript();
    if (!ready) return;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'startBot' });
    });
    window.close();
  });

  // Add Stop Bot button functionality
  const stopBtn = document.getElementById('stopBotButton');
  stopBtn?.addEventListener('click', async () => {
    const ready = await ensureContentScript();
    if (!ready) return;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'stopBot' });
    });
    window.close();
  });
});
