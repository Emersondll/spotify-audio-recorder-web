(() => {
  // The service worker may inject this script again (tabs opened before the extension was
  // reloaded). The newest instance wins; older ones stop themselves.
  const INSTANCE = Math.random();
  window.__aarInstance = INSTANCE;
  // Spotify "now playing" bar: stable data-testid hooks (class names are hashed and change).
  const WIDGET = '[data-testid="now-playing-widget"]';
  const TITLE = '[data-testid="context-item-link"]';
  const ARTIST = '[data-testid="context-item-info-artist"]';
  let lastTitle = '';
  let debounce = 0;
  let timer = 0;
  const stop = () => { clearInterval(timer); clearTimeout(debounce); observer.disconnect(); };

  const normalize = s => (s || '').replace(/\s+/g, ' ').trim();

  function currentInfo() {
    const widget = document.querySelector(WIDGET);
    if (!widget) return null;
    let title = normalize(widget.querySelector(TITLE)?.textContent);
    let artist = normalize(widget.querySelector(ARTIST)?.textContent);
    if (!title) {
      // Fallback: aria-label "Em reprodução: <título> de <artista>"
      const m = (widget.getAttribute('aria-label') || '').match(/:\s*(.+)\s+de\s+(.+)$/);
      if (!m) return null;
      title = normalize(m[1]); artist = normalize(m[2]);
    }
    const img = widget.querySelector('[data-testid="cover-art-image"]');
    // data-image-status is "loaded" only once the new artwork has actually arrived.
    const ready = !!img?.src && (img.getAttribute('data-image-status') || 'loaded') === 'loaded';
    return { title, artist, cover: ready ? img.src : '', name: artist ? `${title} - ${artist}` : title };
  }

  const report = msg => chrome.runtime.sendMessage({ type: 'LOG', src: 'pagina', msg }).catch(() => {});
  let warned = false;

  let lastCover = '';
  let pendingSince = 0;
  let candidate = '';

  function check(force = false) {
    if (!chrome.runtime?.id || window.__aarInstance !== INSTANCE) return stop();
    const info = currentInfo();
    if (!info && !warned && force && /spotify/.test(location.hostname)) { warned = true; report('Player (now-playing-widget) não encontrado nesta página: ' + location.hostname); }
    if (!info || (!force && info.name === lastTitle)) return;

    // The cover <img> updates a moment after the title: wait for it to load and change.
    // pendingSince = the moment this new track was first seen (used to cut the audio exactly).
    if (candidate !== info.name) { candidate = info.name; pendingSince = Date.now(); }
    // Empty/not-yet-loaded cover: wait longer (the <img> is re-created on every track change).
    if (!force) {
      const waited = Date.now() - pendingSince;
      if (!info.cover && waited < 5000) return;
      if (info.cover === lastCover && waited < 1500) return;
    }
    const changedAt = pendingSince || Date.now();
    pendingSince = 0;

    const old = lastTitle;
    lastTitle = info.name;
    lastCover = info.cover;
    report('Título lido: ' + info.name + (info.cover ? ' (com capa)' : ' (sem capa)'));
    chrome.runtime.sendMessage({
      type: 'AUDIO_TITLE_CHANGED',
      oldName: old,
      newName: info.name,
      title: info.title,
      artist: info.artist,
      cover: info.cover,
      changedAt,
      pageUrl: location.href
    }).catch(() => {});
  }

  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => check(false), 100);
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-label']
  });

  // Polling is intentional. Modern SPAs can replace the entire player subtree without
  // producing a useful mutation on the original node.
  timer = setInterval(() => check(false), 300);
  check(true);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'GET_CURRENT_TITLE') { check(true); return false; }
  });
})();
