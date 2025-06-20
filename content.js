// content.js – combinación final: ignorar 'Enter' y el nombre del chat en los mensajes

// Debug function para consola y popup/background
function debugLog(message, data) {
  console.log(`[Marketplace Bot] ${message}`, data || '');
  chrome.runtime.sendMessage({ action: 'log', message, data });
}

// Inicialización
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();

function init() {
  debugLog('Content script loaded:', window.location.href);

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    debugLog('Received action:', request.action);
    if (request.action === 'ping') {
      sendResponse({ status: 'active' });
      return true;
    }
    if (request.action === 'scanTitle') {
      const title = extractChatTitle();
      debugLog('Extracted title:', title);
      sendResponse({ title });
      return true;
    }
    if (request.action === 'scanMessages') {
      const messages = extractLastMessages(10);
      debugLog('Extracted messages:', messages);
      sendResponse({ messages });
      return true;
    }
  });

  // Observador de URL para Marketplace
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

// Extrae título de conversación activa (nombre del chat)
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

// Extrae los últimos 'count' mensajes, ignorando 'Enter' y el nombre del chat
function extractLastMessages(count) {
  const container = document.querySelector('div[data-pagelet][role="main"]')
                  || document.querySelector('[data-testid="messenger_list_view"]')
                  || document.body;

  // Recopilar todos los mensajes en orden
  let groups = container.querySelectorAll('div[data-testid="message-group"]');
  if (!groups.length) groups = container.querySelectorAll('div[role="row"]');

  const raw = [];
  groups.forEach(group => {
    group.querySelectorAll('span[dir="auto"]').forEach(span => {
      const text = span.textContent.trim();
      if (text) raw.push(text);
    });
  });

  if (!raw.length) {
    // Fallback: todos los spans
    container.querySelectorAll('span[dir="auto"]').forEach(span => {
      const t = span.textContent.trim();
      if (t) raw.push(t);
    });
  }

    // Encontrar índice donde aparece el texto de inicio relevante (p.ej. "inició este chat")
    const markerText = 'inició este chat';
    // Busca la primera línea que contenga ese marcador
    const markerIndex = raw.findIndex(t => t.toLowerCase().includes(markerText));
    const base = markerIndex >= 0 ? raw.slice(markerIndex) : slicedRaw;
  
    // Filtrar valores indeseados (Enter y nombre del chat)
    const filtered = base.filter(t => t !== 'Enter' && t !== extractChatTitle());
  
    // Devolver últimos 'count' mensajes filtrados
    return filtered.slice(-count).map(text => ({ text }));(-count).map(text => ({ text }));
  }
  