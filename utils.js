(() => {
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

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

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

  function dataURLToBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

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

  window.MPUtils = { waitFor, delay, pause, dataURLToBlob, formatRepliesForPreview, Storage };
})();
