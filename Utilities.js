(() => {
  /**
   * Wait until `conditionFn` returns true or the timeout expires.
   * @param {Function} conditionFn Function evaluated periodically
   * @param {number} interval Poll interval in ms
   * @param {number} timeout Max time to wait in ms
   */
  function waitFor(conditionFn, interval = 100, timeout = 5000) {
    return new Promise(resolve => {
      const start = Date.now();
      let id;
      const check = () => {
        if (conditionFn()) {
          clearTimeout(id);
          return resolve(true);
        }
        if (Date.now() - start > timeout) {
          clearTimeout(id);
          return resolve(false);
        }
        id = setTimeout(check, interval);
      };
      check();
    });
  }

  /** Simple async delay helper */
  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Pause execution while keeping the overlay updated with a countdown.
   * Resolves earlier if the global `isCycling` flag is cleared.
   */
  async function pause(ms, step, lines = []) {
    return new Promise(resolve => {
      const end = Date.now() + ms;
      let timer;
      const tick = () => {
        if (!window.isCycling) {
          clearTimeout(timer);
          return resolve();
        }
        const remaining = end - Date.now();
        if (step) {
          window.Overlay?.updateStep(step, lines, `${Math.ceil(remaining / 1000)}s`);
        }
        if (remaining <= 0) {
          clearTimeout(timer);
          return resolve();
        }
        timer = setTimeout(tick, 500);
      };
      tick();
    });
  }

  /** Convert a data URL to a Blob instance */
  function dataURLToBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /**
   * Format replies objects into display friendly strings.
   * Accepts either a single reply or an array.
   */
  function formatRepliesForPreview(replies) {
    return (Array.isArray(replies) ? replies : [replies]).map(r => {
      if (typeof r === 'object' && r !== null) {
        if (r.type === 'image' && r.url) return `[Image] ${r.url}`;
        if (r.type === 'text' && (r.content || r.text)) return r.content || r.text;
        return JSON.stringify(r, null, 2);
      }
      return String(r);
    });
  }

  const Storage = {
    async getNumber(key, fallback) {
      return new Promise(resolve => {
        chrome.storage.local.get([key], result => {
          resolve(parseInt(result[key], 10) || fallback);
        });
      });
    },
    async getString(key, fallback) {
      return new Promise(resolve => {
        chrome.storage.local.get([key], result => {
          resolve(result[key] || fallback);
        });
      });
    },
    async set(key, value) {
      return new Promise(resolve => {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      });
    }
  };

  /**
   * Fetch an image URL via the background script to avoid CORS issues.
   * Resolves to a data URL string.
   */
  function fetchImageViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchImage', url }, response => {
        if (response && response.success) {
          resolve(response.dataUrl);
        } else {
          reject(response ? response.error : 'Unknown error');
        }
      });
    });
  }

  /**
   * Scan the chat list and return an array of unread conversations.
   * @param {object} selectors Object containing the chat row selectors.
   */
  function checkForNewMessages(selectors) {
    const unread = [];
    const chatLinks = document.querySelectorAll(selectors.topChatLinks);
    chatLinks.forEach(link => {
      const row = link.closest('[role="row"], li');
      if (!row) return;
      const hasBadge = row.querySelector('[aria-label*="unread" i], [aria-label*="nuevo" i], [aria-label*="new message" i]');
      if (hasBadge) {
        const id = (link.href.match(/\/t\/([^/?#]+)/) || [])[1];
        const title = link.getAttribute('aria-label')?.trim() || link.textContent.trim();
        if (id) unread.push({ id, title });
      }
    });
    return unread;
  }

  // Expose helpers globally for the content script
  window.MPUtils = {
    waitFor,
    delay,
    pause,
    dataURLToBlob,
    formatRepliesForPreview,
    Storage,
    fetchImageViaBackground,
    checkForNewMessages
  };
})();
