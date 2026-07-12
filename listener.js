(function () {
  var audio = document.getElementById("remoteAudio");
  var activateAudioButton = document.getElementById("activateAudioButton");
  var reloadButton = document.getElementById("reloadButton");
  var listenerBadge = document.getElementById("listenerBadge");
  var roomLabel = document.getElementById("roomLabel");
  var statusText = document.getElementById("statusText");
  var eventLog = document.getElementById("eventLog");

  var state = {
    roomId: "",
    peerId: generatePeerId(),
    hostId: null,
    eventSource: null,
    pc: null,
    pendingCandidates: []
  };
  var PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  var SessionDescription = window.RTCSessionDescription || function (value) { return value; };
  var IceCandidate = window.RTCIceCandidate || function (value) { return value; };

  function setStatus(text) {
    statusText.textContent = text;
  }

  function setBadge(text) {
    listenerBadge.textContent = text;
  }

  function logEvent(text) {
    var item = document.createElement("li");
    item.textContent = text;
    eventLog.insertBefore(item, eventLog.firstChild);

    while (eventLog.children.length > 8) {
      eventLog.removeChild(eventLog.lastChild);
    }
  }

  function generatePeerId() {
    var template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    return template.replace(/[xy]/g, function (char) {
      var randomValue = Math.floor(Math.random() * 16);
      var value = char === "x" ? randomValue : ((randomValue & 0x3) | 0x8);
      return value.toString(16);
    });
  }

  function parseRoomId() {
    var query = window.location.search.replace(/^\?/, "");
    var parts = query ? query.split("&") : [];
    var roomValue = "";
    var index;

    for (index = 0; index < parts.length; index += 1) {
      var pair = parts[index].split("=");
      if (decodeURIComponent(pair[0] || "") === "room") {
        roomValue = decodeURIComponent((pair[1] || "").replace(/\+/g, "%20"));
        break;
      }
    }

    return roomValue.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase();
  }

  function postJson(url, payload, onDone) {
    var request = new XMLHttpRequest();
    request.open("POST", url, true);
    request.setRequestHeader("Content-Type", "application/json");
    request.onreadystatechange = function () {
      if (request.readyState !== 4) {
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        onDone(null, request.responseText);
        return;
      }
      onDone(new Error("HTTP " + request.status));
    };
    request.onerror = function () {
      onDone(new Error("Network error"));
    };
    request.send(JSON.stringify(payload));
  }

  function sendSignal(signal, onDone) {
    if (!state.hostId) {
      if (onDone) {
        onDone(new Error("No host connected"));
      }
      return;
    }

    postJson("/api/signal", {
      roomId: state.roomId,
      from: state.peerId,
      to: state.hostId,
      signal: signal
    }, function (error) {
      if (onDone) {
        onDone(error);
      }
    });
  }

  function ensurePeerConnection() {
    if (state.pc) {
      return state.pc;
    }

    var pc = new PeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    });

    state.pc = pc;

    pc.onicecandidate = function (event) {
      if (!event.candidate || !state.hostId) {
        return;
      }

      sendSignal({
        type: "ice",
        candidate: event.candidate
      });
    };

    pc.ontrack = function (event) {
      if (event.streams && event.streams[0]) {
        audio.srcObject = event.streams[0];
      }
      setBadge("Поток пришел");
      setStatus("Аудиопоток получен. Нажми воспроизведение, если Safari не включил звук сам.");
      logEvent("Поток пришел с компьютера.");
    };

    pc.onconnectionstatechange = function () {
      var connectionState = pc.connectionState || "";
      if (connectionState === "connected") {
        setBadge("Слушаем");
        setStatus("Соединение установлено.");
      } else if (connectionState === "failed") {
        setBadge("Ошибка");
        setStatus("Соединение не собралось. Обнови страницу на iPhone и запусти заново.");
      } else if (connectionState) {
        setBadge("Подключение");
        logEvent("Состояние приема: " + connectionState + ".");
      }
    };

    return pc;
  }

  function closePeerConnection() {
    if (!state.pc) {
      return;
    }

    try {
      state.pc.close();
    } catch (error) {
      // ignore
    }

    state.pc = null;
    state.pendingCandidates = [];
  }

  function handleOffer(fromPeerId, description) {
    var pc = ensurePeerConnection();
    state.hostId = fromPeerId;

    pc.setRemoteDescription(new SessionDescription(description))
      .then(function () {
        var chain = Promise.resolve();
        var queuedCandidates = state.pendingCandidates.splice(0);

        queuedCandidates.forEach(function (candidate) {
          chain = chain.then(function () {
            return pc.addIceCandidate(new IceCandidate(candidate));
          });
        });

        return chain;
      })
      .then(function () {
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer);
      })
      .then(function () {
        sendSignal({
          type: "description",
          description: pc.localDescription
        }, function (error) {
          if (error) {
            setStatus("Не удалось отправить ответ компьютеру.");
            return;
          }
          setStatus("Ответ отправлен компьютеру. Ждем поток.");
          setBadge("Ждем поток");
          logEvent("Ответ на подключение отправлен.");
        });
      })
      .catch(function (error) {
        setBadge("Ошибка");
        setStatus("Safari не смог принять поток: " + error.message);
      });
  }

  function handleIceCandidate(candidate) {
    var pc = ensurePeerConnection();

    if (pc.remoteDescription && pc.remoteDescription.type) {
      pc.addIceCandidate(new IceCandidate(candidate)).catch(function () {
        logEvent("Не удалось добавить сетевой кандидат.");
      });
      return;
    }

    state.pendingCandidates.push(candidate);
  }

  function handleSignal(payload) {
    if (!payload || !payload.signal) {
      return;
    }

    state.hostId = payload.from;

    if (
      payload.signal.type === "description" &&
      payload.signal.description &&
      payload.signal.description.type === "offer"
    ) {
      handleOffer(payload.from, payload.signal.description);
      return;
    }

    if (payload.signal.type === "ice" && payload.signal.candidate) {
      handleIceCandidate(payload.signal.candidate);
    }
  }

  function connectEvents() {
    if (state.eventSource) {
      state.eventSource.close();
    }

    closePeerConnection();
    state.peerId = generatePeerId();
    state.hostId = null;

    var query = "?room=" + encodeURIComponent(state.roomId) +
      "&peer=" + encodeURIComponent(state.peerId) +
      "&role=listener";

    var source = new EventSource("/api/events" + query);
    state.eventSource = source;

    source.addEventListener("ready", function (event) {
      var payload = JSON.parse(event.data);
      state.hostId = payload.hostId || null;
      setBadge(payload.hostId ? "Ждем поток" : "Ждем компьютер");
      setStatus("iPhone подключен к комнате " + payload.roomId + ".");
      logEvent("Сигнальный канал подключен.");
    });

    source.addEventListener("peer-joined", function (event) {
      var payload = JSON.parse(event.data);
      if (payload.role === "host") {
        state.hostId = payload.peerId;
        setBadge("Компьютер онлайн");
        setStatus("Компьютер появился в комнате. Ждем аудиопоток.");
        logEvent("Компьютер подключился.");
      }
    });

    source.addEventListener("peer-left", function (event) {
      var payload = JSON.parse(event.data);
      if (payload.role === "host") {
        state.hostId = null;
        closePeerConnection();
        setBadge("Компьютер ушел");
        setStatus("Источник отключился. Оставь страницу открытой или обнови подключение.");
        logEvent("Компьютер отключился.");
      }
    });

    source.addEventListener("signal", function (event) {
      var payload = JSON.parse(event.data);
      handleSignal(payload);
    });

    source.onerror = function () {
      setBadge("Повтор");
      setStatus("Связь с комнатой прервалась. Нажми обновить подключение.");
    };
  }

  activateAudioButton.addEventListener("click", function () {
    var playResult = audio.play();

    if (!playResult || typeof playResult.then !== "function") {
      setStatus("Плеер активирован. Ждем поток.");
      return;
    }

    playResult.then(function () {
      setStatus("Плеер активирован. Ждем поток.");
    }).catch(function () {
      setStatus("Safari не включил звук. Нажми стандартную кнопку play на плеере ниже.");
    });
  });

  reloadButton.addEventListener("click", function () {
    setStatus("Переподключаем iPhone к комнате…");
    connectEvents();
  });

  window.addEventListener("error", function (event) {
    var message = (event.error && event.error.message) || event.message || "Неизвестная ошибка";
    setBadge("Ошибка");
    setStatus("Ошибка в браузере: " + message);
  });

  state.roomId = parseRoomId();
  roomLabel.value = state.roomId || "НЕТ КОДА";

  if (!state.roomId) {
    setBadge("Нет комнаты");
    setStatus("В ссылке нет кода комнаты. Открой ссылку с компьютера заново.");
    return;
  }

  if (!PeerConnection) {
    setBadge("Нет WebRTC");
    setStatus("На этом iPhone браузер не поддерживает WebRTC. Нужен Safari или более новая iOS.");
    return;
  }

  setStatus("Подключаем iPhone к комнате " + state.roomId + "…");
  connectEvents();
})();
