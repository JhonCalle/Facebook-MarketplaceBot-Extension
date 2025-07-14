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
    DEFAULT_MSG_LIMIT    : 10,
    DEFAULT_DELAY_MS     : 1500,
    WAIT_FOR_ELEMENT_MS  : 5000,
    WAIT_FOR_INTERVAL_MS : 100,
    WAIT: {
      inChat: 1000,         // Wait after opening chat
      beforeAPI: 1000,      // Wait before sending to API
      afterAPI: 15000,       // Wait after API response
      betweenReplies: 3000,  // Wait between sending replies
      afterLastReply: 1000,  // Wait after last reply
      noUnread: 2000         // Wait if no unread chats
    }
  };

  const SELECTORS = {
    composer        : '[contenteditable="true"][role="textbox"]',
    messageGroup    : 'div[data-testid="message-group"], div[role="row"]',
    header          : 'header[role="banner"]',
    headerLink      : 'header[role="banner"] a[role="link"][href*="/t/"][aria-label]',
    headerTitleSpan : 'h2 span[dir="auto"]',
    topChatLinks    : 'a[role="link"][href*="/t/"]'
  };

/**
 * Selector that matches the *blue‑dot wrapper* of unread chats.
 * We search for a <span data-visualcompletion="ignore"> nested within a
 * <div role="button" aria-hidden="true">.
 */
const UNREAD_DOT_SELECTOR =
  'div[role="button"][aria-hidden="true"] span[data-visualcompletion="ignore"]';

  // Simple storage helper used throughout the script
  const Storage = {
    /**
     * Retrieve a numeric value from chrome.storage.local, returning
     * `fallback` when the value is missing or invalid.
     */
    async getNumber(key, fallback) {
      return new Promise(resolve => {
        chrome.storage.local.get([key], result => {
          resolve(parseInt(result[key], 10) || fallback);
        });
      });
    }
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
    sentLabel2       : /Mensaje enviado/i,
    justSent         : /^enviado$/i,
    youSent          : /enviaste/i,
    suggested_response1: /Sí. ¿Te interesa?/i,
    suggested_response2: /Lo estoy mirando. Te avisaré./i,
    suggested_response3: /Lo siento, no está disponible./i,
    suggested_response4: /Envía una respuesta rápida./i,
    suggested_response5: /Toca una respuesta para enviársela al comprador./i
  };

  // Internal state ------------------------------------------------------------
  let isCycling = false;
  let isProcessingUnread = false;

  // ────────────────────────────────────────────────────────────────────────────
  // Overlay manager (UX feedback while bot runs)
  // ────────────────────────────────────────────────────────────────────────────
  // Lightweight UI overlay displayed while the bot is scanning chats.
  const Overlay = {
    // Create DOM elements if they do not exist yet
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
    // Display the overlay with an optional message
    show(text = 'Ejecutando...') {
      this.ensure();
      this.update(text);
      this.el.style.display = 'flex';
    },
    // Update the text shown on the overlay
    update(text) {
      if (!this.el) this.ensure();
      this.msg.innerHTML = text;
    },
    updateStep(step, lines = [], countdown) {
      const parts = [];
      if (countdown !== undefined) {
        parts.push(`<div style="font-size:28px;margin-bottom:8px;">${countdown}</div>`);
      }
      parts.push(`<div style="font-size:22px;margin-bottom:12px;">${step}</div>`);
      parts.push(...lines.map(l => `<div style="margin:4px 0;">${l}</div>`));
      const html = parts.join('<hr style="width:60%;border-color:#fff3;">');
      this.update(html);
    },
    // Remove the overlay from the page
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

  // imageSenderEnhanced.js – drop‑in module to reliably attach & send images in Messenger
// -----------------------------------------------------------------------------------
// USAGE
// 1. Import the helpers into content.js and replace the old Messenger.sendImage* calls with
//    `await ImageSender.sendImage(blob, { preferred: 'auto' /* or 'fileInput' | 'clipboard' | 'dragDrop' */ })`.
// 2. Make sure your manifest has "clipboardWrite" permission *and* ""clipboardRead" if you
//    want to reuse the clipboard method.
// 3. Keep background.js unchanged – it still provides the blob through fetchImage.
// -----------------------------------------------------------------------------------

const ImageSender = (() => {
  const SELECTORS = {
    composer : '[contenteditable="true"][role="textbox"]',
    // Messenger usually shows this input after clicking the 📎 (+) button
    hiddenFileInput : 'input[type="file"][multiple]',
    // The plus / clip icon that opens the native file input dialog
    addFilesButton : 'div[role="button"][aria-label*="archivo" i], div[role="button"][aria-label*="file" i]',
    // The mini preview bubble that appears once an image is attached
    uploadPreview  : 'img[src^="blob:"]',
  };

  // Small convenience helpers ------------------------------------------------
  async function delay(ms){ return new Promise(r => setTimeout(r, ms)); }
  function waitFor(fn, ms = 50, timeout = 4000){
    return new Promise(resolve => {
      const end = Date.now() + timeout;
      (function loop(){
        if (fn()) return resolve(true);
        if (Date.now() > end) return resolve(false);
        setTimeout(loop, ms);
      })();
    });
  }
  function focusComposer(){
    const el = document.querySelector(SELECTORS.composer);
    if (el) el.focus();
    return el;
  }
  function pressEnter(){
    const composer = focusComposer();
    if (!composer) return false;
    const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    const ku = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    composer.dispatchEvent(kd); composer.dispatchEvent(ku);
    return true;
  }

  // STRATEGY 1 – hidden <input type="file"> ----------------------------------
  async function viaFileInput(blob){
    log('[ImageSender] viaFileInput called with blob:', blob);
    // 1) Try to reveal the hidden input (click the clip/plus icon)
    const button = document.querySelector(SELECTORS.addFilesButton);
    if (button){
      log('[ImageSender] Clicking addFilesButton');
      button.click();
      await delay(150);
    }

    const input  = document.querySelector(SELECTORS.hiddenFileInput);
    if (!input) {
      log('[ImageSender] hiddenFileInput not found');
      return false;
    }

    const file = new File([blob], `image.${blob.type.split('/')[1]}`, { type: blob.type });
    const dt   = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log('[ImageSender] Dispatched change event on hiddenFileInput');

    // Wait for the inline preview bubble, then press Enter
    const previewFound = await waitFor(() => document.querySelector(SELECTORS.uploadPreview));
    if (!previewFound) {
      log('[ImageSender] uploadPreview not found');
      return false;
    }
    await delay(200); // short buffer
    pressEnter();
    log('[ImageSender] Pressed Enter after file input');
    return true;
  }

  // STRATEGY 2 – Clipboard API -------------------------------------------------
  async function viaClipboard(blob){
    log('[ImageSender] viaClipboard called with blob:', blob);
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      log('[ImageSender] Wrote blob to clipboard');
    } catch (err){
      console.warn('[ImageSender] clipboard.write failed', err);
      log('[ImageSender] clipboard.write failed', err);
      return false;
    }
    const composer = focusComposer();
    if (!composer) {
      log('[ImageSender] composer not found');
      return false;
    }

    const pasteEvt = new ClipboardEvent('paste', { bubbles:true, clipboardData: new DataTransfer() });
    composer.dispatchEvent(pasteEvt);
    log('[ImageSender] Dispatched paste event on composer');

    // Messenger auto‑displays the preview inside the composer
    const previewFound = await waitFor(() => document.querySelector(SELECTORS.uploadPreview));
    if (!previewFound) {
      log('[ImageSender] uploadPreview not found');
      return false;
    }
    pressEnter();
    log('[ImageSender] Pressed Enter after clipboard paste');
    return true;
  }

  // STRATEGY 3 – Simulated drag‑and‑drop --------------------------------------
  async function viaDragDrop(blob){
    log('[ImageSender] viaDragDrop called with blob:', blob);
    const composer = focusComposer();
    if (!composer) {
      log('[ImageSender] composer not found');
      return false;
    }

    const file = new File([blob], `image.${blob.type.split('/')[1]}`, { type: blob.type });
    const dt   = new DataTransfer();
    dt.items.add(file);

    const dragOver = new DragEvent('dragover', { bubbles: true, dataTransfer: dt });
    const drop     = new DragEvent('drop',     { bubbles: true, dataTransfer: dt });
    composer.dispatchEvent(dragOver);
    composer.dispatchEvent(drop);
    log('[ImageSender] Dispatched dragover and drop events on composer');

    const previewFound = await waitFor(() => document.querySelector(SELECTORS.uploadPreview));
    if (!previewFound) {
      log('[ImageSender] uploadPreview not found');
      return false;
    }
    pressEnter();
    log('[ImageSender] Pressed Enter after drag and drop');
    return true;
  }

  // Public facade -------------------------------------------------------------
  /**
   * Attempt to attach & send an image using progressively more permissive
   * strategies. Return `true` on first success, else `false`.
   *
   * @param {Blob} blob
   * @param {{preferred?: 'auto'|'fileInput'|'clipboard'|'dragDrop'}} opts
   */
  async function sendImage(blob, opts = {}){
    log('[ImageSender] sendImage called with blob:', blob, 'and options:', opts);
    const order = (() => {
      if (opts.preferred && opts.preferred !== 'auto') return [opts.preferred];
      // Default priority: native file input ➜ clipboard ➜ drag‑drop
      return ['fileInput', 'clipboard', 'dragDrop'];
    })();

    for (const method of order){
      let ok = false;
      try {
        log(`[ImageSender] Attempting to send via ${method}`);
        if (method === 'fileInput')  ok = await viaFileInput(blob);
        if (method === 'clipboard')  ok = await viaClipboard(blob);
        if (method === 'dragDrop')   ok = await viaDragDrop(blob);
      } catch (e){
        console.warn(`[ImageSender] ${method} failed`, e);
        log(`[ImageSender] ${method} failed with error:`, e);
        ok = false;
      }
      if (ok) {
        console.log('[ImageSender] sent via', method);
        log('[ImageSender] sent via', method);
        return true;
      }
      log(`[ImageSender] ${method} failed`);
    }
    console.error('[ImageSender] all strategies failed');
    log('[ImageSender] all strategies failed');
    return false;
  }

  return { sendImage };
})();

// Expose globally for debugging
window.ImageSender = ImageSender;


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

  async function pause(ms, step, lines = []) {
    const end = Date.now() + ms;
    let last = -1;
    while (isCycling && Date.now() < end) {
      const remaining = Math.ceil((end - Date.now()) / 1000);
      if (step && remaining !== last) {
        Overlay.updateStep(step, lines, `${remaining}s`);
        last = remaining;
      }
      await delay(500);
    }
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

    /**
     * Sends a message through the open Messenger chat.
     * Returns true on success and false if the composer could not be found.
     */
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

    async sendImageClipboard(blob) {
      const composer = this.focusComposer();
      if (!composer) return false;
      try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } catch (err) {
        log('Clipboard write failed', err);
        return false;
      }
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'image', { type: blob.type }));
      const pasteEvt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true });
      composer.dispatchEvent(pasteEvt);
      await delay(600);
      const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      const up   = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      composer.dispatchEvent(down);
      composer.dispatchEvent(up);
      return true;
    },

    async sendImageUpload(blob) {
      const input = document.querySelector('input[type="file"]');
      if (!input) { log('File input not found'); return false; }
      const file = new File([blob], 'image.' + blob.type.split('/')[1], { type: blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(1000);
      const composer = this.focusComposer();
      if (composer) {
        const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
        const up   = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
        composer.dispatchEvent(down);
        composer.dispatchEvent(up);
      }
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
      const clientName = Messenger.extractChatTitle().split('·')[0]?.toLowerCase() || '';

      const filtered = messages.filter(m => {
        const t = m.text.toLowerCase();
        if (!t) return false;
        if (t === 'enter') return false;
        if (REGEX.justSent.test(t)) return false;
        if (t === clientName) return false;
        if (REGEX.timeOnly.test(t)) return false;
        if (REGEX.dateTimeText.test(t) || REGEX.numericDateTime.test(t)) return false;
        if (REGEX.relativeTime.test(t)) return false;
        if (REGEX.awaitingResponse.test(t)) return false;
        if (REGEX.viewPost.test(t)) return false;
        if (REGEX.sentLabel.test(t)) return false;
        if (REGEX.sentLabel2.test(t)) return false;
        if (REGEX.suggested_response1.test(t)) return false;
        if (REGEX.suggested_response2.test(t)) return false;
        if (REGEX.suggested_response3.test(t)) return false;
        if (REGEX.suggested_response4.test(t)) return false;
        if (REGEX.suggested_response5.test(t)) return false;
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
   * @returns {Promise<{ replies: string[] } | null>}
     */
    async sendChat(chatData) {
      const webhookUrl = 'https://n8nimpulsa.zapto.org/webhook/ImpulsaAIbot';
      
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

        let replies = [];
        if (Array.isArray(responseData.response)) {
          replies = responseData.response;
        } else if (typeof responseData.response === 'string') {
          replies = [responseData.response];
        }

        if (!replies.length) {
          replies = ['Respuesta recibida del servidor sin contenido de respuesta.'];
        }

        return { replies };
        
      } catch (error) {
        console.error('Error sending data to webhook:', error);
        return { replies: [`Error al conectar con el servidor: ${error.message}`] };
      }
    }
  };

  function isUnreadChatRow(rowEl) {
    if (!rowEl) return false;
    // ✓ Dot present? (robust in current DOM build)
    if (rowEl.querySelector(UNREAD_DOT_SELECTOR)) return true;
  
    // Fallback: aria‑label heuristic (covers unexpected lang/DOM variations)
    const aria = (rowEl.getAttribute('aria-label') || '').trim().toLowerCase();
    return aria.endsWith('unread') || aria.endsWith('sin leer');
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
        .find(el => el.textContent.trim() === 'Marketplace');
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
      const allChats      = await this.scanTopChats(30);
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
        const previewText =
          `Title chat ${chatTitle}\n` +
          `Messages:\n${messages.map(m => `${m.sender}: ${m.text}`).join('\n')}\n` +
          `Response to be send: ${replies.join('\n')}`;

        Overlay.show(previewText);

        for (let t = 0; t < 5000 && isCycling; t += 500) {
          await delay(500);
        }

        // Si el usuario no canceló, enviar la respuesta
        if (isCycling) {
          Overlay.update('Enviando respuesta...');
          for (const msg of replies) {
            await Messenger.sendMessage(msg);
            if (msg !== replies[replies.length - 1]) {
              await pause(3000, 'Waiting', []);
            }
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
        const chats = await this.scanTopChats(20);
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

    async processUnreadChats(chatLimit = 20, msgLimit = 20) {
      if (isCycling) { log('processUnreadChats already running'); return; }
      isCycling = true;
      try {
        Overlay.show('Scanning chats...');
        const chats = await this.scanTopChats(20);
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
          await pause(CONFIG.WAIT.afterAPI, 'API Response', [replies.join('\n')]);
          if (!isCycling) break;
          for (const msg of replies) {
            Overlay.updateStep('Sending reply', [msg]);
            await Messenger.sendMessage(msg);
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

  // Detect chats marked as unread in the Marketplace interface
  function checkForNewMessages() {
    const unread = [];
    const chatLinks = document.querySelectorAll(SELECTORS.topChatLinks);
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
          const limit = await Storage.getNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const messages = await Messenger.extractLastMessages(limit);
          sendResponse({ messages });
          break;
        }

        case MSG.SCAN_TOP:
          sendResponse({ chats: await ChatScanner.scanTopChats() });
          break;

        case MSG.CHECK_NEW: {
          const unread = checkForNewMessages();
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

        case MSG.SCAN_DETAILED: {
          const msgLimit = await Storage.getNumber('scanLimit', CONFIG.DEFAULT_MSG_LIMIT);
          const data = await ChatScanner.collectChatsData(CONFIG.DEFAULT_CHAT_LIMIT, msgLimit, CONFIG.DEFAULT_DELAY_MS);
          sendResponse({ chatsData: data });
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
            log('SEND_TEST_IMAGE: calling ImageSender.sendImage with method:', request.method);
            const sent = await ImageSender.sendImage(blob, { preferred: request.method === 'upload' ? 'fileInput' : request.method === 'clipboard' ? 'clipboard' : 'auto' });
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
  function fetchImageViaBackground(url) {
    log('fetchImageViaBackground: called with url', url); // ADDED
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchImage', url }, response => {
        log('fetchImageViaBackground: received response', response); // ADDED
        console.log('fetchImageViaBackground: full response object', response); // ADDED
        if (response && response.success) {
          resolve(response.dataUrl);
        } else {
          reject(response ? response.error : 'Unknown error');
        }
      });
    });
  }

  // Helper: convert dataURL to Blob
  function dataURLToBlob(dataUrl) {
    const arr = dataUrl.split(','), mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }
  // ────────────────────────────────────────────────────────────────────────────

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

    chrome.runtime.onMessage.addListener(handleMessage);

    // Listener for simplified popup commands
    chrome.runtime.onMessage.addListener(async (req, sender, sendResponse) => {
      if (req.action === MSG.START_BOT) {
        if (isCycling) { sendResponse({ started: false, reason: 'already_running' }); return; }
        const limit = req.chatLimit || CONFIG.DEFAULT_CHAT_LIMIT;
        ChatScanner.processUnreadChats(limit, CONFIG.DEFAULT_MSG_LIMIT);
        sendResponse({ started: true });
      } else if (req.action === MSG.STOP_BOT) {
        isCycling = false;
        const composer = document.querySelector(SELECTORS.composer);
        if (composer) {
          composer.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        }
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
