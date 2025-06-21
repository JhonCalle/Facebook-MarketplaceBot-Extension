// ============================================================================
// UPDATED FILE: content.js – navegación y extracción de chats detallada
// ----------------------------------------------------------------------------

// Este script ahora incluye la acción "scanChatsDetailed" que recorre los últimos
// 10 chats de Marketplace, entra en cada uno, extrae el título y los últimos
// mensajes (etiquetados buyer/seller) y devuelve un arreglo JSON al popup.
// -----------------------------------------------------------------------------

let isCycling = false; // evita ciclos simultáneos

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
        chrome.storage.local.get(['scanLimit'], async result => {
          const limit    = parseInt(result.scanLimit, 10) || 10;
          const messages = await extractLastMessages(limit);
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

      // ---------------- NUEVA ACCIÓN ----------------
      case 'scanChatsDetailed':
        chrome.storage.local.get(['scanLimit'], async result => {
          const msgLimit = parseInt(result.scanLimit, 10) || 10;
          const data     = await collectChatsData(10, msgLimit, 1800);
          sendResponse({ chatsData: data });
        });
        return true; // mantener canal abierto hasta que se resuelva la promesa

      default:
        return false;
    }
  });

  // Observador de cambios de URL (sin cambios)
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
// NUEVA FUNCIÓN PRINCIPAL – recorrido secuencial y extracción de datos
// -----------------------------------------------------------------------------
async function collectChatsData(chatLimit = 10, messagesLimit = 10, delay = 1500) {
  if (isCycling) {
    debugLog('Otro ciclo está en ejecución; abortando collectChatsData');
    return [];
  }
  isCycling = true;

  const chats   = scanTopChats().slice(0, chatLimit);
  const results = [];

  debugLog(`Comenzando extracción detallada de ${chats.length} chats`);

  for (let i = 0; i < chats.length; i++) {
    const { id, title } = chats[i];
    if (!id) continue;

    debugLog(`(${i + 1}/${chats.length}) Abriendo chat ID: ${id}`);

    // Navegación SPA; fallback a cambio de href completo
    const link = document.querySelector(`a[role="link"][href*="/t/${id}"]`);
    if (link) {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } else {
      window.location.href = `https://www.messenger.com/t/${id}`;
    }

    // Esperar a que cargue el chat (header con título y al menos 1 mensaje)
    await waitFor(() => document.querySelector('header[role="banner"]'));
    await waitFor(() => document.querySelector('div[data-testid="message-group"], div[role="row"]'));

    // Pequeña pausa extra para asegurar renderizado
    await new Promise(r => setTimeout(r, 400));

    const chatTitle = extractChatTitle();
    const messages  = await extractLastMessages(messagesLimit);

    results.push({
      clientName : chatTitle.split(/\s/)[0] || chatTitle,
      chatName   : chatTitle,
      messages   : messages
    });

    // Esperar antes de abrir el siguiente chat
    await new Promise(r => setTimeout(r, delay));
  }

  debugLog('Extracción completa', results);
  isCycling = false;
  return results;
}

// -----------------------------------------------------------------------------
// Utilidad: espera hasta que la condición sea verdadera o venza el timeout
// -----------------------------------------------------------------------------
function waitFor(conditionFn, interval = 100, timeout = 5000) {
  return new Promise((resolve) => {
    const start    = Date.now();
    const timerId  = setInterval(() => {
      if (conditionFn()) {
        clearInterval(timerId);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(timerId);
        resolve();
      }
    }, interval);
  });
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

