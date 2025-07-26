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
    SEND_TEST_IMAGE:   'sendTestImage',
    START_BOT:         'startBot',
    STOP_BOT:          'stopBot',
    CHECK_NEW:         'checkForNewMessages',
    PROCESS_UNREAD:    'processOldestUnread',
    LOG:               'log'
  };

  const CONFIG = {
    DEFAULT_CHAT_LIMIT   : 20,
    DEFAULT_MSG_LIMIT    : 100,
    DEFAULT_DELAY_MS     : 1500,
    WAIT_FOR_ELEMENT_MS  : 5000,
    WAIT_FOR_INTERVAL_MS : 100,
    DEFAULT_WEBHOOK_URL  : 'https://n8nimpulsa.zapto.org/webhook/ImpulsaAIbot',
    MARKETPLACE_TEXT     : 'Marketplace',
    SCAN_BUFFER          : 30,
    UNREAD_SCAN_LIMIT    : 20,
    WAIT: {
      inChat: 1000,
      beforeAPI: 1000,
      afterAPI: 15000,
      betweenReplies: 3000,
      afterLastReply: 1000,
      noUnread: 2000
    }
  };

  const SELECTORS = {
    composer        : '[contenteditable="true"][role="textbox"]',
    header          : 'header[role="banner"]',
    headerLink      : 'header[role="banner"] a[role="link"][href*="/t/"][aria-label]',
    headerTitleSpan : 'h2 span[dir="auto"]',
    topChatLinks    : 'a[role="link"][href*="/t/"]',
    threadWrapper   : 'div[aria-label^="Mensajes de la conversación"]',
    messageGroup    : 'div[data-testid="message-group"], div[role="row"], div[role="listitem"]',
    outgoingBubble  : [
      '[data-ownership="self"]',
      '[data-owner="self"]',
      '[data-testid^="outgoing"]',
      '[data-testid="outgoing_message"]'
    ].join(','),
    bubbleText      : 'span[dir="auto"]',
    bubblesContainer: 'div[data-scope="messages_table"][tabindex]',
    unreadDot       : 'div[role="button"][aria-hidden="true"] span[data-visualcompletion="ignore"]',
    imageSender: {
      addFilesButton : 'div[role="button"][aria-label*="archivo" i], div[role="button"][aria-label*="file" i]',
      hiddenFileInput: 'input[type="file"][multiple]',
      uploadPreview  : 'img[src^="blob:"]'
    }
  };
const enterRegex      = /^\s*enter\s*$/i;
const sellerPrefixRx  = /^enviaste\S/i;  

const SYSTEM_FILTERS = [
  /^mensaje enviado$/i,
  /^Ya pueden calificarse$/i,
  /^Es posible que las personas se califiquen entre sí según sus interacciones o transacciones\./i,
  /^Calificar a/i
];

/**
 * Selector that matches the *blue‑dot wrapper* of unread chats.
 * We search for a <span data-visualcompletion="ignore"> nested within a
 * <div role="button" aria-hidden="true">.
 */

  // Helpers provided by Utilities.js
  const {
    Storage,
    waitFor,
    delay,
    pause,
    dataURLToBlob,
    formatRepliesForPreview,
    fetchImageViaBackground,
    checkForNewMessages
  } = window.MPUtils;

  

  // Internal state ------------------------------------------------------------
  let isCycling = false;
  Object.defineProperty(window, 'isCycling', { get: () => isCycling, set: v => { isCycling = v; } });
  let isProcessingUnread = false;

  // ────────────────────────────────────────────────────────────────────────────
  // Overlay manager (UX feedback while bot runs)
  // ────────────────────────────────────────────────────────────────────────────
  // Lightweight UI overlay displayed while the bot is scanning chats.
  const Overlay = {
    // Create DOM elements for the overlay if they do not exist yet
    ensure() {
      if (this.el) return;
      this.el = document.createElement('div');
      this.el.id = 'mpBotOverlay';
      const msg = document.createElement('div');
      msg.id = 'mpBotOverlayMsg';
      this.msg = msg;
      this.el.appendChild(msg);

      const btn = document.createElement('button');
      btn.textContent = 'DETENER';
      btn.addEventListener('click', () => {
        isCycling = false;
        ApiClient.abort();
        this.update('Detenido por usuario');
        const composer = document.querySelector(SELECTORS.composer);
        if (composer) {
          composer.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        }
        setTimeout(() => this.hide(), 800);
      });
      this.el.appendChild(btn);

      document.body.appendChild(this.el);
    },
    /** Show the overlay, optionally with custom text. */
    show(text = 'Ejecutando...') {
      this.ensure();
      this.update(text);
      this.el.style.display = 'flex';
    },
    /** Update the text shown on the overlay. */
    update(text) {
      if (!this.el) this.ensure();
      this.msg.innerHTML = text;
    },
    /**
     * Render a step with optional lines and countdown timer.
     * Objects in `lines` are stringified for readability.
     */
    updateStep(step, lines = [], countdown) {
      const parts = [];
      if (countdown !== undefined) {
        parts.push(`<div style="font-size:32px;margin-bottom:12px;font-weight:bold;color:#fff;background:rgba(0,0,0,0.2);border-radius:8px;padding:8px 16px;box-shadow:0 2px 8px #0002;">${countdown}</div>`);
      }
      parts.push(`<div style="font-size:26px;margin-bottom:16px;font-weight:bold;color:#fff;text-shadow:0 2px 8px #0004;letter-spacing:1px;">${step}</div>`);
      if (lines.length) {
        // Render each line as a separate bubble box
        parts.push('<div style="display:flex;flex-direction:column;gap:10px;background:rgba(255,255,255,0.12);border-radius:8px;padding:12px 18px;box-shadow:0 1px 4px #0001;max-width:90%;margin:auto;">');
        for (const l of lines) {
          const lineStr = typeof l === 'string' ? l : JSON.stringify(l, null, 2);
          if (lineStr.startsWith('[Image]')) {
            const url = lineStr.replace('[Image] ', '').trim();
            parts.push(`<div style="margin:10px 0;text-align:center;"><img src="${url}" style="max-width:180px;max-height:120px;border-radius:6px;box-shadow:0 2px 8px #0002;display:inline-block;vertical-align:middle;" alt="Image preview" /></div>`);
          } else {
            // Chat bubble style for each message
            parts.push(`<div style="background:rgba(0,0,0,0.7);color:#fff;padding:10px 16px;border-radius:16px;box-shadow:0 2px 8px #0002;max-width:80%;margin:0 auto;font-size:18px;word-break:break-word;">${lineStr}</div>`);
          }
        }
        parts.push('</div>');
      }
      const html = parts.join('');
      this.update(html);
    },
    /** Remove the overlay from the page. */
    hide() {
      if (this.el) {
        this.el.remove();
        this.el = null;
      }
    }
  };
  window.Overlay = Overlay;

  // ────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────────────────────────────────
  function log(message, data) {
    chrome.runtime.sendMessage({ action: MSG.LOG, message, data });
  }

  // ---------------------------------------------------------------
  // ImageSender – attach and send images using the file input only
  // ---------------------------------------------------------------

  const ImageSender = (() => {
    function focusComposer() {
      const el = document.querySelector(SELECTORS.composer);
      if (el) el.focus();
      return el;
    }

    function pressEnter() {
      const composer = focusComposer();
      if (!composer) return false;
      const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      const ku = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      composer.dispatchEvent(kd);
      composer.dispatchEvent(ku);
      return true;
    }
    async function viaFileInput(blob) {

      log('[ImageSender] viaFileInput called with blob:', blob);
      const button = document.querySelector(SELECTORS.imageSender.addFilesButton);
      if (button) {
        button.click();
        await delay(150);
      }

      const input = document.querySelector(SELECTORS.imageSender.hiddenFileInput);
      if (!input) {
        log('[ImageSender] hiddenFileInput not found');
        return false;
      }

      const file = new File([blob], `image.${blob.type.split('/')[1]}`, { type: blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      log('[ImageSender] Dispatched change event on hiddenFileInput');

      const previewFound = await waitFor(() => document.querySelector(SELECTORS.imageSender.uploadPreview));
      if (!previewFound) {
        log('[ImageSender] uploadPreview not found');
        return false;
      }
      await delay(200);
      pressEnter();
      log('[ImageSender] Pressed Enter after file input');
      return true;
    }

    async function sendImage(blob) {
      return viaFileInput(blob);
    }

    return { sendImage };
  })();

  window.ImageSender = ImageSender;



  // helpers waitFor/delay/pause provided by Utilities.js

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

    /**
     * Sends a message through the open Messenger chat.
     * Aborts and returns false if the global cycle flag is cleared.
     */
    async sendMessage(text) {
      log('[Messenger.sendMessage] Called with text:', text);
      if (!isCycling) { log('[Messenger.sendMessage] Aborted'); return false; }
      const composer = this.focusComposer();
      if (!composer) {
        log('[Messenger.sendMessage] Composer not found – cannot send message');
        return false;
      }

      this.clearComposer(composer);
      log('[Messenger.sendMessage] Composer cleared');
      await this.insertText(composer, text);
      if (!isCycling) { log('[Messenger.sendMessage] Aborted after insert'); return false; }
      log('[Messenger.sendMessage] Text inserted');
      await delay(500);
      if (!isCycling) { log('[Messenger.sendMessage] Aborted before send'); return false; }

      const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      const enterUp   = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      composer.dispatchEvent(enterDown);
      composer.dispatchEvent(enterUp);
      log('[Messenger.sendMessage] Enter dispatched, message sent');
      return true;
    },


    extractChatTitle() {
      const headerLink = document.querySelector(SELECTORS.headerLink);
      if (headerLink) return headerLink.getAttribute('aria-label').trim();
      const span = document.querySelector(SELECTORS.headerTitleSpan);
      if (span) return span.textContent.trim();
      return document.title;
    },

/********************************************************************
 *  1)  findScroller()  – searches *inside* the wrapper for the first
 *      descendant that can actually scroll (scrollHeight > clientHeight)
 ********************************************************************/
findScroller() {
  const wrapper = document.querySelector(SELECTORS.threadWrapper);
  if (!wrapper) return null;

  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_ELEMENT);
  let node = wrapper;
  while (node) {
    if (node.scrollHeight - node.clientHeight > 20) return node;
    node = walker.nextNode();
  }
  return null;
},

/********************************************************************
 *  2)  loadOlder(pages = 5, pauseMs = 900)
 *      Scrolls to the top of the scroller N times, waiting a bit
 *      so Messenger can fetch older messages each time.
 ********************************************************************/
async loadOlder(pages = 5, pauseMs = 2000) {
  const scroller = Messenger.findScroller();
  if (!scroller) {
    console.warn('⚠️  Scrollable container not found – selector may be outdated.');
    return;
  }

  for (let i = 0; i < pages; i++) {
    const heightBefore = scroller.scrollHeight;
    scroller.scrollTop = 0;                     // jump to top
    await new Promise(r => setTimeout(r, pauseMs));

    // stop early if nothing new loaded
    if (scroller.scrollHeight === heightBefore) break;
  }
},

/********************************************************************
 *  3)  extractLastMessages(limit = 100)
 *      Returns an array like:  [{ text, sender }, …]
 ********************************************************************/
async extractLastMessages(limit = 20) {
  await Messenger.loadOlder(5);

  const thread = document.querySelector(SELECTORS.threadWrapper);
  if (!thread) {
    console.warn('⚠️  Conversation wrapper not found.');
    return [];
  }

  const bubbles = thread.querySelectorAll(SELECTORS.bubblesContainer);
  if (!bubbles.length) return [];

  const messages   = [];
  const clientName = Messenger.extractChatTitle().split('·')[0].trim();
  const nameEsc    = clientName.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&');
  const buyerDetect= new RegExp('^' + nameEsc + '\\S', 'i');   // name + non‑space
  const buyerStrip = new RegExp('^' + nameEsc, 'i');

  bubbles.forEach((bubble, bIdx) => {
    const wholeText = bubble.textContent.replace(/\s+/g, ' ').trim();

    // ── sender detection ───────────────────────────────────────
    let sender = 'unknown';
    if (sellerPrefixRx.test(wholeText)) sender = 'seller';
    else if (buyerDetect.test(wholeText)) sender = 'buyer';
    else if (bubble.querySelector(SELECTORS.outgoingBubble)) sender = 'seller';

    if (sender === 'unknown') {
      return; // discard entire bubble
    }

    const spans = [...bubble.querySelectorAll(`${SELECTORS.bubbleText}, span[dir="auto"]`)];
    spans.forEach((span, sIdx) => {
      let text = span.textContent.trim();
      if (!text) {  return; }
      if (enterRegex.test(text)) {  return; }

      // strip prefix from first span only
      if (sIdx === 0) {
        const before = text;
        if (sender === 'seller') text = text.replace(/^enviaste/i, '').trim();
        else                     text = text.replace(buyerStrip, '').trim();
        if (!text) {  return; }
      }

      if (SYSTEM_FILTERS.some(rx => rx.test(text))) {
        return;
      }
      messages.push({ sender, text });
    });
  });
  return messages.slice(-limit);
}




/********************************************************************
 *  ➤ Example workflow
 ********************************************************************/
// await loadOlder(3);                          // load 3 extra "pages"
// const msgs = await extractLastMessages(100); // get last 100 bubbles
// console.table(msgs);

  };

  // ────────────────────────────────────────────────────────────────────────────
  // ApiClient – Placeholder for phase 2
  // ────────────────────────────────────────────────────────────────────────────
  const ApiClient = {
    abortController: null,
    /**
     * Send chatData to external server and return the response.
     * @param {object} chatData – { clientName, chatName, messages, chatId, listing }
   * @returns {Promise<{ replies: string[] } | null>}
     */
    /**
     * Send chat data to the configured webhook endpoint.
     * @param {object} chatData Data describing the chat
     */
    async sendChat(chatData) {
      const webhookUrl = await Storage.getString('webhookUrl', CONFIG.DEFAULT_WEBHOOK_URL);
      this.abortController = new AbortController();
      
      try {
        log('Sending chat data to webhook', { webhookUrl, chatData });
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(chatData),
          signal: this.abortController.signal
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const responseData = await response.json();
        log('Webhook response received', responseData);

        // Handle nested output.response array
        let replies = [];
        if (Array.isArray(responseData)) {
          // If response is an array, take first element's output.response
          if (responseData[0]?.output?.response) {
            replies = responseData[0].output.response;
          }
        } else if (responseData.output?.response) {
          replies = responseData.output.response;
        } else if (Array.isArray(responseData.response)) {
          replies = responseData.response;
        } else if (typeof responseData.response === 'string') {
          replies = [responseData.response];
        }

        log('[ApiClient] Extracted replies:', replies);

        if (!replies.length) {
          replies = ['Respuesta recibida del servidor sin contenido de respuesta.'];
        }

        return { replies };
      } catch (error) {
        if (error.name === 'AbortError') {
          log('Webhook request aborted');
          return { replies: [] };
        }
        console.error('Error sending data to webhook:', error);
        return { replies: [`Error al conectar con el servidor: ${error.message}`] };
      }
    }
    ,
    /** Abort any in-flight webhook request. */
    abort() {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    }
  };

  function isUnreadChatRow(rowEl) {
    if (!rowEl) return false;
    // ✓ Dot present? (robust in current DOM build)
    if (rowEl.querySelector(SELECTORS.unreadDot)) return true;
  
    // Fallback: aria‑label heuristic (covers unexpected lang/DOM variations)
    const aria = (rowEl.getAttribute('aria-label') || '').trim().toLowerCase();
    return aria.endsWith('unread') || aria.endsWith('sin leer');
  }

  // Accepts a message object: { type: 'text'|'image', content?, url? }
  /**
   * Send either text or image reply depending on msgObj contents.
   * Aborts immediately if the global cycle flag is cleared.
   */
  async function sendReplyContent(msgObj) {
    log('[sendReplyContent] Received:', msgObj);
    if (!isCycling) { log('[sendReplyContent] Aborted'); return; }
    if (!msgObj) {
      log('[sendReplyContent] msgObj is null/undefined');
      return;
    }
    if (msgObj.type === 'image' && msgObj.url) {
      log('[sendReplyContent] Detected image reply:', msgObj.url);
      try {
        const dataUrl = msgObj.url.startsWith('data:') ? msgObj.url : await fetchImageViaBackground(msgObj.url);
        const blob = dataURLToBlob(dataUrl);
        log('[sendReplyContent] Sending image blob:', blob);
        if (!isCycling) { log('[sendReplyContent] Aborted before sending image'); return; }
        await ImageSender.sendImage(blob);
        if (!isCycling) { log('[sendReplyContent] Aborted after sending image'); return; }
      } catch (err) {
        log('Failed to send image reply', err);
      }
    } else if (msgObj.type === 'text' && msgObj.content) {
      log('[sendReplyContent] Detected text reply:', msgObj.content);
      if (!isCycling) { log('[sendReplyContent] Aborted before sending text'); return; }
      await Messenger.sendMessage(msgObj.content);
      if (!isCycling) { log('[sendReplyContent] Aborted after sending text'); return; }
    } else {
      log('[sendReplyContent] Unknown reply format:', msgObj);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ChatScanner – high‑level orchestration of chat traversal
  // ────────────────────────────────────────────────────────────────────────────
  const ChatScanner = {
    /**
   * Scan sidebar for top chats (default: 10) and report id/title/unread.
   *
   * @param {number} baseFetch – Max chats to extract.
   * @returns {{id:string,title:string,unread:boolean}[]} Array of metadata.
   */
  async scanTopChats(baseFetch = 10) {
    // 1️⃣ Restrict to the Marketplace nav section when available
    const container = (() => {
      const spanMarketplace = Array.from(document.querySelectorAll('span[dir="auto"]'))
        .find(el => el.textContent.trim() === CONFIG.MARKETPLACE_TEXT);
      const nav = spanMarketplace?.closest('div[role="navigation"]');
      return nav || document;
    })();

    // 2️⃣ Extract chat links and map to objects
    return Array.from(container.querySelectorAll(SELECTORS.topChatLinks))
      .slice(0, baseFetch)
      .map(link => {
        const title = link.getAttribute('aria-label')?.trim() || link.textContent.trim();
        const id = (link.href.match(/\/t\/([^\/?#]+)/) || [])[1];
        const row = link.closest('[role="row"], li');
        const unread = isUnreadChatRow(row);
        return { id, title, unread };
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
      const allChats      = await this.scanTopChats(CONFIG.SCAN_BUFFER);
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
        Overlay.update('Generando respuesta...');
        const { replies } = await ApiClient.sendChat({ chatId, clientName, listing, chatName: chatTitle, messages });

        // ────────────────────────────────────────────────────────────────
        // 2) Mostrar pre-visualización durante 5 seg para permitir cancelar
        // ────────────────────────────────────────────────────────────────
        const previewLines = [
          `Chat: <span style='color:#ffd700;'>${chatTitle}</span>`,
          '',
          '<b>Last messages:</b>',
          ...messages.map(m => `${m.sender === 'seller' ? '<span style="color:#4caf50;">Vendedor</span>' : '<span style="color:#2196f3;">Comprador</span>'}: ${m.text}`),
          '',
          '<b>Response to be sent:</b>',
          ...formatRepliesForPreview(replies)
        ];
        Overlay.updateStep('Previsualización de respuesta', previewLines);
        await pause(5000, 'Preview');

        // Si el usuario no canceló, enviar la respuesta
        if (isCycling) {
          Overlay.update('Enviando respuesta...');
          if (Array.isArray(replies)) {
            for (let i = 0; i < replies.length; i++) {
              log(`[SendReply] Sending reply ${i}:`, replies[i]);
              await sendReplyContent(replies[i]);
              if (i !== replies.length - 1) {
                await pause(3000, 'Waiting', []);
              }
            }
          } else {
            log('[SendReply] Sending single reply:', replies);
            await sendReplyContent(replies);
          }
        } else {
          log('Envío cancelado por el usuario');
        }

        Overlay.hide();

        // Espera configurable antes de pasar al siguiente chat
        await pause(delayMs, 'Waiting between chats');
      }
    
      isCycling = false;
      Overlay.update('Completado');
      setTimeout(() => Overlay.hide(), 1000);
      log('Detailed scan completed', results);
      return results;
    },

    async processOldestUnreadChat(msgLimit) {
      if (isProcessingUnread) return { status: 'busy' };
      isProcessingUnread = true;

      try {
        log('Scanning top chats', { step: 'Scanning chats...' });
        const chats = await this.scanTopChats(CONFIG.UNREAD_SCAN_LIMIT);
        log('Chats scanned', { step: 'Chats scanned', chatList: chats });
        const unread = chats.filter(c => c.unread);
        if (!unread.length) {
          log('No unread chats found', { step: 'No unread chats found', state: 'success' });
          return { processed: false };
        }

        const target = unread[unread.length - 1];
        log('Opening unread chat', { step: 'Opening chat', chatTitle: target.title });
        await this.openChatById(target.id);

        log('Waiting for full load', { step: 'Waiting 30s in chat', chatTitle: target.title });
        await pause(30000, 'Waiting 30s in chat', [target.title]);

        log('Capturing messages', { step: 'Capturing messages', chatTitle: target.title });

        const chatTitle = Messenger.extractChatTitle();
        const messages  = await Messenger.extractLastMessages(msgLimit);
        const [clientName = chatTitle, listing = chatTitle] = chatTitle
          .split('·')
          .map(s => s.trim());

        log('Sending data to API', { step: 'Sending to API', chatTitle, clientName });
        const response = await ApiClient.sendChat({
          chatId: target.id,
          clientName,
          listing,
          chatName: chatTitle,
          messages
        });

        log('API response received', { step: 'API response', replies: response.replies, chatTitle, state: 'success' });

        return { processed: true, chatTitle, response };
      } catch (err) {
        log('Error processing unread chat', { step: 'Error', state: 'error', message: err.message });
        return { processed: false, error: err.message };
      } finally {
        isProcessingUnread = false;
      }
    },

    /**
     * Iterate over unread chats and send replies using the API.
     * Respects the global cycle flag to allow cancellation.
     */
    async processUnreadChats(chatLimit = 20, msgLimit = 20) {
      if (isCycling) { log('processUnreadChats already running'); return; }
      isCycling = true;
      try {
        Overlay.show('Scanning chats...');
        const chats = await this.scanTopChats(CONFIG.UNREAD_SCAN_LIMIT);
        const unread = chats.filter(c => c.unread).slice(-chatLimit).reverse();
        log('Unread chats', { step: 'Chats scanned', chatList: unread });
        if (!unread.length) {
          await pause(CONFIG.WAIT.noUnread, 'No unread chats');
          Overlay.hide();
          return;
        }
        for (const chat of unread) {
          if (!isCycling) break;
          Overlay.updateStep('Opening chat', [chat.title]);
          log('Opening chat', { chat });
          await this.openChatById(chat.id);
          await pause(CONFIG.WAIT.inChat, 'Waiting in chat', [chat.title]);
          if (!isCycling) break;
          const chatTitle = Messenger.extractChatTitle();
          const messages = await Messenger.extractLastMessages(msgLimit);
          const [clientName = chatTitle, listing = chatTitle] = chatTitle.split('·').map(s => s.trim());
          await pause(CONFIG.WAIT.beforeAPI, 'Waiting before API');
          if (!isCycling) break;
          Overlay.updateStep('Sending to API', [chatTitle]);
          const { replies } = await ApiClient.sendChat({ chatId: chat.id, clientName, listing, chatName: chatTitle, messages });
          await pause(CONFIG.WAIT.afterAPI, 'API Response', formatRepliesForPreview(replies));
          if (!isCycling) break;
          for (const msg of replies) {
            Overlay.updateStep('Sending reply', formatRepliesForPreview(msg));
            await sendReplyContent(msg);
            if (msg !== replies[replies.length - 1]) {
              await pause(CONFIG.WAIT.betweenReplies, 'Waiting', []);
            } else {
              await pause(CONFIG.WAIT.afterLastReply, 'Waiting', []);
            }
          }
        }
        Overlay.update('Completado');
        setTimeout(() => Overlay.hide(), 1000);
      } catch (err) {
        log('Error processing unread chats', { step: 'Error', state: 'error', message: err.message });
      } finally {
        isCycling = false;
      }
    }
  };
  // Message Handlers
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
          const limit = await Storage.getNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const messages = await Messenger.extractLastMessages(limit);
          sendResponse({ messages });
          log('Messages scanned', { messages });
          return true;
        }

        case MSG.SCAN_TOP:
          sendResponse({ chats: await ChatScanner.scanTopChats() });
          break;

        case MSG.CHECK_NEW: {
          const unread = checkForNewMessages(SELECTORS);
          sendResponse({ unread });
          if (unread.length) {
            chrome.runtime.sendMessage({ action: 'processNewMessage', messageData: unread });
          }
          break;
        }

        case MSG.CYCLE_CHATS:
          ChatScanner.collectChatsData(CONFIG.DEFAULT_CHAT_LIMIT, CONFIG.DEFAULT_MSG_LIMIT, CONFIG.DEFAULT_DELAY_MS);
          sendResponse({ started: true });
          break;

        case MSG.START_BOT: {
          if (isCycling) { sendResponse({ started: false, reason: 'already_running' }); break; }
          const limit = request.chatLimit || CONFIG.DEFAULT_CHAT_LIMIT;
          ChatScanner.processUnreadChats(limit, CONFIG.DEFAULT_MSG_LIMIT);
          sendResponse({ started: true });
          break;
        }

        case MSG.STOP_BOT:
          isCycling = false;
          ApiClient.abort();
          const composer = document.querySelector(SELECTORS.composer);
          if (composer) {
            composer.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
          }
          Overlay.update('Deteniendo...');
          setTimeout(() => Overlay.hide(), 800);
          sendResponse({ stopped: true });
          break;

        case MSG.SCAN_DETAILED: {
          const msgLimit = await Storage.getNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const data = await ChatScanner.collectChatsData(CONFIG.DEFAULT_CHAT_LIMIT, msgLimit, CONFIG.DEFAULT_DELAY_MS);
          sendResponse({ chatsData: data });
          log('Detailed scan completed', data);
          break;
        }

        case MSG.PROCESS_UNREAD: {
          const msgLimit = await Storage.getNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const res = await ChatScanner.processOldestUnreadChat(msgLimit);
          sendResponse(res);
          break;
        }

        case MSG.SEND_TEST_REPLY: {
          const testMessage = request.testMessage || 'respuesta de prueba';
          sendResponse({ sent: await Messenger.sendMessage(testMessage) });
          return true; // Keep the message channel open for async response
        }

        case MSG.SEND_TEST_IMAGE: {
          try {
            log('SEND_TEST_IMAGE: received request', request);
            log('SEND_TEST_IMAGE: fetching image', request.url);
            const dataUrl = await fetchImageViaBackground(request.url);
            log('SEND_TEST_IMAGE: got dataUrl', dataUrl?.slice?.(0, 40));
            if (!dataUrl) {
              log('SEND_TEST_IMAGE: dataUrl is empty!');
              sendResponse({ sent: false, error: 'dataUrl is empty' });
              return true;
            }
            const blob = dataURLToBlob(dataUrl);
            log('SEND_TEST_IMAGE: got blob', blob);
            if (!blob) {
              log('SEND_TEST_IMAGE: blob is null!');
              sendResponse({ sent: false, error: 'blob is null' });
              return true;
            }

            // Use the enhanced sender
            const sent = await ImageSender.sendImage(blob);
            log('SEND_TEST_IMAGE: sent result', sent);

            sendResponse({ sent });
          } catch (e) {
            log('SEND_TEST_IMAGE: Error sending image', e);
            sendResponse({ sent: false, error: e.message });
          }
          return true;
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
  // Helper: fetch image via background script to bypass CORS

  // Detect single-page navigation and trigger a check when navigating to
  // the Marketplace chat view.
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
  // Boot sequence
  // ────────────────────────────────────────────────────────────────────────────
  function init() {
    log('Content script initialised', window.location.href);

    // Wrap the async handler so we can synchronously return `true`
    // to keep the messaging channel open until `handleMessage`
    // finishes and calls `sendResponse`.
    chrome.runtime.onMessage.addListener((req, sender, resp) => {
      handleMessage(req, sender, resp);
      return true;
    });

    // commands handled in handleMessage

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