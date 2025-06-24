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
    START_BOT:         'startBot',
    STOP_BOT:          'stopBot',
    CHECK_NEW:         'checkForNewMessages',
    LOG:               'log'
  };

  const CONFIG = {
    DEFAULT_CHAT_LIMIT   : 5,
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
  // Overlay manager (UX feedback while bot runs)
  // ────────────────────────────────────────────────────────────────────────────
  const Overlay = {
    ensure() {
      if (this.el) return;
      this.el = document.createElement('div');
      this.el.id = 'mpBotOverlay';
      Object.assign(this.el.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,123,255,0.25)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483647'
      });
      const msg = document.createElement('div');
      msg.id = 'mpBotOverlayMsg';
      msg.style.cssText = 'color:#fff;font-size:20px;text-align:center;margin-bottom:16px;font-weight:bold;text-shadow:0 1px 2px rgba(0,0,0,.4);max-width:80%;white-space:pre-wrap;';
      this.msg = msg;
      this.el.appendChild(msg);

      const btn = document.createElement('button');
      btn.textContent = 'DETENER';
      btn.style.cssText = 'padding:8px 16px;font-size:16px;background:#dc3545;color:#fff;border:none;border-radius:4px;cursor:pointer;';
      btn.addEventListener('click', () => {
        isCycling = false;
        this.update('Detenido por usuario');
        setTimeout(() => this.hide(), 800);
      });
      this.el.appendChild(btn);

      document.body.appendChild(this.el);
    },
    show(text = 'Ejecutando...') {
      this.ensure();
      this.update(text);
      this.el.style.display = 'flex';
    },
    update(text) {
      if (!this.el) this.ensure();
      this.msg.textContent = text;
    },
    hide() {
      if (this.el) {
        this.el.remove();
        this.el = null;
      }
    }
  };

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

    /**
     * Inserts text into the Messenger composer respecting line‑breaks.
     *
     * Facebook's composer treats a literal "Enter" keypress (without Shift)
     * as a *send* action. To visually create a new line inside the same
     * message, users press <Shift+Enter>, which inserts a <br> element.
     *
     * When we inject text programmatically with \n characters, Messenger
     * previously ignored them and collapsed everything into a single line. We
     * now split on \n and explicitly inject <br> between fragments, mimicking
     * the native behaviour of <Shift+Enter>.
     *
     * @param {HTMLElement} composer – contenteditable composer element
     * @param {string} text – full text including \n line breaks
     */
    async insertText(composer, text) {
      const lines = text.split(/\n/g);
      
      // Usar Método 3 por defecto: <div> con <br> al final
      const html = lines.map(line => 
        `<div>${line}<br></div>`
      ).join('');
      document.execCommand('insertHTML', false, html);
      
      // Forzar actualización del contenido
      composer.dispatchEvent(new InputEvent('input', { 
        bubbles: true,
        inputType: 'insertText',
        data: text,
        dataTransfer: new DataTransfer(),
        isComposing: false
      }));
      
      // Disparar evento de cambio
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Pequeña pausa para asegurar que todo se procese
      await new Promise(resolve => setTimeout(resolve, 100));
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
     * @param {object} chatData – { clientName, chatName, messages, chatId, listing }
     * @returns {Promise<{ reply: string } | null>}
     */
    async sendChat(chatData) {
      const webhookUrl = 'https://n8nimpulsa.zapto.org/webhook-test/752e0505-3c13-4034-9bfd-3a870240c3cd';
      
      try {
        log('Sending chat data to webhook', { webhookUrl, chatData });
        
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(chatData),
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const responseData = await response.json();
        log('Webhook response received', responseData);
        
        return {
          reply: responseData.response || 'Respuesta recibida del servidor sin contenido de respuesta.'
        };
        
      } catch (error) {
        console.error('Error sending data to webhook:', error);
        return {
          reply: `Error al conectar con el servidor: ${error.message}`
        };
      }
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // ChatScanner – high‑level orchestration of chat traversal
  // ────────────────────────────────────────────────────────────────────────────
  const ChatScanner = {
    async scanTopChats(baseFetch = 20) {
      // Constrain search to Marketplace navigation if present
      const container = (() => {
        const spanMarketplace = Array.from(document.querySelectorAll('span[dir="auto"]'))
          .find(el => el.textContent.trim() === 'Marketplace');
        const nav = spanMarketplace?.closest('div[role="navigation"]');
        return nav || document;
      })();
    
      return Array.from(container.querySelectorAll(SELECTORS.topChatLinks))
        .slice(0, baseFetch)            // ← ALWAYS grab up to 20 IDs
        .map(link => {
          const title = link.getAttribute('aria-label')?.trim() || link.textContent.trim();
          const id = (link.href.match(/\/t\/([^\/?#]+)/) || [])[1];
          return { id, title };
        })
        .filter(c => c.id);
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
    
      // Siempre obtenemos 20 IDs pero solo procesamos hasta "chatLimit"
      const allChats      = await this.scanTopChats(20);
      const stopCount     = Math.min(chatLimit, allChats.length);
      const chatsToHandle = allChats.slice(0, stopCount);
      const results       = [];
    
      Overlay.show(`Escaneando ${stopCount} chats...`);
      log(`Starting detailed scan of ${stopCount} chats`);
    
      for (let i = 0; i < stopCount && isCycling; i++) {
        const { id, title } = chatsToHandle[i];
        Overlay.update(`(${i + 1}/${stopCount}) Escaneando: ${title}`);
        log(`(${i + 1}/${stopCount}) Opening chat ${id}`);
    
        await this.openChatById(id);
    
        const chatTitle = Messenger.extractChatTitle();
        const messages  = await Messenger.extractLastMessages(msgLimit);
        const chatId = id;
    
        // clientName  = parte antes de "·"; listing = parte después
        const [clientName = chatTitle, listing = chatTitle] = chatTitle
          .split('·')
          .map(s => s.trim());
    
        results.push({ chatId, clientName, listing, chatName: chatTitle, messages });

        // ────────────────────────────────────────────────────────────────
        // 1) Enviar datos al webhook y obtener la respuesta
        // ────────────────────────────────────────────────────────────────
        const { reply } = await ApiClient.sendChat({ chatId, clientName, listing, chatName: chatTitle, messages });

        // ────────────────────────────────────────────────────────────────
        // 2) Mostrar pre-visualización durante 5 seg para permitir cancelar
        // ────────────────────────────────────────────────────────────────
        const previewText =
          `Title chat ${chatTitle}\n` +
          `Messages:\n${messages.map(m => `${m.sender}: ${m.text}`).join('\n')}\n` +
          `Response to be send: ${reply}`;

        Overlay.show(previewText);

        for (let t = 0; t < 5000 && isCycling; t += 500) {
          await delay(500);
        }

        // Si el usuario no canceló, enviar la respuesta
        if (isCycling) {
          await Messenger.sendMessage(reply);
        } else {
          log('Envío cancelado por el usuario');
        }

        Overlay.hide();

        // Espera configurable antes de pasar al siguiente chat
        await delay(delayMs);
      }
    
      isCycling = false;
      Overlay.update('Completado');
      setTimeout(() => Overlay.hide(), 1000);
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

        case MSG.SEND_TEST_REPLY: {
          const testMessage = request.testMessage || 'respuesta de prueba';
          sendResponse({ sent: await Messenger.sendMessage(testMessage) });
          return true; // Keep the message channel open for async response
        }

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

    // Listener for simplified popup commands
    chrome.runtime.onMessage.addListener(async (req, sender, sendResponse) => {
      if (req.action === MSG.START_BOT) {
        if (isCycling) { sendResponse({ started: false, reason: 'already_running' }); return; }
        const limit = req.chatLimit || CONFIG.DEFAULT_CHAT_LIMIT;
        Overlay.show('Preparando...');
        ChatScanner.collectChatsData(limit, CONFIG.DEFAULT_MSG_LIMIT, CONFIG.DEFAULT_DELAY_MS)
          .then(() => { Overlay.update('Completado'); setTimeout(() => Overlay.hide(), 1000); });
        sendResponse({ started: true });
      } else if (req.action === MSG.STOP_BOT) {
        isCycling = false;
        Overlay.update('Deteniendo...');
        setTimeout(() => Overlay.hide(), 800);
        sendResponse({ stopped: true });
      }
    });

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
