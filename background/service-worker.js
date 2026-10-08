const OFFSCREEN_URL = 'offscreen/offscreen.html';
const activeTabs = new Map();
const queues = new Map();

// Diagnostic log shown in the popup (chrome.storage.local survives service worker restarts).
let logChain = Promise.resolve();
function dlog(src, msg) {
  console.log(`[Audio Recorder][${src}]`, msg);
  logChain = logChain.then(async () => {
    const { logs = [] } = await chrome.storage.local.get('logs');
    logs.push({ t: Date.now(), src, msg: String(msg).slice(0, 300) });
    await chrome.storage.local.set({ logs: logs.slice(-60) });
  }).catch(() => {});
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capturar e gravar áudio da guia continuamente.'
    });
  }
}

function cleanName(name) {
  let s = String(name || 'audio').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim();
  return (s || 'audio').slice(0, 180);
}

function enqueue(tabId, task) {
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function startCapture(tabId) {
  if (!tabId) throw new Error('Guia inválida.');
  // The service worker is suspended after ~30s idle, so activeTabs can't be trusted:
  // the offscreen document is the source of truth for running sessions.
  if (activeTabs.get(tabId)?.capturing && await offscreenExists()) return { ok: true, alreadyActive: true };

  dlog('sw', `Iniciando captura da aba ${tabId}`);
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await chrome.runtime.sendMessage({ type: 'START_CAPTURE', tabId, streamId });
  activeTabs.set(tabId, { capturing: true });

  // Ask the content script for the title only after the offscreen recorder is ready.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GET_CURRENT_TITLE' });
  } catch {
    // No content script in this tab (opened before the extension was loaded/reloaded): inject it.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/observer.js'] });
      dlog('sw', 'Script da página injetado na aba');
      await chrome.tabs.sendMessage(tabId, { type: 'GET_CURRENT_TITLE' }).catch(() => {});
    } catch (e) { dlog('sw', 'ERRO ao injetar script da página: ' + (e?.message || e)); }
  }
  return { ok: true };
}

async function stopCapture(tabId) {
  if (!await offscreenExists()) { activeTabs.delete(tabId); return { ok: true, alreadyStopped: true }; }

  // Keep active state until the offscreen document confirms the final segment was saved.
  const result = await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', tabId });
  activeTabs.delete(tabId);
  return result?.ok === false ? result : { ok: true };
}

function waitDownload(downloadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error('Timeout aguardando conclusão do download temporário.'));
    }, timeoutMs);
    const onChanged = delta => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        clearTimeout(timer); chrome.downloads.onChanged.removeListener(onChanged); resolve();
      } else if (delta.state.current === 'interrupted') {
        clearTimeout(timer); chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error('Download interrompido: ' + (delta.error?.current || 'desconhecido')));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function saveFile(url, name) {
  const id = await chrome.downloads.download({
    url,
    filename: `${cleanName(name)}.mp3`,
    conflictAction: 'uniquify',
    saveAs: false
  });
  await waitDownload(id);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'LOG') { dlog(message.src || '?', message.msg); return false; }

  if (message?.type === 'SAVE_FILE') {
    dlog('sw', `Salvando download: ${message.name}.mp3`);
    saveFile(message.url, message.name)
      .then(() => { dlog('sw', 'Download concluído'); sendResponse({ ok: true }); })
      .catch(e => { dlog('sw', 'ERRO download: ' + (e?.message || e)); sendResponse({ ok: false, error: e?.message || String(e) }); });
    return true;
  }

  if (message?.type === 'START_RECORDING') {
    enqueue(message.tabId ?? sender.tab?.id, () => startCapture(message.tabId ?? sender.tab?.id))
      .then(sendResponse).catch(e => sendResponse({ ok:false, error:e?.message || String(e) }));
    return true;
  }

  if (message?.type === 'STOP_RECORDING') {
    enqueue(message.tabId ?? sender.tab?.id, () => stopCapture(message.tabId ?? sender.tab?.id))
      .then(sendResponse).catch(e => sendResponse({ ok:false, error:e?.message || String(e) }));
    return true;
  }

  if (message?.type === 'AUDIO_TITLE_CHANGED') {
    const tabId = sender.tab?.id;
    dlog('sw', `Título recebido da página: ${message.newName}`);
  if (!tabId || !message.newName) return;
    enqueue(tabId, async () => {
      // No offscreen document means nothing is being recorded; never create one here.
      if (!await offscreenExists()) return;
      await chrome.runtime.sendMessage({
        type: 'TITLE_CHANGED',
        tabId,
        oldName: cleanName(message.oldName),
        newName: cleanName(message.newName),
        changedAt: message.changedAt || 0,
        meta: { title: message.title || '', artist: message.artist || '', cover: message.cover || '' }
      });
    }).catch(e => dlog('sw', 'ERRO ao repassar título: ' + (e?.message || e)));
    return;
  }

  if (message?.type === 'CAPTURE_STATUS') {
    if (message.status === 'stopped' || message.status === 'error') {
      enqueue(message.tabId, () => stopCapture(message.tabId)).catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(tabId, () => stopCapture(tabId)).catch(() => {});
});
