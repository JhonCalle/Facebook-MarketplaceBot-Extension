// content.js – clasificación buyer/seller usando "Enviaste" y filtrado tras "inició este chat"
// -----------------------------------------------------------------------------
function debugLog(message, data) {
  console.log(`[Marketplace Bot] ${message}`, data || '');
  chrome.runtime.sendMessage({ action: 'log', message, data });
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();

function init() {
  debugLog('Content script loaded:', window.location.href);

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    debugLog('Received action:', request.action);

    switch (request.action) {
      case 'ping':
        sendResponse({ status: 'active' });
        return true;
      case 'scanTitle': {
        const title = extractChatTitle();
        debugLog('Extracted title:', title);
        sendResponse({ title });
        return true;
      }
      case 'scanMessages': {
        const messages = extractLastMessages(10);
        debugLog('Filtered messages:', messages);
        sendResponse({ messages });
        return true;
      }
      default:
        return false;
    }
  });

  // Observador de URL para detectar cambios en Marketplace
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (/messenger\.com\/marketplace/.test(location.href)) {
        debugLog('Marketplace view detected');
        chrome.runtime.sendMessage({ action: 'checkForNewMessages' });
      }
    }
  }).observe(document, { childList: true, subtree: true });

  debugLog('Content script initialized');
}

// -----------------------------------------------------------------------------
// Auxiliares
// -----------------------------------------------------------------------------
function extractChatTitle() {
  const header = document.querySelector('header[role="banner"]');
  if (header) {
    const link = header.querySelector('a[role="link"][href*="/t/"][aria-label]');
    if (link) return link.getAttribute('aria-label').trim();
  }
  const span = document.querySelector('h2 span[dir="auto"]');
  if (span) return span.textContent.trim();
  return document.title;
}

/**
 * Devuelve los últimos `count` mensajes y etiqueta buyer/seller.
 * Utiliza “Enviaste” para seller y descarta todo lo anterior a “inició este chat”.
 */
function extractLastMessages(count = 10) {
  const container =
    document.querySelector('div[data-pagelet][role="main"]') ||
    document.querySelector('[data-testid="messenger_list_view"]') ||
    document.body;

  // Recolectar grupos de mensaje
  let groups = container.querySelectorAll('div[data-testid="message-group"]');
  if (!groups.length) groups = container.querySelectorAll('div[role="row"]');

  // Recopilar todos los spans con texto en orden
  let messages = [];
  groups.forEach(group => {
    // Determinar remitente
    const isSeller = /enviaste/i.test(group.textContent);
    let sender = isSeller ? 'seller' :
      group.querySelector('[data-testid="outgoing_message"]')
        ? 'seller'
        : 'buyer';

    // Extraer textos
    group.querySelectorAll('span[dir="auto"]').forEach(span => {
      const text = span.textContent.trim();
      if (text) messages.push({ text, sender });
    });
  });

  // Fallback absoluto
  if (!messages.length) {
    container.querySelectorAll('span[dir="auto"]').forEach(span => {
      const txt = span.textContent.trim();
      if (txt) messages.push({ text: txt, sender: 'unknown' });
    });
  }

  debugLog('Raw grouped texts:', messages);

  // -------------------------------------------------------------------------
  // Filtrado: eliminar mensajes antes de "inició este chat"
  // -------------------------------------------------------------------------
  const markerRegex = /inició este chat/i;
  const markerIndex = messages.findIndex(m => markerRegex.test(m.text));
  if (markerIndex >= 0) {
    messages = messages.slice(markerIndex);
    debugLog('Sliced after marker at index', markerIndex);
  }

  // -------------------------------------------------------------------------
  // Filtros adicionales: timestamps, sistema, nombre de comprador, etc.
  // -------------------------------------------------------------------------
  const timeRegex = /^\d{1,2}:\d{2}(?:\s?[ap]m)?$/i;
  const dateTimeRegex = /\d{1,2}\s(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s\d{4},?\s\d{1,2}:\d{2}/i;
  const relativeTimeRegex = /^enviado hace\s?\d+/i;
  const waitingRegex = /está esperando tu respuesta/i;
  const viewPostRegex = /ver publicación/i;
  const buyerName = extractChatTitle().split(/[\s·-]/)[0].trim().toLowerCase();
  const messagesend = /Message sent/i;

  const filtered = messages.filter(m => {
    const t = m.text;
    if (!t) return false;
    if (t === 'Enter') return false;
    if (/^enviaste$/i.test(t)) return false;
    if (t.toLowerCase() === buyerName) return false;
    if (timeRegex.test(t)) return false;
    if (dateTimeRegex.test(t)) return false;
    if (relativeTimeRegex.test(t)) return false;
    if (waitingRegex.test(t)) return false;
    if (viewPostRegex.test(t)) return false;
    if (messagesend.test(t)) return false;
    return true;
  });

  // Devolver últimos `count`
  return filtered.slice(-count);
}
