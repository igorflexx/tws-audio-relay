const state = {
  mode: null,
  meta: null,
  roomId: null,
  peerId: null,
  eventSource: null,
  knownPeers: new Map(),
  localStream: null,
  listenerPc: null,
  hostConnections: new Map(),
  remoteStream: new MediaStream(),
  pendingCandidates: [],
  hostId: null,
  shareUrl: null
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const elements = {
  activateAudioButton: document.querySelector("#activateAudioButton"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  eventLog: document.querySelector("#eventLog"),
  hostBadge: document.querySelector("#hostBadge"),
  hostModeButton: document.querySelector("#hostModeButton"),
  hostSection: document.querySelector("#hostSection"),
  listenerBadge: document.querySelector("#listenerBadge"),
  listenerModeButton: document.querySelector("#listenerModeButton"),
  listenerSection: document.querySelector("#listenerSection"),
  newRoomButton: document.querySelector("#newRoomButton"),
  qrImage: document.querySelector("#qrImage"),
  refreshQrButton: document.querySelector("#refreshQrButton"),
  remoteAudio: document.querySelector("#remoteAudio"),
  roomInput: document.querySelector("#roomInput"),
  shareLink: document.querySelector("#shareLink"),
  shareMicButton: document.querySelector("#shareMicButton"),
  shareScreenAudioButton: document.querySelector("#shareScreenAudioButton"),
  statusText: document.querySelector("#statusText"),
  stopBroadcastButton: document.querySelector("#stopBroadcastButton")
};

elements.remoteAudio.srcObject = state.remoteStream;

function generatePeerId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return template.replace(/[xy]/g, char => {
    const randomValue = Math.random() * 16 | 0;
    const value = char === "x" ? randomValue : (randomValue & 0x3 | 0x8);
    return value.toString(16);
  });
}

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function setStatus(text) {
  elements.statusText.textContent = text;
}

function setBadge(element, text) {
  element.textContent = text;
}

function rememberPeer(peer) {
  if (!peer || !peer.peerId) {
    return;
  }
  state.knownPeers.set(peer.peerId, peer.role);
}

function forgetPeer(peerId) {
  state.knownPeers.delete(peerId);
}

function logEvent(text) {
  const item = document.createElement("li");
  item.textContent = text;
  elements.eventLog.prepend(item);

  while (elements.eventLog.children.length > 8) {
    elements.eventLog.removeChild(elements.eventLog.lastChild);
  }
}

function sanitizeRoomInput(value) {
  return value.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase();
}

function currentUrlRole() {
  const params = new URLSearchParams(window.location.search);
  return params.get("role");
}

function updateModeButtons() {
  elements.hostModeButton.classList.toggle("secondary", state.mode !== "host");
  elements.listenerModeButton.classList.toggle("secondary", state.mode !== "listener");
}

async function fetchMeta() {
  const response = await fetch("/api/meta", { cache: "no-store" });
  state.meta = await response.json();
}

function buildShareUrl() {
  const baseOrigin = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? state.meta.networkOrigin
    : window.location.origin;

  return `${baseOrigin}/listener.html?room=${encodeURIComponent(state.roomId)}`;
}

async function refreshShareUi() {
  state.shareUrl = buildShareUrl();
  elements.shareLink.value = state.shareUrl;
  elements.qrImage.src = `/api/qr?text=${encodeURIComponent(state.shareUrl)}&ts=${Date.now()}`;
}

function updateUrlForMode() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  url.searchParams.set("role", state.mode);
  window.history.replaceState({}, "", url);
}

async function postSignal(to, signal) {
  await fetch("/api/signal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      roomId: state.roomId,
      from: state.peerId,
      to,
      signal
    })
  });
}

function ensureEventSource() {
  if (state.eventSource) {
    return;
  }

  const query = new URLSearchParams({
    room: state.roomId,
    peer: state.peerId,
    role: state.mode
  });

  const source = new EventSource(`/api/events?${query.toString()}`);
  state.eventSource = source;

  source.addEventListener("ready", event => {
    const payload = JSON.parse(event.data);
    state.hostId = payload.hostId;
    state.knownPeers.clear();
    for (const peer of payload.peers) {
      if (peer.peerId !== state.peerId) {
        rememberPeer(peer);
      }
    }
    setStatus(`Комната ${payload.roomId} готова. Роль: ${payload.role}.`);
    logEvent(`Подключение к комнате ${payload.roomId} установлено.`);

    if (state.mode === "host") {
      setBadge(elements.hostBadge, "Готово");
      refreshShareUi();
      if (state.localStream) {
        void connectToKnownListeners();
      }
    } else {
      setBadge(elements.listenerBadge, payload.hostId ? "Ждем поток" : "Ждем компьютер");
    }
  });

  source.addEventListener("peer-joined", async event => {
    const payload = JSON.parse(event.data);
    rememberPeer(payload);
    logEvent(`Подключился ${payload.role === "listener" ? "iPhone" : "компьютер"}.`);

    if (payload.role === "host") {
      state.hostId = payload.peerId;
      if (state.mode === "listener") {
        setBadge(elements.listenerBadge, "Компьютер онлайн");
      }
    }

    if (state.mode === "host" && payload.role === "listener") {
      setBadge(elements.hostBadge, "iPhone онлайн");
      if (state.localStream) {
        await connectHostToListener(payload.peerId);
      } else {
        setStatus("iPhone подключился. Теперь запусти захват звука на компьютере.");
      }
    }
  });

  source.addEventListener("peer-left", event => {
    const payload = JSON.parse(event.data);
    forgetPeer(payload.peerId);
    logEvent(`Отключился ${payload.role === "listener" ? "iPhone" : "компьютер"}.`);

    if (state.mode === "host" && payload.role === "listener") {
      const pc = state.hostConnections.get(payload.peerId);
      if (pc) {
        pc.close();
        state.hostConnections.delete(payload.peerId);
      }
      setBadge(elements.hostBadge, "Ожидание");
    }

    if (state.mode === "listener" && payload.role === "host") {
      state.hostId = null;
      setBadge(elements.listenerBadge, "Компьютер ушел");
      setStatus("Источник отключился. Оставь страницу открытой или переподключись по новой ссылке.");
    }
  });

  source.addEventListener("signal", async event => {
    const payload = JSON.parse(event.data);
    await handleSignal(payload.from, payload.signal);
  });

  source.addEventListener("server-info", event => {
    const payload = JSON.parse(event.data);
    if (payload.type === "host-replaced") {
      setStatus("Другой компьютер занял роль источника в этой комнате.");
      logEvent("Роль источника была заменена.");
    }
  });

  source.onerror = () => {
    setStatus("Сигнальный канал прервался. Перезагрузи страницу, если соединение не восстановится.");
  };
}

async function connectHostToListener(listenerPeerId) {
  if (!state.localStream) {
    return;
  }

  let pc = state.hostConnections.get(listenerPeerId);
  if (pc) {
    return;
  }

  pc = new RTCPeerConnection(rtcConfig);
  state.hostConnections.set(listenerPeerId, pc);

  for (const track of state.localStream.getAudioTracks()) {
    pc.addTrack(track, state.localStream);
  }

  pc.onicecandidate = async event => {
    if (event.candidate) {
      await postSignal(listenerPeerId, {
        type: "ice",
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    const status = pc.connectionState;
    setBadge(elements.hostBadge, status === "connected" ? "Поток идет" : "Соединение");
    logEvent(`Состояние потока: ${status}.`);

    if (status === "failed" || status === "disconnected" || status === "closed") {
      state.hostConnections.delete(listenerPeerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await postSignal(listenerPeerId, {
    type: "description",
    description: pc.localDescription
  });

  setStatus("Предложение на подключение отправлено на iPhone.");
}

async function connectToKnownListeners() {
  const listeners = [...state.knownPeers.entries()]
    .filter(([, role]) => role === "listener")
    .map(([peerId]) => peerId);

  for (const peerId of listeners) {
    await connectHostToListener(peerId);
  }
}

function ensureListenerPeer() {
  if (state.listenerPc) {
    return state.listenerPc;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  state.listenerPc = pc;

  // Safari behaves more reliably when the receive intent is explicit
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.onicecandidate = async event => {
    if (event.candidate && state.hostId) {
      await postSignal(state.hostId, {
        type: "ice",
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = event => {
    for (const track of event.streams[0].getTracks()) {
      state.remoteStream.addTrack(track);
    }
    setBadge(elements.listenerBadge, "Поток пришел");
    setStatus("Аудиопоток получен. Если тишина, нажми кнопку воспроизведения на плеере.");
    logEvent("Аудиодорожка пришла на iPhone.");
  };

  pc.onconnectionstatechange = () => {
    const status = pc.connectionState;
    setBadge(elements.listenerBadge, status === "connected" ? "Слушаем" : "Подключение");
    logEvent(`Состояние приема: ${status}.`);

    if (status === "failed") {
      setStatus("Соединение не собралось. Попробуй обновить страницу на iPhone и заново нажать подключение.");
    }
  };

  return pc;
}

async function handleSignal(from, signal) {
  if (state.mode === "host") {
    const pc = state.hostConnections.get(from);
    if (!pc) {
      return;
    }

    if (signal.type === "description" && signal.description) {
      await pc.setRemoteDescription(signal.description);
      setStatus("iPhone подтвердил соединение.");
    }

    if (signal.type === "ice" && signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (error) {
        logEvent("Не удалось добавить ICE-кандидата на стороне источника.");
      }
    }
    return;
  }

  state.hostId = from;
  const pc = ensureListenerPeer();

  if (signal.type === "description" && signal.description && signal.description.type === "offer") {
    await pc.setRemoteDescription(signal.description);

    for (const candidate of state.pendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await postSignal(from, {
      type: "description",
      description: pc.localDescription
    });

    setStatus("iPhone принял предложение и отправил ответ.");
  } else if (signal.type === "ice" && signal.candidate) {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(signal.candidate);
    } else {
      state.pendingCandidates.push(signal.candidate);
    }
  }
}

async function startDisplayAudio() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setStatus("Браузер не отдал аудиодорожку. Попробуй выбрать вкладку Chrome/Edge и включить звук при шаринге.");
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    // Видеодорожка нужна только для разрешения браузера на захват аудио.
    for (const videoTrack of stream.getVideoTracks()) {
      videoTrack.stop();
    }

    await replaceLocalStream(stream, "Захват звука из вкладки или системы включен.");
  } catch (error) {
    setStatus("Захват был отменен или запрещен браузером.");
  }
}

async function startMicrophoneAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    await replaceLocalStream(stream, "Трансляция с микрофона включена.");
  } catch (error) {
    setStatus("Не удалось получить доступ к микрофону.");
  }
}

async function replaceLocalStream(stream, successText) {
  stopLocalStream();
  state.localStream = stream;

  const [track] = stream.getAudioTracks();
  if (track) {
    track.onended = () => {
      setStatus("Захват звука остановлен на стороне компьютера.");
      stopLocalStream();
    };
  }

  setBadge(elements.hostBadge, "Источник активен");
  setStatus(successText);
  logEvent(successText);

  for (const [peerId, pc] of state.hostConnections) {
    pc.close();
    state.hostConnections.delete(peerId);
  }
  await connectToKnownListeners();
  logEvent("Поток готов. Жду или переподключаю iPhone.");
}

function stopLocalStream() {
  if (!state.localStream) {
    return;
  }

  for (const track of state.localStream.getTracks()) {
    track.stop();
  }
  state.localStream = null;
  setBadge(elements.hostBadge, "Ожидание");
}

async function activateListenerAudio() {
  try {
    await elements.remoteAudio.play();
    setStatus("Плеер на iPhone активирован. Ждем входящий поток.");
  } catch (error) {
    setStatus("Safari не запустил плеер автоматически. Попробуй еще раз после прихода потока.");
  }
}

function toggleSections() {
  elements.hostSection.classList.toggle("hidden", state.mode !== "host");
  elements.listenerSection.classList.toggle("hidden", state.mode !== "listener");
}

function closeConnections() {
  stopLocalStream();

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  if (state.listenerPc) {
    state.listenerPc.close();
    state.listenerPc = null;
  }

  for (const pc of state.hostConnections.values()) {
    pc.close();
  }
  state.hostConnections.clear();
  state.knownPeers.clear();
  state.pendingCandidates = [];
}

async function switchMode(mode) {
  closeConnections();
  state.mode = mode;
  updateModeButtons();
  toggleSections();
  updateUrlForMode();

  if (mode === "host") {
    setBadge(elements.hostBadge, "Ожидание");
    await refreshShareUi();
  } else {
    setBadge(elements.listenerBadge, "Подключение");
  }

  ensureEventSource();
}

async function initialize() {
  state.peerId = generatePeerId();
  await fetchMeta();

  const params = new URLSearchParams(window.location.search);
  state.roomId = sanitizeRoomInput(params.get("room") || generateRoomId());
  elements.roomInput.value = state.roomId;

  const requestedRole = currentUrlRole();
  const initialMode = requestedRole === "listener" ? "listener" : "host";
  await switchMode(initialMode);

  if (initialMode === "host") {
    await refreshShareUi();
  } else {
    setStatus("Открой эту же комнату на компьютере и запусти источник.");
  }
}

elements.hostModeButton.addEventListener("click", async () => {
  await switchMode("host");
});

elements.listenerModeButton.addEventListener("click", async () => {
  await switchMode("listener");
});

elements.roomInput.addEventListener("input", event => {
  const nextValue = sanitizeRoomInput(event.target.value);
  event.target.value = nextValue;
  state.roomId = nextValue || generateRoomId();
});

elements.roomInput.addEventListener("change", async () => {
  state.roomId = sanitizeRoomInput(elements.roomInput.value) || generateRoomId();
  elements.roomInput.value = state.roomId;
  await switchMode(state.mode);
});

elements.newRoomButton.addEventListener("click", async () => {
  state.roomId = generateRoomId();
  elements.roomInput.value = state.roomId;
  await switchMode(state.mode || "host");
});

elements.copyLinkButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.shareUrl || "");
  setStatus("Ссылка для iPhone скопирована.");
});

elements.refreshQrButton.addEventListener("click", async () => {
  await refreshShareUi();
  setStatus("QR-код обновлен.");
});

elements.shareScreenAudioButton.addEventListener("click", async () => {
  await startDisplayAudio();
});

elements.shareMicButton.addEventListener("click", async () => {
  await startMicrophoneAudio();
});

elements.stopBroadcastButton.addEventListener("click", () => {
  stopLocalStream();
  setStatus("Трансляция остановлена.");
});

elements.activateAudioButton.addEventListener("click", async () => {
  await activateListenerAudio();
});

initialize().catch(() => {
  setStatus("Не удалось инициализировать приложение. Перезагрузи страницу.");
});

window.addEventListener("error", event => {
  const message = (event.error && event.error.message) || event.message || "Неизвестная ошибка JavaScript";
  setStatus(`Ошибка в браузере: ${message}`);
});
