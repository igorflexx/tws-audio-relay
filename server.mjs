import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const bindHost = "0.0.0.0";
const port = Number(process.env.PORT || 4312);
const rooms = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function pickLocalIp() {
  const nets = os.networkInterfaces();
  const preferredPrefixes = ["192.168.", "10.", "172."];

  for (const prefix of preferredPrefixes) {
    for (const entries of Object.values(nets)) {
      for (const entry of entries || []) {
        if (
          entry.family === "IPv4" &&
          !entry.internal &&
          entry.address.startsWith(prefix)
        ) {
          return entry.address;
        }
      }
    }
  }

  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "127.0.0.1";
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,
      clients: new Map()
    });
  }

  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(roomId, event, payload, excludedPeerId = null) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  for (const [peerId, client] of room.clients) {
    if (peerId === excludedPeerId) {
      continue;
    }
    sendSse(client.res, event, payload);
  }
}

function removeClient(roomId, peerId, reason = "left") {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const client = room.clients.get(peerId);
  if (!client) {
    return;
  }

  clearInterval(client.keepAliveTimer);
  room.clients.delete(peerId);

  if (room.hostId === peerId) {
    room.hostId = null;
  }

  broadcast(roomId, "peer-left", {
    peerId,
    role: client.role,
    reason
  });

  cleanupRoom(roomId);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

async function serveStatic(reqPath, res) {
  const normalizedPath = reqPath === "/" ? "/index.html" : reqPath;
  const filePath = path.normalize(path.join(publicDir, normalizedPath));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(filePath);
  const mime = mimeTypes[ext] || "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
  });

  createReadStream(filePath).pipe(res);
}

function buildMeta(hostHeader) {
  const localIp = pickLocalIp();
  const host = hostHeader || `localhost:${port}`;
  const currentProtocol = host.startsWith("localhost") || host.startsWith("127.0.0.1")
    ? "http"
    : "http";

  return {
    localIp,
    port,
    origin: `${currentProtocol}://${host}`,
    networkOrigin: `http://${localIp}:${port}`
  };
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/meta") {
    sendJson(res, 200, buildMeta(req.headers.host));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/qr") {
    const text = requestUrl.searchParams.get("text");
    if (!text) {
      sendJson(res, 400, { error: "Missing text" });
      return;
    }

    try {
      const svg = await QRCode.toString(text, {
        type: "svg",
        margin: 1,
        width: 280,
        color: {
          dark: "#0a0a0a",
          light: "#f7f1e8"
        }
      });

      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(svg);
    } catch (error) {
      sendJson(res, 500, { error: "QR generation failed" });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/events") {
    const roomId = (requestUrl.searchParams.get("room") || "").trim().toUpperCase();
    const peerId = (requestUrl.searchParams.get("peer") || "").trim();
    const role = requestUrl.searchParams.get("role") === "listener" ? "listener" : "host";

    if (!roomId || !peerId) {
      sendJson(res, 400, { error: "Missing room or peer" });
      return;
    }

    const room = getRoom(roomId);
    const previousClient = room.clients.get(peerId);
    if (previousClient) {
      removeClient(roomId, peerId, "reconnected");
    }

    if (role === "host" && room.hostId && room.hostId !== peerId) {
      const oldHost = room.clients.get(room.hostId);
      if (oldHost) {
        sendSse(oldHost.res, "server-info", {
          type: "host-replaced",
          roomId
        });
        oldHost.res.end();
      }
      removeClient(roomId, room.hostId, "host-replaced");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.write("\n");

    const keepAliveTimer = setInterval(() => {
      res.write(": ping\n\n");
    }, 20000);

    room.clients.set(peerId, {
      peerId,
      role,
      res,
      keepAliveTimer
    });

    if (role === "host") {
      room.hostId = peerId;
    }

    sendSse(res, "ready", {
      roomId,
      peerId,
      role,
      hostId: room.hostId,
      peers: [...room.clients.values()].map(client => ({
        peerId: client.peerId,
        role: client.role
      }))
    });

    broadcast(roomId, "peer-joined", {
      peerId,
      role
    }, peerId);

    req.on("close", () => {
      removeClient(roomId, peerId, "connection-closed");
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/signal") {
    try {
      const payload = await readJson(req);
      const roomId = (payload.roomId || "").trim().toUpperCase();
      const from = (payload.from || "").trim();
      const to = (payload.to || "").trim();
      const signal = payload.signal;

      if (!roomId || !from || !to || !signal) {
        sendJson(res, 400, { error: "Missing signal fields" });
        return;
      }

      const room = rooms.get(roomId);
      const target = room?.clients.get(to);
      if (!target) {
        sendJson(res, 404, { error: "Target peer not found" });
        return;
      }

      sendSse(target.res, "signal", {
        roomId,
        from,
        signal
      });
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: "Invalid request body" });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  serveStatic(requestUrl.pathname, res);
});

server.listen(port, bindHost, () => {
  const localIp = pickLocalIp();
  console.log("");
  console.log("TWS Audio Relay is running.");
  console.log(`Local:   http://localhost:${port}`);
  console.log(`Network: http://${localIp}:${port}`);
  console.log("");
  console.log("Open the page on the computer, choose the source mode,");
  console.log("then scan the QR code from the iPhone on the same Wi-Fi.");
  console.log("");
});
