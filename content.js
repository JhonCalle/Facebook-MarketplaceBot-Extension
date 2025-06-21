// content.js – clasificación buyer/seller + ciclo de navegación secuencial por chats
// -----------------------------------------------------------------------------

let isCycling = false; // evita múltiples ejecuciones simultáneas

function debugLog(message, data) {
  console.log(`[Marketplace Bot] ${message}`, data || '');
  chrome.runtime.sendMessage({ action: 'log', message, data });
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();

function init() {
  debugLog('Content script loaded:', window.location.href);

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    debugLog('Received action:', request.action);

    switch (request.action) {
      case 'ping':
        sendResponse({ status: 'active' });
        return true;

      case 'scanTitle':
        sendResponse({ title: extractChatTitle() });
        return true;

      case 'scanMessages':
        debugLog('scanMessages recibido, extrayendo mensajes...');
        chrome.storage.local.get(['scanLimit'], async result => {
          const limit = parseInt(result.scanLimit, 10) || 10;
          const messages = await extractLastMessages(limit);
          debugLog(`Mensajes extraídos (${messages.length}):`, messages);
          sendResponse({ messages });
        });
        return true;

      case 'scanTopChats':
        sendResponse({ chats: scanTopChats() });
        return true;

      case 'cycleChats':
        startChatCycling();
        sendResponse({ started: true, total: scanTopChats().length });
        return true;

      default:
        return false;
    }
  });

  // Observador de URL ... (sin cambios)
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
// NUEVA FUNCIÓN: navegar secuencialmente por los chats
// -----------------------------------------------------------------------------
function startChatCycling(delay = 3000) {
  if (isCycling) {
    debugLog('Ya existe un ciclo en ejecución; ignorando solicitud');
    return;
  }
  isCycling = true;

  const chats   = scanTopChats();
  const chatIds = chats.map(c => c.id).filter(Boolean);
  let index     = 0;

  debugLog(`Iniciando recorrido por ${chatIds.length} chats`);

  (function next() {
    if (index >= chatIds.length) {
      debugLog('Ciclo completado');
      isCycling = false;
      return;
    }

    const id = chatIds[index++];
    debugLog(`(${index}/${chatIds.length}) Abriendo chat ID: ${id}`);

    // Intenta usar click para navegación SPA; fallback cambia href
    const link = document.querySelector(`a[role="link"][href*="/t/${id}"]`);
    if (link) {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } else {
      window.location.href = `https://www.messenger.com/t/${id}`;
    }

    setTimeout(next, delay);
  })();
}

// -----------------------------------------------------------------------------
// Lógica para escanear top 10 chats disponibles solo dentro de Marketplace
// -----------------------------------------------------------------------------
function scanTopChats() {
  // Intentar ubicar el panel de chats de Marketplace en la barra lateral
  let container = document;
  const spans = Array.from(document.querySelectorAll('span[dir="auto"]'));
  const marketSpan = spans.find(span => span.textContent.trim() === 'Marketplace');
  if (marketSpan) {
    const panel = marketSpan.closest('div[role="navigation"]');
    if (panel) {
      container = panel;
    }
  }

  // Selecciona los enlaces de chat dentro del contenedor de Marketplace
  const chatLinks = container.querySelectorAll('a[role="link"][href*="/t/"]');
  const chats = Array.from(chatLinks)
    .slice(0, 10)
    .map(link => {
      // Título del chat (nombre del comprador o descripción)
      const title = link.getAttribute('aria-label')?.trim() || link.textContent.trim();
      // Extraer ID del chat de la URL
      const match = link.href.match(/\/t\/([^\/?#]+)/);
      const id = match ? match[1] : null;
      return { title, id };
    });
  return chats;
}

// Función de prueba invocada desde el popup
function scanTopChatsFromPopup() {
  const chats = scanTopChats();
  chats.forEach(chat => {
    debugLog(`Chat encontrado: ${chat.title}`, chat.id);
  });
  return chats;
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

async function extractLastMessages(count) {
  const container =
    document.querySelector('div[data-pagelet][role="main"]') ||
    document.querySelector('[data-testid="messenger_list_view"]') ||
    document.body;

  let groups = container.querySelectorAll('div[data-testid="message-group"]');
  if (!groups.length) groups = container.querySelectorAll('div[role="row"]');

  let messages = [];
  groups.forEach(group => {
    const isSeller = /enviaste/i.test(group.textContent);
    const sender = isSeller
      ? 'seller'
      : group.querySelector('[data-testid="outgoing_message"]')
        ? 'seller'
        : 'buyer';

    group.querySelectorAll('span[dir="auto"]').forEach(span => {
      const text = span.textContent.trim();
      if (text) messages.push({ text, sender });
    });
  });

  if (!messages.length) {
    container.querySelectorAll('span[dir="auto"]').forEach(span => {
      const txt = span.textContent.trim();
      if (txt) messages.push({ text: txt, sender: 'unknown' });
    });
  }

  // Filtrado tras "inició este chat"
  const markerRegex = /inició este chat/i;
  const markerIndex = messages.findIndex(m => markerRegex.test(m.text));
  if (markerIndex >= 0) {
    messages = messages.slice(markerIndex);
    debugLog('Sliced after marker at index', markerIndex);
  }

  // Definición de expresiones regulares para filtrar metadatos
  const timeRegex = /^\d{1,2}:\d{2}(?:\s?[ap]m)?$/i;
  const dateTimeRegex = /\d{1,2}\s(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s\d{4},?\s\d{1,2}:\d{2}/i;
  const numericDateRegex = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s?\d{1,2}:\d{2}(?:\s?[ap]m)?$/i;
  const relativeTimeRegex = /^enviado hace\s?\d+/i;
  const awaitingResponseRegex = /está esperando tu respuesta/i;
  const viewPostRegex = /ver publicación/i;
  const sentRegex = /message sent/i;
  const soloEnviadoRegex = /^enviado$/i;

  // Obtener nombre del comprador para excluirlo
  const buyerName = extractChatTitle().split(/[\s·-]/)[0]?.trim().toLowerCase();

  // Filtrado de mensajes
  const filtered = messages.filter(m => {
    const t = m.text?.trim();
    if (!t) return false;
    if (t === 'Enter') return false;
    if (/^enviaste$/i.test(t)) return false;
    if (soloEnviadoRegex.test(t)) return false;
    if (t.toLowerCase() === buyerName) return false;
    if (timeRegex.test(t)) return false;
    if (dateTimeRegex.test(t) || numericDateRegex.test(t)) return false;
    if (relativeTimeRegex.test(t)) return false;
    if (awaitingResponseRegex.test(t)) return false;
    if (viewPostRegex.test(t)) return false;
    if (sentRegex.test(t)) return false;
    return true;
  });

  // Devolver solo los últimos 'count' mensajes relevantes
  return filtered.slice(-count);
}

