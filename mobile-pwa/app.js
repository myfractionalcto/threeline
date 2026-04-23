/**
 * Threelane mobile companion.
 *
 * Flow:
 *  1. WebSocket connects (wss://host:port/ws). Server assigns an id on `hello`.
 *  2. Phone runs a couple of NTP-style ping/pong rounds to measure clock offset.
 *  3. User taps "Grant camera & mic". Preview shows, phone signals "ready".
 *  4. Laptop broadcasts {type:'start', startAtMs, projectId}. Phone waits
 *     until startAt (clock-adjusted), then kicks off MediaRecorder.
 *  5. Laptop broadcasts {type:'stop'}. Phone stops recorder, uploads the
 *     resulting Blob to POST /upload/:projectId/:id.
 */

const statusEl = document.querySelector('#status');
const statusTextEl = statusEl.querySelector('.status-text');
const previewEl = document.querySelector('#preview');
const grantBtn = document.querySelector('#grant');
const msgEl = document.querySelector('#msg');
const hintEl = document.querySelector('#hint');
const recPill = document.querySelector('#rec-pill');
const recTimer = document.querySelector('#rec-timer');
const flipBtn = document.querySelector('#flip-cam');
const uploadRow = document.querySelector('#upload-row');
const progressBar = document.querySelector('#progress-bar');
const uploadLabel = document.querySelector('#upload-label');

// Reconnect UI
const reconnectEl = document.querySelector('#reconnect');
const reconnectTitleEl = document.querySelector('#reconnect-title');
const reconnectUrlLabelEl = document.querySelector('#reconnect-url-label');
const reconnectSubEl = document.querySelector('#reconnect-sub');
const reconnectRetryBtn = document.querySelector('#reconnect-retry');
const reconnectStopBtn = document.querySelector('#reconnect-stop');
const reconnectSavedBtn = document.querySelector('#reconnect-saved');
const reconnectScanBtn = document.querySelector('#reconnect-scan');
const reconnectForm = document.querySelector('#reconnect-form');
const reconnectUrlInput = document.querySelector('#reconnect-url');
const scanWrap = document.querySelector('#scan-wrap');
const scanVideo = document.querySelector('#scan-video');
const scanCancelBtn = document.querySelector('#scan-cancel');

const SAVED_URL_KEY = 'threelane:serverUrl';
/** Raw-IP fallback URL. Derived from `location.host` when the PWA is loaded
 *  from a `<ip-dashes>.local-ip.sh` hostname — we save it so subsequent
 *  connection failures (likely DNS-rebinding protection on this WiFi) can
 *  point the user at the raw-IP URL they'd need to visit instead. */
const FALLBACK_URL_KEY = 'threelane:fallbackUrl';
// Predecessors from earlier product names. Read-only fallback so a phone
// that already has a saved URL under the old name keeps reconnecting after
// the rebrand. Migrated forward the first time they're read.
const SAVED_URL_KEY_LEGACY = ['threeline:serverUrl'];
const FALLBACK_URL_KEY_LEGACY = ['threeline:fallbackUrl'];
const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 8000;

let ws = null;
let deviceId = null;
let clockOffsetMs = 0; // serverTime - clientTime
let mediaStream = null;
/** Which physical camera the current mediaStream is drawing from.
 *  Toggled by the flip button. 'user' = front / selfie, 'environment'
 *  = back / rear. The getUserMedia constraint uses `ideal:` so devices
 *  with only one camera (rare on modern phones) still return *a*
 *  camera instead of erroring. */
let currentFacing = 'user';
let mediaRecorder = null;
let recordedChunks = [];
let recMime = '';
let recStartedLocalMs = 0;
let recTimerInterval = null;
let currentProjectId = null;
let scanRaf = 0;
let scanStream = null;
// Live-preview WebRTC state. Phone is the OFFERER (has the camera).
let previewPc = null;
let previewActive = false;
// Connection-panel state
let attemptCount = 0;
let retryScheduled = null; // setTimeout handle
let autoRetry = true;
/** Last WS close code — surfaced in the Reconnect panel for debugging. */
let lastCloseCode = null;
let lastCloseReason = '';

function setStatus(text, kind) {
  statusTextEl.textContent = text;
  statusEl.classList.remove('connected', 'recording');
  if (kind) statusEl.classList.add(kind);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s % 60)}`;
}

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac', // iOS Safari
    'video/mp4',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** Read last known-good server URL from localStorage. */
function savedUrl() {
  return readWithLegacy(SAVED_URL_KEY, SAVED_URL_KEY_LEGACY);
}

function saveUrl(origin) {
  try {
    localStorage.setItem(SAVED_URL_KEY, origin);
  } catch {
    // Private mode or quota — ignore.
  }
}

/**
 * Read a localStorage value, falling back to legacy key names from earlier
 * product renames. On a legacy hit, copy the value forward to the new key
 * so the next read doesn't pay the fallback cost.
 */
function readWithLegacy(key, legacyKeys) {
  try {
    const v = localStorage.getItem(key);
    if (v && v.length > 0) return v;
    for (const legacy of legacyKeys) {
      const lv = localStorage.getItem(legacy);
      if (lv && lv.length > 0) {
        try { localStorage.setItem(key, lv); } catch {}
        return lv;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * If the PWA was loaded from a `<a-b-c-d>.local-ip.sh` hostname, derive the
 * equivalent raw-IP URL and persist it. Used by the failure panel so we can
 * tell the user "try this URL instead" when DNS appears to be blocked.
 * No-op for other hostnames — nothing to fall back to.
 */
function computeFallbackUrl() {
  const host = location.hostname || '';
  const m = host.match(/^(\d+)-(\d+)-(\d+)-(\d+)\.local-ip\.sh$/);
  if (!m) return null;
  const ip = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//${ip}${port}`;
}

function saveFallbackUrl() {
  const url = computeFallbackUrl();
  if (!url) return;
  try {
    localStorage.setItem(FALLBACK_URL_KEY, url);
  } catch {}
}

function fallbackUrl() {
  return readWithLegacy(FALLBACK_URL_KEY, FALLBACK_URL_KEY_LEGACY);
}

/**
 * Update the always-visible connection panel. Called on every state change
 * (starting to connect, retrying, connected, failed, stopped) — so the
 * user can always see what URL is being tried, how many attempts, and
 * has controls to stop/change.
 */
function renderConnectionPanel(state, reasonOverride) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  reconnectUrlLabelEl.textContent = url;

  // Build a short suffix exposing the last close reason — helpful when
  // debugging handshake failures (1006 ≈ abnormal/TLS, 1015 = TLS fail).
  const closeSuffix = lastCloseCode
    ? ` Last close: code ${lastCloseCode}${lastCloseReason ? ` (${lastCloseReason})` : ''}.`
    : '';

  reconnectEl.classList.remove('connecting', 'failed');
  switch (state) {
    case 'connecting':
      reconnectEl.classList.remove('hidden');
      reconnectEl.setAttribute('aria-hidden', 'false');
      reconnectEl.classList.add('connecting');
      reconnectTitleEl.textContent =
        attemptCount <= 1 ? 'Connecting…' : `Connecting… (attempt ${attemptCount})`;
      reconnectSubEl.textContent =
        (reasonOverride ||
          'Trying to reach the laptop. Make sure Threelane is open on the same WiFi.') +
        closeSuffix;
      reconnectStopBtn.textContent = 'Stop retrying';
      reconnectStopBtn.classList.remove('hidden');
      break;
    case 'connected':
      // Hide the panel; header's green dot + status text takes over.
      reconnectEl.classList.add('hidden');
      reconnectEl.setAttribute('aria-hidden', 'true');
      stopScan();
      scanWrap.classList.add('hidden');
      return;
    case 'failed': {
      reconnectEl.classList.remove('hidden');
      reconnectEl.setAttribute('aria-hidden', 'false');
      reconnectEl.classList.add('failed');
      reconnectTitleEl.textContent = "Can't reach the laptop";
      // If we're on a `*.local-ip.sh` URL and know a raw-IP equivalent, the
      // most likely failure mode is this network filtering public DNS for
      // LAN answers (Pi-hole rebinding protection, some enterprise WiFi).
      // Point the user straight at the fallback — they'll need the local CA
      // installed for it to work, but it's strictly better than a generic
      // "couldn't connect" message.
      const fb = fallbackUrl();
      const baseText =
        reasonOverride ||
        `Stopped after ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}.` +
          ' Retry, scan a new QR, or paste a URL.';
      const fbHint =
        fb && fb !== location.origin
          ? `\n\nIf your WiFi blocks LAN DNS, open this on the phone instead (needs the CA installed once):\n${fb}`
          : '';
      reconnectSubEl.textContent = baseText + fbHint;
      reconnectStopBtn.classList.add('hidden');
      break;
    }
    case 'stopped':
      reconnectEl.classList.remove('hidden');
      reconnectEl.setAttribute('aria-hidden', 'false');
      reconnectTitleEl.textContent = 'Not connected';
      reconnectSubEl.textContent =
        'Retries paused. Tap Retry, scan a new QR, or paste a URL.';
      reconnectStopBtn.classList.add('hidden');
      break;
  }

  // "Use last URL" is useful only when the saved URL points somewhere
  // different from the one we're currently trying.
  const saved = savedUrl();
  if (saved && saved !== location.origin) {
    reconnectSavedBtn.classList.remove('hidden');
    try {
      reconnectSavedBtn.textContent = `Use last URL (${new URL(saved).host})`;
    } catch {
      reconnectSavedBtn.textContent = 'Use last URL';
    }
  } else {
    reconnectSavedBtn.classList.add('hidden');
  }
}

function cancelRetry() {
  if (retryScheduled !== null) {
    clearTimeout(retryScheduled);
    retryScheduled = null;
  }
}

function scheduleRetry() {
  cancelRetry();
  if (!autoRetry) return;
  // Exponential backoff capped at RETRY_MAX_MS.
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * Math.pow(1.5, Math.min(attemptCount, 6)),
  );
  retryScheduled = setTimeout(() => {
    retryScheduled = null;
    connectWs();
  }, delay);
}

function connectWs() {
  cancelRetry();
  autoRetry = true;
  // Detach handlers on the old socket so its eventual `close` can't
  // schedule another retry while we're opening the new one.
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  attemptCount += 1;
  renderConnectionPanel('connecting');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setStatus('Disconnected');
    renderConnectionPanel('connecting', `WebSocket failed: ${e.message ?? e}`);
    scheduleRetry();
    return;
  }
  ws.addEventListener('open', () => {
    attemptCount = 0;
    lastCloseCode = null;
    lastCloseReason = '';
    setStatus('Connected', 'connected');
    saveUrl(location.origin);
    // Remember the raw-IP equivalent of this hostname so we can nudge the
    // user to it if a future reconnect fails due to DNS. Safe no-op when
    // the PWA was loaded from a non-local-ip.sh URL.
    saveFallbackUrl();
    renderConnectionPanel('connected');
    runClockSync().catch((e) => console.warn('clock sync failed', e));
  });
  ws.addEventListener('close', (event) => {
    lastCloseCode = event.code || null;
    lastCloseReason = event.reason || '';
    setStatus('Disconnected');
    // Any open peer connection is pointed at a laptop we've lost contact
    // with — close it so its ICE transport can give up immediately.
    closePreview();
    previewActive = false;
    if (autoRetry) {
      renderConnectionPanel('connecting');
      scheduleRetry();
    } else {
      renderConnectionPanel('stopped');
    }
  });
  ws.addEventListener('error', (e) => {
    console.warn('WS error', e);
  });
  ws.addEventListener('message', (ev) => handleMessage(ev.data));
}

function sendWs(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function showMsg(text) {
  msgEl.textContent = text;
  msgEl.classList.remove('hidden');
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'hello':
      deviceId = msg.id;
      break;
    case 'start':
      handleStart(msg).catch((e) => {
        showMsg(`Start failed: ${e.message ?? e}`);
      });
      break;
    case 'stop':
      handleStop().catch((e) => {
        showMsg(`Stop failed: ${e.message ?? e}`);
      });
      break;
    case 'pong':
      // handled inside runClockSync's listener
      break;
    case 'preview-request':
      // Laptop wants (or no longer wants) a live feed. We handle this
      // lazily — the camera stream may not exist yet if the user hasn't
      // tapped "Grant". In that case we just flip the intent flag and
      // start the peer connection when the stream is ready.
      handlePreviewRequest(!!msg.enable).catch((e) =>
        console.warn('preview request failed', e),
      );
      break;
    case 'rtc-signal':
      handleRtcSignal(msg.payload).catch((e) =>
        console.warn('rtc signal failed', e),
      );
      break;
  }
}

// ---------- WebRTC live preview (phone as offerer) ----------

async function handlePreviewRequest(enable) {
  previewActive = enable;
  if (!enable) {
    closePreview();
    return;
  }
  if (!mediaStream) {
    // Will start when the user grants media. requestMedia() re-checks
    // previewActive after getUserMedia succeeds.
    return;
  }
  await startPreview();
}

async function startPreview() {
  if (previewPc) return; // already running
  // LAN-only. No STUN/TURN needed — host candidates on the same WiFi
  // resolve directly. Keeping iceServers empty also means no external
  // request leaves the network, matching Threelane's "local-first" stance.
  const pc = new RTCPeerConnection({ iceServers: [] });
  previewPc = pc;

  // Only send the video track. Audio during preview would let the laptop
  // hear its own mic back through the phone's speaker — bad feedback loop.
  const [videoTrack] = mediaStream.getVideoTracks();
  if (videoTrack) pc.addTrack(videoTrack, mediaStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWs({
        type: 'rtc-signal',
        payload: { kind: 'candidate', candidate: e.candidate.toJSON() },
      });
    }
  };
  pc.onconnectionstatechange = () => {
    if (!previewPc) return;
    const s = pc.connectionState;
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      closePreview();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWs({
    type: 'rtc-signal',
    payload: { kind: 'offer', sdp: offer.sdp, sdpType: offer.type },
  });
}

async function handleRtcSignal(payload) {
  if (!payload || typeof payload !== 'object') return;
  const pc = previewPc;
  if (!pc) return;
  if (payload.kind === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
  } else if (payload.kind === 'candidate' && payload.candidate) {
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch (e) {
      console.warn('addIceCandidate failed', e);
    }
  } else if (payload.kind === 'close') {
    closePreview();
  }
}

function closePreview() {
  if (previewPc) {
    try {
      previewPc.close();
    } catch {}
    previewPc = null;
  }
}

/**
 * Measure clock offset via a small burst of ping/pong round trips. We take
 * the median over a few rounds because any single round can be skewed by
 * WiFi latency spikes.
 */
async function runClockSync() {
  const ROUNDS = 5;
  const offsets = [];
  for (let i = 0; i < ROUNDS; i++) {
    const offset = await singlePingRound();
    if (Number.isFinite(offset)) offsets.push(offset);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (offsets.length === 0) return;
  offsets.sort((a, b) => a - b);
  clockOffsetMs = offsets[Math.floor(offsets.length / 2)];
  sendWs({ type: 'offset', clockOffsetMs });
}

function singlePingRound() {
  return new Promise((resolve) => {
    const clientTime = Date.now();
    const onMsg = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type !== 'pong' || m.clientTime !== clientTime) return;
      ws.removeEventListener('message', onMsg);
      const now = Date.now();
      const rtt = now - clientTime;
      // Best guess: server's clock at the midpoint of the round-trip.
      const offset = m.serverTime - (clientTime + rtt / 2);
      resolve(offset);
    };
    ws.addEventListener('message', onMsg);
    sendWs({ type: 'ping', clientTime });
    setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      resolve(NaN);
    }, 2000);
  });
}

/**
 * Ask the browser for a camera+mic stream pointed at the chosen facing
 * direction. Factored out so both the initial grant and the flip-camera
 * button share identical constraints — only `facingMode` changes. Uses
 * `ideal:` rather than `exact:` so phones with only one physical camera
 * still hand us something back.
 */
async function acquireStream(facing) {
  return await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: true,
  });
}

async function requestMedia() {
  grantBtn.disabled = true;
  msgEl.textContent = 'Requesting camera & microphone…';
  try {
    mediaStream = await acquireStream(currentFacing);
    previewEl.srcObject = mediaStream;
    grantBtn.classList.add('hidden');
    msgEl.classList.add('hidden');
    hintEl.classList.remove('hidden');
    // Flip button only makes sense once we actually have a feed to flip.
    flipBtn.classList.remove('hidden');
    setStatus('Ready', 'connected');
    sendWs({ type: 'ready' });
    // Laptop may have requested the live feed before the user granted
    // permissions — kick it off now that we have a stream.
    if (previewActive) {
      startPreview().catch((e) => console.warn('startPreview failed', e));
    }
  } catch (e) {
    grantBtn.disabled = false;
    msgEl.textContent =
      'Permission denied. Allow camera and microphone in Safari/Chrome settings.';
  }
}

/**
 * Swap the active camera between front ('user') and back ('environment').
 * Re-acquires a fresh MediaStream for the new facing direction and plugs
 * it into (a) the on-phone <video> preview, and (b) any live WebRTC
 * preview sender feeding the laptop — in the latter case using
 * `RTCRtpSender.replaceTrack` so the peer connection stays up without
 * renegotiation.
 *
 * Disabled while recording: MediaRecorder was constructed around the
 * original track set and can't pick up a swapped track mid-clip without
 * producing a corrupt output.
 */
async function flipCamera() {
  if (!mediaStream) return;
  if (mediaRecorder) {
    showMsg("Can't flip while recording — stop first.");
    return;
  }
  const target = currentFacing === 'user' ? 'environment' : 'user';
  flipBtn.disabled = true;
  let next;
  try {
    next = await acquireStream(target);
  } catch (e) {
    // Phone doesn't have the other camera, or user revoked permission —
    // keep the existing stream running and surface the error briefly.
    flipBtn.disabled = false;
    showMsg(`Couldn't switch camera: ${e.message ?? e}`);
    return;
  }
  // Stop old tracks before assigning — otherwise both cameras stay
  // open on some Android devices and the indicator light lingers.
  try {
    mediaStream.getTracks().forEach((t) => t.stop());
  } catch {}
  mediaStream = next;
  currentFacing = target;
  previewEl.srcObject = mediaStream;

  // If the laptop is currently watching a live feed, swap the outgoing
  // track in place. replaceTrack doesn't renegotiate the session — the
  // laptop's <video> just starts showing the new camera on its next
  // frame.
  if (previewPc) {
    const [newVideo] = mediaStream.getVideoTracks();
    const sender = previewPc
      .getSenders()
      .find((s) => s.track && s.track.kind === 'video');
    if (sender && newVideo) {
      try {
        await sender.replaceTrack(newVideo);
      } catch (e) {
        console.warn('replaceTrack failed', e);
      }
    }
  }
  flipBtn.disabled = false;
}

async function handleStart(msg) {
  if (!mediaStream) {
    // Camera not granted yet — can't record. Make sure the user sees why.
    showMsg('Grant camera & mic first, then ask the laptop to record again.');
    return;
  }
  currentProjectId = msg.projectId;
  const mime = pickMime();
  recMime = mime;
  recordedChunks = [];
  const opts = mime ? { mimeType: mime } : undefined;
  mediaRecorder = new MediaRecorder(mediaStream, opts);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  // startAtMs is in the LAPTOP's clock. Subtract our offset to get the
  // local wall-clock we should fire at.
  const serverStartAt = typeof msg.startAtMs === 'number' ? msg.startAtMs : Date.now();
  const localStartAt = serverStartAt - clockOffsetMs;
  const delay = Math.max(0, localStartAt - Date.now());
  await new Promise((r) => setTimeout(r, delay));
  mediaRecorder.start(1000);
  recStartedLocalMs = Date.now();
  recTimer.textContent = '00:00';
  recPill.classList.remove('hidden');
  // Lock the flip button while recording — MediaRecorder is welded to
  // the original track set. Re-enabled in handleStop.
  flipBtn.disabled = true;
  setStatus('Recording', 'recording');
  sendWs({ type: 'recording-started' });
  recTimerInterval = setInterval(() => {
    recTimer.textContent = fmtElapsed(Date.now() - recStartedLocalMs);
  }, 250);
}

async function handleStop() {
  if (!mediaRecorder) return;
  const rec = mediaRecorder;
  mediaRecorder = null;
  clearInterval(recTimerInterval);
  recTimerInterval = null;

  await new Promise((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  recPill.classList.add('hidden');
  // Recording done — re-enable camera flip.
  flipBtn.disabled = false;
  setStatus('Uploading', 'connected');

  const blob = new Blob(recordedChunks, { type: recMime || 'video/webm' });
  recordedChunks = [];
  const durationMs = Date.now() - recStartedLocalMs;
  uploadRow.classList.remove('hidden');
  uploadLabel.textContent = 'Uploading 0%';
  progressBar.style.width = '0%';
  try {
    await uploadBlob(blob, durationMs);
    uploadLabel.textContent = 'Uploaded ✓';
    setStatus('Done', 'connected');
  } catch (e) {
    uploadLabel.textContent = `Upload failed: ${e.message ?? e}`;
    setStatus('Upload failed');
  }
}

function uploadBlob(blob, durationMs) {
  return new Promise((resolve, reject) => {
    if (!currentProjectId || !deviceId) {
      reject(new Error('missing project or device id'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload/${encodeURIComponent(currentProjectId)}/${encodeURIComponent(deviceId)}`);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Duration-Ms', String(durationMs));
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        progressBar.style.width = pct + '%';
        uploadLabel.textContent = `Uploading ${pct}%`;
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(blob);
  });
}

grantBtn.addEventListener('click', () => {
  requestMedia();
});

flipBtn.addEventListener('click', () => {
  flipCamera().catch((e) => console.warn('flipCamera failed', e));
});

// ---------- Reconnect UI wiring ----------

reconnectRetryBtn.addEventListener('click', () => {
  cancelRetry();
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  // Reset attempt count when the user explicitly retries — it's a fresh try.
  attemptCount = 0;
  connectWs();
});

reconnectStopBtn.addEventListener('click', () => {
  autoRetry = false;
  cancelRetry();
  if (ws && ws.readyState !== 3) {
    try {
      ws.close();
    } catch {}
  }
  renderConnectionPanel('stopped');
});

reconnectSavedBtn.addEventListener('click', () => {
  const saved = savedUrl();
  if (saved) navigateToServer(saved);
});

reconnectScanBtn.addEventListener('click', () => {
  startScan().catch((e) => {
    reconnectSubEl.textContent = `Couldn't open camera: ${e.message ?? e}`;
  });
});

reconnectForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = reconnectUrlInput.value.trim();
  if (!raw) return;
  try {
    const u = new URL(raw);
    navigateToServer(u.origin);
  } catch {
    reconnectSubEl.textContent = 'That doesn\'t look like a valid URL.';
  }
});

scanCancelBtn.addEventListener('click', () => {
  stopScan();
  scanWrap.classList.add('hidden');
});

/**
 * Navigate the whole page (not just a WS reconnect) to a new server origin.
 * Saves the URL first so the PWA boots at it next time, then does a full
 * load — needed because the PWA's HTTPS cert trust + origin is set by the
 * page's URL, and cross-origin WSS to a different self-signed cert won't
 * work on iOS Safari without trusting that cert too.
 */
function navigateToServer(origin) {
  saveUrl(origin);
  window.location.href = origin;
}

async function startScan() {
  if (typeof jsQR === 'undefined') {
    reconnectSubEl.textContent = 'QR decoder failed to load. Paste the URL instead.';
    return;
  }
  scanWrap.classList.remove('hidden');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  scanStream = stream;
  scanVideo.srcObject = stream;
  await scanVideo.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = () => {
    if (!scanStream) return;
    if (scanVideo.readyState >= 2 && scanVideo.videoWidth > 0) {
      canvas.width = scanVideo.videoWidth;
      canvas.height = scanVideo.videoHeight;
      ctx.drawImage(scanVideo, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        try {
          const u = new URL(code.data);
          stopScan();
          navigateToServer(u.origin);
          return;
        } catch {
          // Not a URL — keep scanning.
        }
      }
    }
    scanRaf = requestAnimationFrame(tick);
  };
  scanRaf = requestAnimationFrame(tick);
}

function stopScan() {
  cancelAnimationFrame(scanRaf);
  scanRaf = 0;
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  scanVideo.srcObject = null;
}

// ---------- Service worker + bootstrap ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/service-worker.js')
    .catch((e) => console.warn('SW registration failed', e));
}

// Start connecting immediately. The connection panel is visible from the
// first paint so the user sees the URL + attempt count even if the WS
// handshake is slow. If the saved URL is stale, the user can tap Scan QR
// or paste a new URL from the panel.
renderConnectionPanel('connecting');
connectWs();
