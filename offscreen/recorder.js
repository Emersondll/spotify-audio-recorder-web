const sessions = new Map();

function supportedMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function sendError(e) {
  log('ERRO:', e?.message || e);
  chrome.runtime.sendMessage({ type:'OFFSCREEN_ERROR', error:e?.stack || e?.message || String(e) }).catch(()=>{});
}

const log = (...a) => {
  console.log('[Audio Recorder]', ...a);
  chrome.runtime.sendMessage({ type: 'LOG', src: 'offscreen', msg: a.join(' ') }).catch(() => {});
};

// ---- PCM helpers: segments are decoded so they can be cut/joined with sample accuracy ----
async function decodePcm(blob) {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  const ch = [];
  for (let i = 0; i < Math.min(audio.numberOfChannels, 2); i++) ch.push(audio.getChannelData(i));
  return { sampleRate: audio.sampleRate, ch };
}

const pcmLength = p => p.ch[0]?.length || 0;
const emptyPcm = (sampleRate, channels = 2) => ({ sampleRate, ch: Array.from({ length: channels }, () => new Float32Array(0)) });
const slicePcm = (p, from, to) => ({ sampleRate: p.sampleRate, ch: p.ch.map(c => c.subarray(from, to)) });

function concatPcm(a, b) {
  if (!pcmLength(a)) return b;
  if (!pcmLength(b)) return a;
  const n = b.ch.length;
  const ch = [];
  for (let i = 0; i < n; i++) {
    const x = a.ch[Math.min(i, a.ch.length - 1)], y = b.ch[i];
    const out = new Float32Array(x.length + y.length);
    out.set(x, 0); out.set(y, x.length);
    ch.push(out);
  }
  return { sampleRate: b.sampleRate, ch };
}

function encodePcm(pcm) {
  const channels = pcm.ch.length;
  const toInt16 = f32 => {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }
    return out;
  };
  const left = toInt16(pcm.ch[0]);
  const right = channels > 1 ? toInt16(pcm.ch[1]) : null;
  const enc = new lamejs.Mp3Encoder(channels, pcm.sampleRate, 192);
  const parts = [];
  const BLOCK = 1152;
  for (let i = 0; i < left.length; i += BLOCK) {
    const buf = right
      ? enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK))
      : enc.encodeBuffer(left.subarray(i, i + BLOCK));
    if (buf.length) parts.push(new Int8Array(buf));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Int8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

// ---- ID3v2.3 tag (title, artist, cover art) prepended to the MP3 ----
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const syncsafe = n => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const ascii = str => [...str].map(c => c.charCodeAt(0) & 127);
function utf16(str) {
  const out = [0xFF, 0xFE];
  for (const ch of str) { const c = ch.charCodeAt(0); out.push(c & 255, c >> 8); }
  return out;
}
function frame(id, body) { return [...ascii(id), ...u32(body.length), 0, 0, ...body]; }
function textFrame(id, text) { return frame(id, [1, ...utf16(text), 0, 0]); }

async function fetchCover(url) {
  if (!url) return null;
  // Spotify serves several sizes; prefer the 640px variant, fall back to the original.
  const big = url.replace(/ab67616d0000[0-9a-f]{4}/, 'ab67616d0000b273');
  for (const u of [...new Set([big, url])]) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (bytes.length) return { bytes, mime };
    } catch (e) { log('Falha ao baixar capa:', e?.message || e); }
  }
  return null;
}

async function withTags(mp3, meta) {
  try {
    if (!meta) return mp3;
    const frames = [];
    if (meta.title) frames.push(...textFrame('TIT2', meta.title));
    if (meta.artist) frames.push(...textFrame('TPE1', meta.artist));
    const cover = await fetchCover(meta.cover);
    if (cover) {
      const head = [0, ...ascii(cover.mime), 0, 3, 0];   // latin1, mime, front cover, empty description
      const body = new Uint8Array(head.length + cover.bytes.length);
      body.set(head); body.set(cover.bytes, head.length);
      frames.push(...frame('APIC', body));
    } else if (meta.cover) log('Capa não incluída (download falhou)');
    if (!frames.length) return mp3;
    const tag = new Uint8Array([...ascii('ID3'), 3, 0, 0, ...syncsafe(frames.length), ...frames]);
    return new Blob([tag, mp3], { type: 'audio/mpeg' });
  } catch (e) { log('Falha ao gravar tags ID3:', e?.message || e); return mp3; }
}

// chrome.downloads is not available in offscreen documents: hand the blob URL to the
// service worker, which performs the download. The URL stays valid while this document lives.
async function saveMp3(pcm, name, meta) {
  const mp3 = await withTags(encodePcm(pcm), meta);
  const url = URL.createObjectURL(mp3);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'SAVE_FILE', url, name });
    if (!r?.ok) throw new Error(r?.error || 'Falha ao salvar o MP3.');
    log('MP3 salvo:', name);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

function createRecorder(s) {
  const mime = supportedMime();
  s.chunks = [];
  s.recorder = mime ? new MediaRecorder(s.stream, { mimeType:mime }) : new MediaRecorder(s.stream);
  const chunks = s.chunks;
  s.recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  s.recorder.start(1000);
  s.startedAt = Date.now();
}

// Resolves with the finished segment as soon as the recorder emits its final data.
function stopRecorder(recorder, chunks) {
  return new Promise((resolve, reject) => {
    if (!recorder || recorder.state === 'inactive') return resolve(null);
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    recorder.onerror = e => reject(e.error || new Error('Erro no MediaRecorder'));
    try { recorder.stop(); } catch (e) { reject(e); }
  });
}

// Turns a finished segment into an MP3. Runs off the recording path (jobs are serialized),
// so the slow decode/encode/download never delays the next segment's recording.
//
// seg.boundaryAt: wall-clock moment the next track really began (page-side detection time).
// seg.nextStartAt: wall-clock moment the next recorder started. Audio between the two was
// recorded by THIS recorder but belongs to the next track, so it is carried over to the
// beginning of the next file instead of being lost.
async function processSegment(s, seg) {
  if (!seg.blob?.size) throw new Error(`Segmento vazio: ${seg.name}`);
  const pcm = await decodePcm(seg.blob);
  const sr = pcm.sampleRate, len = pcmLength(pcm);
  const idx = t => Math.max(0, Math.min(len, Math.round(((t - seg.startedAt) / 1000) * sr)));

  let own = pcm, carryOut = emptyPcm(sr, pcm.ch.length);
  if (seg.nextStartAt) {
    const boundary = Math.max(seg.startedAt, Math.min(seg.boundaryAt || seg.nextStartAt, seg.nextStartAt));
    const keep = idx(boundary), next = Math.max(keep, idx(seg.nextStartAt));
    own = slicePcm(pcm, 0, keep);
    carryOut = slicePcm(pcm, keep, next);
  }

  const full = concatPcm(s.carry || emptyPcm(sr, pcm.ch.length), own);
  if (pcmLength(full) < sr) {
    // Too short to be a real track (title flicker): merge into the next segment, lose nothing.
    s.carry = concatPcm(full, carryOut);
    log('Segmento curto demais, unido ao próximo:', seg.name);
    return;
  }
  s.carry = carryOut;
  log(`Convertendo ${seg.name} (${(pcmLength(full) / sr).toFixed(1)}s)`);
  await saveMp3(full, seg.name || 'audio', seg.meta);
}

function enqueueJob(s, seg) {
  const p = s.chain.then(() => processSegment(s, seg));
  s.chain = p.catch(e => sendError(e));
  return p;
}

async function startCapture(tabId, streamId) {
  if (sessions.has(tabId)) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource:'tab', chromeMediaSourceId:streamId } },
    video: false
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);
  if (audioContext.state === 'suspended') await audioContext.resume();

  log('Captura de áudio da aba iniciada');
  const s = { tabId, stream, audioContext, source, recorder:null, chunks:[], startedAt:0, currentName:'audio', meta:null, named:false, chain:Promise.resolve(), carry:null };
  sessions.set(tabId, s);
  // Start recording right away so audio is captured even if no title is ever detected.
  createRecorder(s);
  stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => {
    if (sessions.get(tabId) === s) sessions.delete(tabId);
  }));
}

async function titleChanged(tabId, newName, meta, changedAt) {
  const s = sessions.get(tabId);
  if (!s || !newName) return;
  log('Título detectado:', newName);
  if (!s.named) { s.named = true; s.currentName = newName; s.meta = meta || null; return; }
  if (s.currentName === newName) return;

  // 1) Start the next recorder FIRST so no audio is dropped, 2) then close the old one.
  const old = { recorder: s.recorder, chunks: s.chunks, name: s.currentName, meta: s.meta, startedAt: s.startedAt };
  createRecorder(s);
  s.currentName = newName;
  s.meta = meta || null;

  const blob = await stopRecorder(old.recorder, old.chunks);
  enqueueJob(s, { ...old, blob, boundaryAt: changedAt, nextStartAt: s.startedAt }).catch(() => {});
}

async function stopCapture(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { ok:true, saved:false, message:'Nenhuma sessão no offscreen.' };
  try {
    const name = s.currentName || 'audio';
    const blob = await stopRecorder(s.recorder, s.chunks);
    s.recorder = null;
    let saved = false;
    if (blob) {
      await enqueueJob(s, { blob, name, meta: s.meta, startedAt: s.startedAt });
      saved = true;
    }
    await s.chain;
    s.stream.getTracks().forEach(t => t.stop());
    await s.audioContext.close().catch(()=>{});
    sessions.delete(tabId);
    return { ok:true, saved, name };
  } catch (e) {
    sendError(e);
    return { ok:false, error:e?.message || String(e), saved:false };
  }
}

const OFFSCREEN_TYPES = ['START_CAPTURE', 'TITLE_CHANGED', 'STOP_CAPTURE'];
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!OFFSCREEN_TYPES.includes(message?.type)) return false;
  (async () => {
    try {
      if (message?.type === 'START_CAPTURE') { await startCapture(message.tabId, message.streamId); sendResponse({ok:true}); }
      else if (message?.type === 'TITLE_CHANGED') { await titleChanged(message.tabId, message.newName, message.meta, message.changedAt); sendResponse({ok:true}); }
      else if (message?.type === 'STOP_CAPTURE') sendResponse(await stopCapture(message.tabId));
    } catch (e) { sendError(e); sendResponse({ok:false,error:e?.message || String(e)}); }
  })();
  return true;
});
