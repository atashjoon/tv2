
"use strict";

/* =========================================================
   TRENDIFY NEXUS INSTALLER V2
   Runtime: Node.js 22 / Railway
   Module system: CommonJS
========================================================= */

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const APP_NAME = "Trendify Nexus Installer";
const APP_VERSION = "2.0.0";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/* =========================================================
   RESPONSE HELPERS
========================================================= */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function textResponse(message, status = 200) {
  return new Response(String(message), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || "Unknown error");
}

function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function base64UTF8(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function normalizeString(value, maxLength = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function isValidIdentifier(value) {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(String(value || ""));
}

/* =========================================================
   REQUEST BODY
========================================================= */

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const raw = await request.text();

  if (!raw || raw.length > 2 * 1024 * 1024) {
    throw new Error("Request body is empty or exceeds 2 MB");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON request body");
  }
}

/* =========================================================
   EXTERNAL API HELPER
========================================================= */

async function apiRequest(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const raw = await response.text();

    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    if (!response.ok) {
      const details =
        data?.errors?.map((item) => item.message).filter(Boolean).join("; ") ||
        data?.message ||
        data?.error ||
        raw ||
        `HTTP ${response.status}`;

      throw new Error(details);
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("External API request timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   GITHUB API
========================================================= */

async function github(path, token, options = {}) {
  if (!token) {
    throw new Error("GitHub token is required");
  }

  const normalizedPath = String(path || "").replace(/^\/+/, "");

  return apiRequest(
    "https://api.github.com/" + normalizedPath,
    {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );
}

/* =========================================================
   CLOUDFLARE API
========================================================= */

async function cf(path, token, options = {}) {
  if (!token) {
    throw new Error("Cloudflare API token is required");
  }

  const normalizedPath = String(path || "").replace(/^\/+/, "");

  const result = await apiRequest(
    "https://api.cloudflare.com/client/v4/" + normalizedPath,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    }
  );

  if (result?.success === false) {
    const messages = (result.errors || [])
      .map((item) => item.message)
      .filter(Boolean);

    throw new Error(
      messages.join("; ") || "Cloudflare API request failed"
    );
  }

  return result;
}

/* =========================================================
   GITHUB REPOSITORY FILE UPLOAD
========================================================= */

async function putRepoFile({
  token,
  owner,
  repo,
  path,
  content,
  message,
  branch,
}) {
  if (!token || !owner || !repo || !path) {
    throw new Error("Missing GitHub repository parameters");
  }

  const safePath = String(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  const endpoint =
    `repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/contents/${safePath}`;

  const payload = {
    message: message || `Add ${path}`,
    content: base64UTF8(content),
  };

  if (branch) {
    payload.branch = branch;
  }

  return github(endpoint, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

/* =========================================================
   INSTALLATION INPUT VALIDATION
========================================================= */

function validateInstallInput(input) {
  const githubToken = normalizeString(input.githubToken, 500);
  const cloudflareToken = normalizeString(input.cloudflareToken, 500);
  const accountId = normalizeString(input.accountId, 100);
  const telegramBotToken = normalizeString(input.telegramBotToken, 200);
  const telegramAdminId = normalizeString(input.telegramAdminId, 100);

  const missing = [];

  if (!githubToken) missing.push("githubToken");
  if (!cloudflareToken) missing.push("cloudflareToken");
  if (!accountId) missing.push("accountId");
  if (!telegramBotToken) missing.push("telegramBotToken");
  if (!telegramAdminId) missing.push("telegramAdminId");

  if (missing.length) {
    throw new Error(
      "Missing required fields: " + missing.join(", ")
    );
  }

  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("Cloudflare Account ID must contain 32 hexadecimal characters");
  }

  if (!/^\d+$/.test(telegramAdminId)) {
    throw new Error("Telegram Admin ID must be numeric");
  }

  return {
    githubToken,
    cloudflareToken,
    accountId,
    telegramBotToken,
    telegramAdminId,
  };
}

/* =========================================================
   END OF PART 1
   Add PART 2 directly below this line.
========================================================= */

/* =========================================================
   PART 2A — RAILWAY TCP RELAY SOURCE
========================================================= */

const RELAY_SOURCE = String.raw`
"use strict";

const net = require("node:net");

const PORT = Number(process.env.PORT || 443);
const RELAY_SECRET = String(process.env.RELAY_SECRET || "");

if (RELAY_SECRET.length < 16) {
  console.error("RELAY_SECRET must contain at least 16 characters");
  process.exit(1);
}

const server = net.createServer((client) => {
  client.setTimeout(30000);

  let buffer = Buffer.alloc(0);
  let state = "secret-length";
  let secretLength = 0;
  let hostLength = 0;
  let targetHost = "";
  let targetPort = 0;
  let upstream = null;

  function fail(message) {
    console.error("Relay connection rejected:", message);
    client.destroy();
    if (upstream) upstream.destroy();
  }

  function processBuffer() {
    while (!client.destroyed) {
      if (state === "secret-length") {
        if (buffer.length < 2) return;

        secretLength = buffer.readUInt16BE(0);
        buffer = buffer.subarray(2);

        if (secretLength < 16 || secretLength > 256) {
          return fail("Invalid secret length");
        }

        state = "secret";
      }

      if (state === "secret") {
        if (buffer.length < secretLength) return;

        const suppliedSecret = buffer
          .subarray(0, secretLength)
          .toString("utf8");

        buffer = buffer.subarray(secretLength);

        if (suppliedSecret !== RELAY_SECRET) {
          return fail("Invalid relay secret");
        }

        state = "host-length";
      }

      if (state === "host-length") {
        if (buffer.length < 2) return;

        hostLength = buffer.readUInt16BE(0);
        buffer = buffer.subarray(2);

        if (hostLength < 1 || hostLength > 253) {
          return fail("Invalid hostname length");
        }

        state = "host";
      }

      if (state === "host") {
        if (buffer.length < hostLength) return;

        targetHost = buffer
          .subarray(0, hostLength)
          .toString("utf8");

        buffer = buffer.subarray(hostLength);

        if (
          !targetHost ||
          /[\r\n\0]/.test(targetHost) ||
          targetHost.includes("/")
        ) {
          return fail("Invalid destination hostname");
        }

        state = "port";
      }

      if (state === "port") {
        if (buffer.length < 2) return;

        targetPort = buffer.readUInt16BE(0);
        buffer = buffer.subarray(2);

        if (targetPort < 1 || targetPort > 65535) {
          return fail("Invalid destination port");
        }

        state = "connecting";

        upstream = net.createConnection({
          host: targetHost,
          port: targetPort,
        });

        upstream.setTimeout(30000);

        upstream.once("connect", () => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }

          console.log(
            "Relay connected:",
            targetHost + ":" + targetPort
          );

          client.setTimeout(0);
          upstream.setTimeout(0);

          if (buffer.length > 0) {
            upstream.write(buffer);
            buffer = Buffer.alloc(0);
          }

          client.pipe(upstream);
          upstream.pipe(client);
        });

        upstream.once("error", (error) => {
          console.error("Destination connection failed:", error.message);
          client.destroy();
        });

        upstream.once("close", () => {
          if (!client.destroyed) client.destroy();
        });

        client.once("close", () => {
          if (upstream && !upstream.destroyed) upstream.destroy();
        });

        return;
      }

      return;
    }
  }

  client.on("data", (chunk) => {
    if (state === "connecting") {
      if (upstream && !upstream.destroyed) upstream.write(chunk);
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);

    if (buffer.length > 8192) {
      return fail("Handshake buffer too large");
    }

    processBuffer();
  });

  client.on("timeout", () => fail("Connection timed out"));
  client.on("error", (error) => {
    console.error("Client socket error:", error.message);
  });
});

server.on("error", (error) => {
  console.error("Relay server error:", error);
  process.exitCode = 1;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Trendify Nexus Relay listening on port " + PORT);
});
`;

/* =========================================================
   PART 2B — CLOUDFLARE GATEWAY WORKER SOURCE
========================================================= */

const GATEWAY_SOURCE = String.raw`
import { connect } from "cloudflare:sockets";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function parseUUID(value) {
  const normalized = String(value || "").replace(/-/g, "");

  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new Error("Invalid UUID configuration");
  }

  const bytes = new Uint8Array(16);

  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

function parseVlessHeader(data, env) {
  if (data.length < 24) {
    throw new Error("VLESS header is incomplete");
  }

  const version = data[0];
  const clientUUID = data.subarray(1, 17);
  const configuredUUID = parseUUID(env.UUID);

  if (!equalBytes(clientUUID, configuredUUID)) {
    throw new Error("Invalid VLESS UUID");
  }

  const optionLength = data[17];
  const commandOffset = 18 + optionLength;

  if (data.length < commandOffset + 4) {
    throw new Error("VLESS destination header is incomplete");
  }

  const command = data[commandOffset];

  if (command !== 1) {
    throw new Error("Only VLESS TCP is supported");
  }

  const port = (data[commandOffset + 1] << 8) |
    data[commandOffset + 2];

  const addressType = data[commandOffset + 3];
  let offset = commandOffset + 4;
  let hostname = "";

  if (addressType === 1) {
    if (data.length < offset + 4) {
      throw new Error("Incomplete IPv4 address");
    }

    hostname = Array.from(data.subarray(offset, offset + 4)).join(".");
    offset += 4;
  } else if (addressType === 2) {
    if (data.length < offset + 1) {
      throw new Error("Incomplete domain length");
    }

    const length = data[offset++];

    if (data.length < offset + length) {
      throw new Error("Incomplete domain address");
    }

    hostname = new TextDecoder().decode(
      data.subarray(offset, offset + length)
    );

    offset += length;
  } else if (addressType === 3) {
    if (data.length < offset + 16) {
      throw new Error("Incomplete IPv6 address");
    }

    const parts = [];

    for (let i = 0; i < 16; i += 2) {
      parts.push(
        ((data[offset + i] << 8) | data[offset + i + 1]).toString(16)
      );
    }

    hostname = parts.join(":");
    offset += 16;
  } else {
    throw new Error("Unsupported VLESS address type");
  }

  if (!hostname || port < 1 || port > 65535) {
    throw new Error("Invalid destination");
  }

  return {
    version,
    hostname,
    port,
    payload: data.subarray(offset)
  };
}

async function handleVless(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }

  if (!env.UUID) {
    return new Response("UUID is not configured", { status: 500 });
  }

  if (
    !env.RELAY_HOST ||
    !env.RELAY_PORT ||
    !env.RELAY_SECRET
  ) {
    return new Response("Relay configuration is incomplete", { status: 500 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const ws = pair[1];

  ws.accept();

  let relaySocket = null;
  let closed = false;
  let initialized = false;
  let queued = [];

  function closeAll() {
    if (closed) return;
    closed = true;

    try {
      if (relaySocket) relaySocket.close();
    } catch {}

    try {
      ws.close();
    } catch {}
  }

  ws.addEventListener("close", closeAll);
  ws.addEventListener("error", closeAll);

  ws.addEventListener("message", async (event) => {
    try {
      let data;

      if (typeof event.data === "string") {
        data = new TextEncoder().encode(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        data = new Uint8Array(event.data);
      } else if (ArrayBuffer.isView(event.data)) {
        data = new Uint8Array(
          event.data.buffer,
          event.data.byteOffset,
          event.data.byteLength
        );
      } else {
        throw new Error("Unsupported WebSocket message type");
      }

      if (!initialized) {
        queued.push(data);

        const combinedLength = queued.reduce(
          (sum, item) => sum + item.length,
          0
        );

        if (combinedLength < 24) return;

        const combined = new Uint8Array(combinedLength);
        let position = 0;

        for (const item of queued) {
          combined.set(item, position);
          position += item.length;
        }

        queued = [];

        const parsed = parseVlessHeader(combined, env);

        relaySocket = connect({
          hostname: env.RELAY_HOST,
          port: Number(env.RELAY_PORT)
        });

        const writer = relaySocket.writable.getWriter();

        const encoder = new TextEncoder();
        const secret = encoder.encode(String(env.RELAY_SECRET));
        const host = encoder.encode(parsed.hostname);

        if (secret.length > 256 || host.length > 253) {
          throw new Error("Relay handshake field is too long");
        }

        const handshake = new Uint8Array(
          2 + secret.length + 2 + host.length + 2
        );

        let offset = 0;

        handshake[offset++] = (secret.length >> 8) & 255;
        handshake[offset++] = secret.length & 255;
        handshake.set(secret, offset);
        offset += secret.length;

        handshake[offset++] = (host.length >> 8) & 255;
        handshake[offset++] = host.length & 255;
        handshake.set(host, offset);
        offset += host.length;

        handshake[offset++] = (parsed.port >> 8) & 255;
        handshake[offset] = parsed.port & 255;

        await writer.write(handshake);

        if (parsed.payload.length > 0) {
          await writer.write(parsed.payload);
        }

        writer.releaseLock();

        initialized = true;

        const responseHeader = new Uint8Array([
          parsed.version,
          0
        ]);

        ws.send(responseHeader);

        const readable = relaySocket.readable;

        (async () => {
          const reader = readable.getReader();

          try {
            while (!closed) {
              const result = await reader.read();

              if (result.done) break;

              if (result.value && result.value.length) {
                ws.send(result.value);
              }
            }
          } catch {
            closeAll();
          } finally {
            try {
              reader.releaseLock();
            } catch {}

            closeAll();
          }
        })();

        return;
      }

      if (relaySocket && !closed) {
        const writer = relaySocket.writable.getWriter();

        try {
          await writer.write(data);
        } finally {
          writer.releaseLock();
        }
      }
    } catch (error) {
      console.log("VLESS connection error:", error.message);
      closeAll();
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        success: true,
        gateway: "Trendify Nexus Gateway",
        gateway_id: env.GATEWAY_ID || null,
        region: env.GATEWAY_REGION || "eu",
        status: "online",
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      return handleVless(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};
`;

/* =========================================================
   END OF PART 2
   Add PART 3 below this line.
========================================================= */

/* =========================================================
   PART 3A — TELEGRAM BOT WORKER SOURCE
========================================================= */

const BOT_SOURCE = String.raw`
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function sendMessage(env, chatId, message) {
  const response = await fetch(
    "https://api.telegram.org/bot" +
      env.TELEGRAM_BOT_TOKEN +
      "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  if (!response.ok) {
    throw new Error("Telegram sendMessage failed: HTTP " + response.status);
  }

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        success: true,
        service: "Trendify Nexus Telegram Bot"
      });
    }

    if (url.pathname !== "/telegram-webhook") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_ADMIN_ID ||
      !env.BOT_WEBHOOK_SECRET
    ) {
      return new Response("Bot configuration missing", { status: 500 });
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.BOT_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const message = update.message;

    if (!message?.text || !message?.chat?.id) {
      return json({ success: true });
    }

    const senderId = String(message.from?.id || "");
    const chatId = message.chat.id;
    const command = message.text
      .trim()
      .split(/\s+/)[0]
      .split("@")[0];

    const isAdmin = senderId === String(env.TELEGRAM_ADMIN_ID);

    try {
      if (command === "/start" || command === "/help") {
        const responseText = isAdmin
          ? "Trendify Nexus Bot فعال است.\n\nدستورهای موجود:\n/start - شروع\n/help - راهنما\n/id - نمایش شناسه تلگرام\n\nتوجه: مدیریت کاربران تا زمان اتصال API پنل فعال نیست."
          : "سلام! ربات Trendify Nexus فعال است. برای دسترسی مدیریتی با مدیر سیستم تماس بگیرید.";

        await sendMessage(env, chatId, responseText);
      } else if (command === "/id") {
        await sendMessage(env, chatId, "Telegram ID: " + senderId);
      } else if (isAdmin) {
        await sendMessage(
          env,
          chatId,
          "ربات فعال است، اما عملیات مدیریتی تا اتصال به API پنل در دسترس نیست."
        );
      } else {
        await sendMessage(env, chatId, "این دستور در دسترس نیست.");
      }
    } catch (error) {
      console.log("Telegram handler error:", error.message);
    }

    return json({ success: true });
  }
};
`;

/* =========================================================
   PART 3B — CLOUDFLARE WORKER DEPLOYMENT
========================================================= */

async function deployWorker({
  accountId,
  token,
  workerName,
  source,
  bindings = [],
  compatibilityDate = "2026-10-01"
}) {
  if (!isValidIdentifier(workerName)) {
    throw new Error("Invalid Cloudflare Worker name");
  }

  const metadata = {
    main_module: "index.js",
    compatibility_date: compatibilityDate,
    bindings
  };

  const form = new FormData();

  form.append(
    "metadata",
    new Blob(
      [JSON.stringify(metadata)],
      { type: "application/json" }
    )
  );

  form.append(
    "index.js",
    new Blob(
      [source],
      { type: "application/javascript+module" }
    ),
    "index.js"
  );

  const result = await cf(
    "accounts/" +
      encodeURIComponent(accountId) +
      "/workers/scripts/" +
      encodeURIComponent(workerName),
    token,
    {
      method: "PUT",
      body: form
    }
  );

  if (result?.success === false) {
    throw new Error(
      (result.errors || [])
        .map((item) => item.message)
        .filter(Boolean)
        .join("; ") || "Worker deployment failed"
    );
  }

  return result;
}

/* =========================================================
   PART 3C — CLOUDFLARE WORKER SECRETS
========================================================= */

async function setWorkerSecret({
  accountId,
  token,
  workerName,
  secretName,
  secretValue
}) {
  if (!isValidIdentifier(workerName)) {
    throw new Error("Invalid Worker name");
  }

  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(secretName)) {
    throw new Error("Invalid Worker secret name");
  }

  const result = await cf(
    "accounts/" +
      encodeURIComponent(accountId) +
      "/workers/scripts/" +
      encodeURIComponent(workerName) +
      "/secrets",
    token,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: secretName,
        text: String(secretValue),
        type: "secret_text"
      })
    }
  );

  return result;
}

/* =========================================================
   PART 3D — SET TELEGRAM WEBHOOK
========================================================= */

async function setTelegramWebhook({
  botToken,
  webhookUrl,
  webhookSecret
}) {
  if (!botToken || !webhookUrl || !webhookSecret) {
    throw new Error("Telegram webhook parameters are missing");
  }

  if (!/^https:\/\//i.test(webhookUrl)) {
    throw new Error("Telegram webhook URL must use HTTPS");
  }

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error("Invalid Telegram webhook secret format");
  }

  const response = await apiRequest(
    "https://api.telegram.org/bot" +
      encodeURIComponent(botToken) +
      "/setWebhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ["message"]
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      response.description || "Telegram webhook setup failed"
    );
  }

  return response;
}

/* =========================================================
   PART 3E — CLOUDFLARE TOKEN VALIDATION
========================================================= */

async function validateCloudflareToken(token, accountId) {
  const result = await cf("user/tokens/verify", token);

  if (result?.success === false) {
    throw new Error("Cloudflare token validation failed");
  }

  const accountResult = await cf(
    "accounts/" + encodeURIComponent(accountId),
    token
  );

  if (accountResult?.success === false || !accountResult?.result?.id) {
    throw new Error("Cloudflare account could not be accessed");
  }

  return {
    tokenStatus: result?.result?.status || "unknown",
    accountId: accountResult.result.id,
    accountName: accountResult.result.name || null
  };
}

/* =========================================================
   END OF PART 3
   Add PART 4 below this line.
========================================================= */

/* =========================================================
   PART 4A — CREATE GITHUB REPOSITORY
========================================================= */

async function createGithubRepository(token, repoName) {
  if (!isValidIdentifier(repoName)) {
    throw new Error("Invalid repository name");
  }

  const result = await github("user/repos", token, {
    method: "POST",
    body: JSON.stringify({
      name: repoName,
      description: "Trendify Nexus Relay Service",
      private: true,
      auto_init: true
    })
  });

  if (!result?.full_name || !result?.owner?.login) {
    throw new Error("GitHub did not return repository information");
  }

  return {
    owner: result.owner.login,
    name: result.name,
    fullName: result.full_name,
    url: result.html_url,
    defaultBranch: result.default_branch || "main"
  };
}

/* =========================================================
   PART 4B — CREATE RAILWAY PROJECT FILES
========================================================= */

function buildRailwayFiles() {
  const packageJson = {
    name: "trendify-nexus-relay",
    version: "1.0.0",
    private: true,
    description: "Trendify Nexus TCP Relay",
    main: "server.js",
    type: "commonjs",
    scripts: {
      start: "node server.js"
    },
    engines: {
      node: ">=22"
    }
  };

  const dockerfile = [
    "FROM node:22-alpine",
    "WORKDIR /app",
    "COPY package.json ./",
    "COPY server.js ./",
    "ENV NODE_ENV=production",
    "EXPOSE 443",
    'CMD ["npm", "start"]',
    ""
  ].join("\n");

  const railwayJson = {
    "$schema": "https://railway.com/railway.schema.json",
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile"
    },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10
    }
  };

  const readme = [
    "# Trendify Nexus Relay",
    "",
    "Node.js TCP relay for Trendify Nexus.",
    "",
    "## Required Railway variables",
    "",
    "- `PORT`: Railway service port",
    "- `RELAY_SECRET`: shared secret used by the Gateway",
    "",
    "## Deployment",
    "",
    "1. Create a Railway service from this repository.",
    "2. Set `RELAY_SECRET` to a long random value.",
    "3. Configure a reachable TCP endpoint for the service.",
    "4. Set the Gateway's `RELAY_HOST`, `RELAY_PORT`, and `RELAY_SECRET`.",
    "",
    "The relay protocol is custom and is not an HTTP server.",
    ""
  ].join("\n");

  return {
    "server.js": RELAY_SOURCE,
    "package.json": JSON.stringify(packageJson, null, 2) + "\n",
    "Dockerfile": dockerfile,
    "railway.json": JSON.stringify(railwayJson, null, 2) + "\n",
    "README.md": readme
  };
}

/* =========================================================
   PART 4C — UPLOAD PROJECT FILES
========================================================= */

async function uploadRailwayFiles({
  token,
  repository
}) {
  const files = buildRailwayFiles();

  for (const [path, content] of Object.entries(files)) {
    await putRepoFile({
      token,
      owner: repository.owner,
      repo: repository.name,
      path,
      content,
      branch: repository.defaultBranch,
      message: "Add Trendify Nexus deployment file: " + path
    });
  }

  return Object.keys(files);
}

/* =========================================================
   PART 4D — RANDOM WORKER NAMES
========================================================= */

function createWorkerNames() {
  return {
    gatewayName: "nexus-gateway-" + randomHex(4),
    botName: "nexus-bot-" + randomHex(4),
    repositoryName: "trendify-nexus-relay-" + randomHex(4)
  };
}

/* =========================================================
   PART 4E — BUILD INSTALLATION RESPONSE
========================================================= */

function buildInstallResponse({
  repository,
  gatewayName,
  botName,
  relaySecret,
  gatewayUUID,
  webhookSecret
}) {
  return {
    success: true,
    app: APP_NAME,
    version: APP_VERSION,
    repository: {
      name: repository.name,
      url: repository.url
    },
    cloudflare: {
      gatewayWorker: gatewayName,
      gatewayUrl:
        "https://" + gatewayName + ".workers.dev",
      telegramBotWorker: botName,
      telegramWebhookUrl:
        "https://" + botName + ".workers.dev/telegram-webhook"
    },
    railway: {
      note:
        "Repository files are prepared. Create or connect a Railway service and configure its variables.",
      requiredVariables: {
        PORT: "443",
        RELAY_SECRET: relaySecret
      }
    },
    gatewayVariables: {
      UUID: gatewayUUID,
      RELAY_HOST: "REPLACE_WITH_RAILWAY_TCP_HOST",
      RELAY_PORT: "REPLACE_WITH_RAILWAY_TCP_PORT",
      RELAY_SECRET: relaySecret,
      GATEWAY_REGION: "eu"
    },
    telegram: {
      webhookSecret,
      note:
        "Configure the bot Worker secrets and deploy it before registering its webhook."
    }
  };
}

/* =========================================================
   END OF PART 4
   Add PART 5 below this line.
========================================================= */

/* =========================================================
   PART 5A — CLOUDFLARE WORKERS SUBDOMAIN
========================================================= */

async function getWorkersSubdomain(accountId, token) {
  const result = await cf(
    "accounts/" + encodeURIComponent(accountId) + "/workers/subdomain",
    token
  );

  const subdomain = result?.result?.subdomain;

  if (!subdomain) {
    throw new Error(
      "Cloudflare Workers subdomain is unavailable. Enable workers.dev for this account first."
    );
  }

  return subdomain;
}

/* =========================================================
   PART 5B — GITHUB TOKEN VALIDATION
========================================================= */

async function validateGithubToken(token) {
  const user = await github("user", token);

  if (!user?.login) {
    throw new Error("Could not verify GitHub account");
  }

  return {
    login: user.login,
    name: user.name || user.login
  };
}

/* =========================================================
   PART 5C — INSTALL HANDLER
========================================================= */

async function handleInstall(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  if (request.method !== "POST") {
    return json({
      success: false,
      error: "Method not allowed"
    }, 405);
  }

  let input;

  try {
    input = await readJson(request);
  } catch (error) {
    return json({
      success: false,
      error: errorMessage(error)
    }, 400);
  }

  let credentials;

  try {
    credentials = validateInstallInput(input);
  } catch (error) {
    return json({
      success: false,
      error: errorMessage(error)
    }, 400);
  }

  const {
    githubToken,
    cloudflareToken,
    accountId,
    telegramBotToken,
    telegramAdminId
  } = credentials;

  try {
    /* Validate external credentials */

    const [githubUser, cloudflareAccount] = await Promise.all([
      validateGithubToken(githubToken),
      validateCloudflareToken(cloudflareToken, accountId)
    ]);

    /* Resolve account Workers subdomain */

    const workersSubdomain = await getWorkersSubdomain(
      accountId,
      cloudflareToken
    );

    /* Generate installation identifiers and secrets */

    const names = createWorkerNames();

    const relaySecret = randomSecret(32);
    const gatewayUUID = crypto.randomUUID();
    const webhookSecret = randomHex(32);

    /* Create GitHub repository */

    const repository = await createGithubRepository(
      githubToken,
      names.repositoryName
    );

    const uploadedFiles = await uploadRailwayFiles({
      token: githubToken,
      repository
    });

    /* Deploy Gateway Worker */

    await deployWorker({
      accountId,
      token: cloudflareToken,
      workerName: names.gatewayName,
      source: GATEWAY_SOURCE,
      bindings: [
        {
          type: "plain_text",
          name: "GATEWAY_ID",
          text: crypto.randomUUID()
        },
        {
          type: "plain_text",
          name: "GATEWAY_REGION",
          text: "eu"
        },
        {
          type: "plain_text",
          name: "RELAY_HOST",
          text: "REPLACE_WITH_RAILWAY_TCP_HOST"
        },
        {
          type: "plain_text",
          name: "RELAY_PORT",
          text: "443"
        }
      ]
    });

    await setWorkerSecret({
      accountId,
      token: cloudflareToken,
      workerName: names.gatewayName,
      secretName: "UUID",
      secretValue: gatewayUUID
    });

    await setWorkerSecret({
      accountId,
      token: cloudflareToken,
      workerName: names.gatewayName,
      secretName: "RELAY_SECRET",
      secretValue: relaySecret
    });

    /* Deploy Telegram Bot Worker */

    await deployWorker({
      accountId,
      token: cloudflareToken,
      workerName: names.botName,
      source: BOT_SOURCE
    });

    await setWorkerSecret({
      accountId,
      token: cloudflareToken,
      workerName: names.botName,
      secretName: "TELEGRAM_BOT_TOKEN",
      secretValue: telegramBotToken
    });

    await setWorkerSecret({
      accountId,
      token: cloudflareToken,
      workerName: names.botName,
      secretName: "TELEGRAM_ADMIN_ID",
      secretValue: telegramAdminId
    });

    await setWorkerSecret({
      accountId,
      token: cloudflareToken,
      workerName: names.botName,
      secretName: "BOT_WEBHOOK_SECRET",
      secretValue: webhookSecret
    });

    /* Register Telegram webhook */

    const botWebhookUrl =
      "https://" +
      names.botName +
      "." +
      workersSubdomain +
      ".workers.dev/telegram-webhook";

    await setTelegramWebhook({
      botToken: telegramBotToken,
      webhookUrl: botWebhookUrl,
      webhookSecret
    });

    /* Prepare installation response */

    const output = buildInstallResponse({
      repository,
      gatewayName: names.gatewayName,
      botName: names.botName,
      relaySecret,
      gatewayUUID,
      webhookSecret
    });

    /* Do not expose the Telegram webhook secret */

    if (output.telegram) {
      delete output.telegram.webhookSecret;
    }

    output.github = {
      username: githubUser.login
    };

    output.cloudflare = {
      ...output.cloudflare,
      accountName: cloudflareAccount.accountName,
      workersSubdomain
    };

    output.repository.files = uploadedFiles;

    output.nextSteps = [
      "Create a Railway service from the generated GitHub repository.",
      "Set RELAY_SECRET in Railway to the value returned in this response.",
      "Configure a public TCP endpoint for the Railway relay.",
      "Update the Gateway Worker RELAY_HOST and RELAY_PORT bindings to the actual Railway TCP endpoint.",
      "Redeploy the Gateway Worker after updating its relay bindings."
    ];

    return json(output, 200);

  } catch (error) {
    console.error("Installer failed:", errorMessage(error));

    return json({
      success: false,
      error: errorMessage(error),
      message:
        "Installation did not complete. Check the Railway logs and verify GitHub and Cloudflare permissions."
    }, 500);
  }
}

/* =========================================================
   PART 5D — NODE.JS HTTP SERVER
========================================================= */

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(
    req.url || "/",
    "http://localhost"
  );

  /* Health check */

  if (
    req.method === "GET" &&
    (requestUrl.pathname === "/" ||
      requestUrl.pathname === "/health")
  ) {
    const response = json({
      success: true,
      app: APP_NAME,
      version: APP_VERSION,
      status: "online",
      runtime: process.version
    });

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
    return;
  }

  /* Browser preflight */

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  /* Installer endpoint */

  if (
    requestUrl.pathname !== "/api/install" ||
    req.method !== "POST"
  ) {
    const response = json({
      success: false,
      error: "Not Found",
      installEndpoint: "POST /api/install"
    }, 404);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
    return;
  }

  try {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of req) {
      totalBytes += chunk.length;

      if (totalBytes > 2 * 1024 * 1024) {
        const response = json({
          success: false,
          error: "Request body exceeds 2 MB"
        }, 413);

        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);

    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        headers.set(key, value.join(", "));
      } else if (value !== undefined) {
        headers.set(key, String(value));
      }
    }

    const request = new Request(
      "http://localhost/api/install",
      {
        method: "POST",
        headers,
        body
      }
    );

    const response = await handleInstall(request);

    const responseHeaders = Object.fromEntries(response.headers);

    res.writeHead(response.status, responseHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));

  } catch (error) {
    console.error("HTTP server error:", errorMessage(error));

    if (!res.headersSent) {
      res.writeHead(500, {
        ...JSON_HEADERS,
        ...CORS_HEADERS
      });

      res.end(JSON.stringify({
        success: false,
        error: "Internal server error"
      }));
    } else {
      res.end();
    }
  }
});

server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, () => {
  console.log(
    APP_NAME +
    " v" + APP_VERSION +
    " listening on " + HOST + ":" + PORT
  );
});

/* =========================================================
   END OF PART 5
========================================================= */
