// =============================================================================
// content.js – Marketplace Bot content‑script (refactored for robustness)
// =============================================================================
// Responsibilities
// 1. Scan Marketplace chat list, open each chat, collect the last N messages
// 2. Provide data back to the popup via chrome.runtime messaging
// 3. (Future) Send collected data to an external API and post the reply
// -----------------------------------------------------------------------------
// Design notes
// • All chrome messaging strings are declared as constants
// • Heavy DOM selectors are centralised in SELECTORS to ease maintenance
// • Timeouts / limits are configurable via CONFIG and overridable from storage
// • Public interface is exposed through the global MarketplaceBot object to
//   simplify testing from the console (`window.MarketplaceBot.*`)
// • Every async flow is wrapped in try/catch and logs meaningful errors 
// • Next‑phase hooks: ApiClient.sendChat() and Messenger.sendMessage()
// =============================================================================

(() => {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────────
  // Constants & Config
  // ────────────────────────────────────────────────────────────────────────────
  const MSG = {
    PING:              'ping',
    SCAN_TITLE:        'scanTitle',
    SCAN_MESSAGES:     'scanMessages',
    SCAN_TOP:          'scanTopChats',
    CYCLE_CHATS:       'cycleChats',
    SCAN_DETAILED:     'scanChatsDetailed',
    SEND_TEST_REPLY:   'sendTestReply',
    CHECK_NEW:         'checkForNewMessages',
    LOG:               'log'
  };

  const CONFIG = {
    DEFAULT_CHAT_LIMIT   : 10,
    DEFAULT_MSG_LIMIT    : 10,
    DEFAULT_DELAY_MS     : 1500,
    WAIT_FOR_ELEMENT_MS  : 5000,
    WAIT_FOR_INTERVAL_MS : 100
  };

  const SELECTORS = {
    composer        : '[contenteditable="true"][role="textbox"]',
    messageGroup    : 'div[data-testid="message-group"], div[role="row"]',
    header          : 'header[role="banner"]',
    headerLink      : 'header[role="banner"] a[role="link"][href*="/t/"][aria-label]',
    headerTitleSpan : 'h2 span[dir="auto"]',
    topChatLinks    : 'a[role="link"][href*="/t/"]'
  };

  // Regex pre‑compilation ------------------------------------------------------
  const REGEX = {
    markerChatStart  : /inició este chat/i,
    timeOnly         : /^\d{1,2}:\d{2}(?:\s?[ap]m)?$/i,
    dateTimeText     : /\d{1,2}\s(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s\d{4},?\s\d{1,2}:\d{2}/i,
    numericDateTime  : /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s?\d{1,2}:\d{2}(?:\s?[ap]m)?$/i,
    relativeTime     : /^enviado hace\s?\d+/i,
    awaitingResponse : /está esperando tu respuesta/i,
    viewPost         : /ver publicación/i,
    sentLabel        : /message sent/i,
    justSent         : /^enviado$/i,
    youSent          : /enviaste/i
  };

  // Internal state ------------------------------------------------------------
  let isCycling = false;

  // ────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────────────────────────────────
  function log(message, data) {
    console.log(`[Marketplace Bot] ${message}`, data || '');
    chrome.runtime.sendMessage({ action: MSG.LOG, message, data });
  }

  function waitFor(conditionFn, interval = CONFIG.WAIT_FOR_INTERVAL_MS, timeout = CONFIG.WAIT_FOR_ELEMENT_MS) {
    return new Promise(resolve => {
      const start = Date.now();
      const id = setInterval(() => {
        if (conditionFn()) {
          clearInterval(id);
          resolve(true);
        } else if (Date.now() - start > timeout) {
          clearInterval(id);
          resolve(false);
        }
      }, interval);
    });
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Messenger helpers (DOM operations only)
  // ────────────────────────────────────────────────────────────────────────────
  const Messenger = {
    focusComposer() {
      const composer = document.querySelector(SELECTORS.composer);
      if (!composer) return null;
      composer.focus();
      return composer;
    },

    clearComposer(composer) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete',   false, null);
    },

    insertText(composer, text) {
      document.execCommand('insertText', false, text);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },

    async sendMessage(text) {
      const composer = this.focusComposer();
      if (!composer) {
        log('Composer not found – cannot send message');
        return false;
      }

      this.clearComposer(composer);
      this.insertText(composer, text);
      await delay(500);

      const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      const enterUp   = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      composer.dispatchEvent(enterDown);
      composer.dispatchEvent(enterUp);
      log('Mensaje enviado');
      return true;
    },

    extractChatTitle() {
      const headerLink = document.querySelector(SELECTORS.headerLink);
      if (headerLink) return headerLink.getAttribute('aria-label').trim();
      const span = document.querySelector(SELECTORS.headerTitleSpan);
      if (span) return span.textContent.trim();
      return document.title;
    },

    async extractLastMessages(limit) {
      const container =
        document.querySelector('div[data-pagelet][role="main"]') ||
        document.querySelector('[data-testid="messenger_list_view"]') ||
        document.body;

      let groups = container.querySelectorAll(SELECTORS.messageGroup);
      if (!groups.length) groups = container.querySelectorAll('div[role="row"]');

      const messages = [];
      groups.forEach(group => {
        const textContent = group.textContent;
        const isSeller = REGEX.youSent.test(textContent) || group.querySelector('[data-testid="outgoing_message"]');
        const sender = isSeller ? 'seller' : 'buyer';

        group.querySelectorAll('span[dir="auto"]').forEach(span => {
          const text = span.textContent.trim();
          if (text) messages.push({ text, sender });
        });
      });

      if (!messages.length) {
        container.querySelectorAll('span[dir="auto"]').forEach(span => {
          const text = span.textContent.trim();
          if (text) messages.push({ text, sender: 'unknown' });
        });
      }

      // Slice after the "inició este chat" marker
      const markerIdx = messages.findIndex(m => REGEX.markerChatStart.test(m.text));
      if (markerIdx >= 0) messages.splice(0, markerIdx + 1);

      // Buyer name (first word of chat title) for filtering
      const buyerName = Messenger.extractChatTitle().split(/[\s·-]/)[0]?.toLowerCase() || '';

      const filtered = messages.filter(m => {
        const t = m.text.toLowerCase();
        if (!t) return false;
        if (t === 'enter') return false;
        if (REGEX.justSent.test(t)) return false;
        if (t === buyerName) return false;
        if (REGEX.timeOnly.test(t)) return false;
        if (REGEX.dateTimeText.test(t) || REGEX.numericDateTime.test(t)) return false;
        if (REGEX.relativeTime.test(t)) return false;
        if (REGEX.awaitingResponse.test(t)) return false;
        if (REGEX.viewPost.test(t)) return false;
        if (REGEX.sentLabel.test(t)) return false;
        return true;
      });

      return filtered.slice(-limit);
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // ApiClient – Placeholder for phase 2
  // ────────────────────────────────────────────────────────────────────────────
  const ApiClient = {
    /**
     * Send chatData to external server and return the response.
     * @param {object} chatData – { clientName, chatName, messages }
     * @returns {Promise<{ reply: string } | null>}
     */
    async sendChat(chatData) {
      // NOTE: Implementation will vary. This is only a stub.
      try {
        // Example: const resp = await fetch('https://example.com/api/reply', {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify(chatData)
        // });
        // return await resp.json();
        return null; // placeholder
      } catch (err) {
        log('ApiClient error', err);
        return null;
      }
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // ChatScanner – high‑level orchestration of chat traversal
  // ────────────────────────────────────────────────────────────────────────────
  const ChatScanner = {
    async scanTopChats(limit = CONFIG.DEFAULT_CHAT_LIMIT) {
      // Narrow search to Marketplace nav section if present
      let container = document;
      const spanMarketplace = Array.from(document.querySelectorAll('span[dir="auto"]'))
        .find(el => el.textContent.trim() === 'Marketplace');
      if (spanMarketplace) {
        const nav = spanMarketplace.closest('div[role="navigation"]');
        if (nav) container = nav;
      }

      const chats = Array.from(container.querySelectorAll(SELECTORS.topChatLinks))
        .slice(0, limit)
        .map(link => {
          const title = link.getAttribute('aria-label')?.trim() || link.textContent.trim();
          const id = (link.href.match(/\/t\/([^\/?#]+)/) || [])[1];
          return { id, title };
        })
        .filter(c => c.id);

      return chats;
    },

    async openChatById(id) {
      const link = document.querySelector(`a[role="link"][href*="/t/${id}"]`);
      if (link) {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } else {
        window.location.href = `https://www.messenger.com/t/${id}`;
      }
      // Wait for header + at least one msg group
      await waitFor(() => document.querySelector(SELECTORS.header));
      await waitFor(() => document.querySelector(SELECTORS.messageGroup));
      await delay(400); // render buffer
    },

    async collectChatsData(chatLimit, msgLimit, delayMs) {
      if (isCycling) {
        log('collectChatsData already running – abort');
        return [];
      }
      isCycling = true;

      const chats = await this.scanTopChats(chatLimit);
      const results = [];

      log(`Starting detailed scan of ${chats.length} chats`);
      for (let i = 0; i < chats.length; i++) {
        const { id, title } = chats[i];
        log(`(${i + 1}/${chats.length}) Opening chat ${id}`);
        await this.openChatById(id);

        const chatTitle = Messenger.extractChatTitle();
        const messages  = await Messenger.extractLastMessages(msgLimit);

        // Split at '·' → antes = clientName, después = listing
        const parts     = chatTitle.split('·').map(s => s.trim());
        const clientName = parts[0] || chatTitle;
        const listing    = parts[1] || chatTitle;

        const chatData = {
          clientName,
          listing,
          chatName : chatTitle,
          messages
        };
        results.push(chatData);

        // Future: Call external API and send reply ---------------------------
        // const apiResp = await ApiClient.sendChat(chatData);
        // if (apiResp?.reply) await Messenger.sendMessage(apiResp.reply);

        await delay(delayMs);
      }

      isCycling = false;
      log('Detailed scan completed', results);
      return results;
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Message Handlers
  // ────────────────────────────────────────────────────────────────────────────
  async function handleMessage(request, sender, sendResponse) {
    try {
      switch (request.action) {
        case MSG.PING:
          sendResponse({ status: 'active' });
          break;

        case MSG.SCAN_TITLE:
          sendResponse({ title: Messenger.extractChatTitle() });
          break;

        case MSG.SCAN_MESSAGES: {
          const limit = await getStoredNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const messages = await Messenger.extractLastMessages(limit);
          sendResponse({ messages });
          break;
        }

        case MSG.SCAN_TOP:
          sendResponse({ chats: await ChatScanner.scanTopChats() });
          break;

        case MSG.CYCLE_CHATS:
          ChatScanner.collectChatsData(CONFIG.DEFAULT_CHAT_LIMIT, CONFIG.DEFAULT_MSG_LIMIT, CONFIG.DEFAULT_DELAY_MS);
          sendResponse({ started: true });
          break;

        case MSG.SCAN_DETAILED: {
          const msgLimit = await getStoredNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const data = await ChatScanner.collectChatsData(CONFIG.DEFAULT_CHAT_LIMIT, msgLimit, CONFIG.DEFAULT_DELAY_MS);
          sendResponse({ chatsData: data });
          break;
        }

        case MSG.SEND_TEST_REPLY:
          sendResponse({ sent: await Messenger.sendMessage('respuesta de prueba') });
          break;

        default:
          sendResponse({});
      }
    } catch (err) {
      log('Error in message handler', err);
      sendResponse({ error: err.message });
    }

    return true; // keep message channel open for async sendResponse
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────
  async function getStoredNumber(key, fallback) {
    return new Promise(resolve => {
      chrome.storage.local.get([key], result => {
        resolve(parseInt(result[key], 10) || fallback);
      });
    });
  }

  function onUrlChange() {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (/messenger\.com\/marketplace/.test(location.href)) {
          log('Marketplace view detected');
          chrome.runtime.sendMessage({ action: MSG.CHECK_NEW });
        }
      }
    }).observe(document, { childList: true, subtree: true });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Boot
  // ────────────────────────────────────────────────────────────────────────────
  function init() {
    log('Content script initialised', window.location.href);
    chrome.runtime.onMessage.addListener(handleMessage);
    onUrlChange();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose helpers for debugging from DevTools --------------------------------
  window.MarketplaceBot = { Messenger, ChatScanner, ApiClient, utils: { waitFor, delay, log } };
})();
