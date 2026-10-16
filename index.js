const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function randomHex(bytes = 24) {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    x => x.toString(16).padStart(2, "0")
  ).join("");
}

function base64UTF8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  return btoa(binary);
}

async function github(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Trendify-Nexus-Installer",
      ...(options.headers || {}),
    },
  });
}

async function cf(path, token, options = {}) {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4" + path,
    {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        ...(options.headers || {}),
      },
    }
  );

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = {
      success: false,
      errors: [{ message: raw || "Invalid Cloudflare response" }],
    };
  }

  if (!response.ok || data.success === false) {
    const details = (data.errors || [])
      .map(x => x.message || JSON.stringify(x))
      .join("; ");

    throw new Error(
      "Cloudflare API: " + (details || response.status)
    );
  }

  return data.result;
}

async function putRepoFile(owner, repo, path, content, token) {
  const url =
    "https://api.github.com/repos/" +
    owner + "/" + repo + "/contents/" + path;

  const existing = await github(url, token);
  let sha;

  if (existing.ok) {
    sha = (await existing.json()).sha;
  } else if (existing.status !== 404) {
    throw new Error(
      "GitHub read failed (" + path + "): " +
      await existing.text()
    );
  }

  const response = await github(url, token, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Create Trendify Nexus Relay files",
      content: base64UTF8(content),
      ...(sha ? { sha } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      "GitHub upload failed (" + path + "): " +
      await response.text()
    );
  }
}


async function fetchRelaySource() {
  const url =
    "https://raw.githubusercontent.com/Trendiify/Trendify-nexus-relay/main/server.js";

  const response = await fetch(url, {
    headers: {
      "Accept": "text/plain",
      "Cache-Control": "no-cache"
    }
  });

  if (!response.ok) {
    throw new Error(
      `دریافت سورس اصلی Relay ناموفق بود: HTTP ${response.status}`
    );
  }

  let source = await response.text();

  if (
    !source.includes('import net from "node:net"') ||
    !source.includes("timingSafeEqual") ||
    !source.includes("RELAY_SECRET") ||
    !source.includes('stage = "connected";')
  ) {
    throw new Error(
      "سورس اصلی Relay ساختار مورد انتظار را ندارد."
    );
  }

  const connectMarker =
    'stage = "connected";\n            console.log("TARGET CONNECTED:", host, port);';

  if (!source.includes(connectMarker)) {
    throw new Error(
      "محل تأیید اتصال در سورس Relay پیدا نشد؛ نصب متوقف شد."
    );
  }

  source = source.replace(
    connectMarker,
    'stage = "connected";\n' +
    '            client.write(Buffer.from([0]));\n' +
    '            console.log("TARGET CONNECTED:", host, port);'
  );

  const errorMarker =
    'remote.on("error", (err) => {\n' +
    '            console.log("REMOTE ERROR:", err.message);\n' +
    '            client.destroy();\n' +
    '          });';

  if (!source.includes(errorMarker)) {
    throw new Error(
      "مدیریت خطای اتصال در سورس Relay پیدا نشد."
    );
  }

  source = source.replace(
    errorMarker,
    'remote.on("error", (err) => {\n' +
    '            console.log("REMOTE ERROR:", err.message);\n' +
    '            if (stage !== "connected" && !client.destroyed) {\n' +
    '              client.end(Buffer.from([1]));\n' +
    '            } else {\n' +
    '              client.destroy();\n' +
    '            }\n' +
    '          });'
  );

  const closeMarker =
    'remote.on("close", () => {\n' +
    '            client.destroy();\n' +
    '          });';

  if (!source.includes(closeMarker)) {
    throw new Error(
      "مدیریت بسته‌شدن اتصال در سورس Relay پیدا نشد."
    );
  }

  source = source.replace(
    closeMarker,
    'remote.on("close", () => {\n' +
    '            if (stage !== "connected" && !client.destroyed) {\n' +
    '              client.end(Buffer.from([1]));\n' +
    '            } else {\n' +
    '              client.destroy();\n' +
    '            }\n' +
    '          });'
  );

  if (!source.includes("client.write(Buffer.from([0]))")) {
    throw new Error(
      "تأیید اتصال موفق در سورس Relay اضافه نشد."
    );
  }

  return source;
}


async function createGitHubRepo(token, name, description) {
  const response = await github(
    "https://api.github.com/user/repos",
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        private: false,
        auto_init: true
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      "GitHub repository creation failed: " +
      await response.text()
    );
  }

  return response.json();
}

async function copyBackendTemplate(token, owner, targetRepo) {
  const templateOwner = "Trendiify";
  const templateRepo = "trendify-nexus-backend";
  const branch = "main";

  const response = await github(
    `https://api.github.com/repos/${templateOwner}/${templateRepo}/git/trees/${branch}?recursive=1`,
    token
  );

  if (!response.ok) {
    throw new Error(
      "خواندن مخزن قالب بک‌اند ناموفق بود: " +
      await response.text()
    );
  }

  const tree = await response.json();

  if (!Array.isArray(tree.tree)) {
    throw new Error("ساختار فایل‌های مخزن بک‌اند معتبر نیست.");
  }

  const files = tree.tree.filter(file =>
    file.type === "blob" &&
    !file.path.startsWith(".git/") &&
    !file.path.startsWith("node_modules/") &&
    !file.path.split("/").some(part =>
      part === "node_modules" || part === ".git"
    ) &&
    ![".env", ".env.local", ".env.production"].includes(file.path) &&
    !file.path.endsWith(".pem") &&
    !file.path.endsWith(".key")
  );

  if (!files.length) {
    throw new Error("هیچ فایلی برای کپی از مخزن بک‌اند پیدا نشد.");
  }

  for (const file of files) {
    const rawUrl =
      `https://raw.githubusercontent.com/${templateOwner}/${templateRepo}/${branch}/${file.path}`;

    const fileResponse = await fetch(rawUrl);

    if (!fileResponse.ok) {
      throw new Error(
        `خواندن فایل ${file.path} ناموفق بود.`
      );
    }

    const content = await fileResponse.text();

    await putRepoFile(
      owner,
      targetRepo,
      file.path,
      content,
      token
    );
  }

  return files.length;
}
/* =====================================================
   1. AUTHENTICATED TCP RELAY
===================================================== */

const RELAY_SOURCE = String.raw`
import net from "node:net";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 443);
const SECRET = String(process.env.RELAY_SECRET || "");
const MAX_SECRET_LENGTH = 256;

if (!SECRET) {
  console.error("RELAY_SECRET is required");
  process.exit(1);
}

const expectedSecret = Buffer.from(SECRET, "utf8");

if (
  expectedSecret.length < 16 ||
  expectedSecret.length > MAX_SECRET_LENGTH
) {
  console.error("Invalid RELAY_SECRET length");
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("Invalid PORT");
  process.exit(1);
}

const server = net.createServer(client => {
  client.setNoDelay(true);

  let remote = null;
  let buffer = Buffer.alloc(0);
  let stage = "secretLength";
  let secretLength = 0;
  let hostLength = 0;
  let finished = false;
  let connectTimer = null;

  const timer = setTimeout(() => {
    if (stage !== "connected") {
      reject("Handshake timeout");
    }
  }, 10000);

  function reject(reason) {
    if (finished) return;

    finished = true;
    clearTimeout(timer);
    clearTimeout(connectTimer);

    console.log("REJECT:", reason);

    client.destroy();
    remote?.destroy();
  }

  function onData(chunk) {
    if (finished) return;

    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (stage === "secretLength") {
        if (buffer.length < 2) return;

        secretLength = buffer.readUInt16BE(0);
        buffer = buffer.subarray(2);

        if (
          secretLength < 16 ||
          secretLength > MAX_SECRET_LENGTH
        ) {
          return reject("Invalid secret length");
        }

        stage = "secret";
      }

      if (stage === "secret") {
        if (buffer.length < secretLength) return;

        const received = buffer.subarray(0, secretLength);
        buffer = buffer.subarray(secretLength);

        if (
          received.length !== expectedSecret.length ||
          !timingSafeEqual(received, expectedSecret)
        ) {
          return reject("Authentication failed");
        }

        stage = "hostLength";
      }

      if (stage === "hostLength") {
        if (buffer.length < 2) return;

        hostLength = buffer.readUInt16BE(0);
        buffer = buffer.subarray(2);

        if (hostLength < 1 || hostLength > 255) {
          return reject("Invalid host length");
        }

        stage = "target";
      }

      if (stage === "target") {
        if (buffer.length < hostLength + 2) return;

        const host = buffer
          .subarray(0, hostLength)
          .toString("utf8");

        const port = buffer.readUInt16BE(hostLength);
        const payload = buffer.subarray(hostLength + 2);

        buffer = Buffer.alloc(0);
        stage = "connecting";

        if (
          !host ||
          /[\0\r\n]/.test(host) ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535
        ) {
          return reject("Invalid destination");
        }

        clearTimeout(timer);

        client.pause();
        client.removeListener("data", onData);

        try {
          remote = net.connect({ host, port });
          remote.setNoDelay(true);

          let acknowledged = false;

          connectTimer = setTimeout(() => {
            if (!acknowledged) {
              console.log("REMOTE CONNECT TIMEOUT:", host, port);

              if (!client.destroyed) {
                client.end(Buffer.from([1]));
              }

              remote.destroy();
            }
          }, 10000);

          remote.once("connect", () => {
            if (finished) {
              clearTimeout(connectTimer);
              return remote.destroy();
            }

            acknowledged = true;
            clearTimeout(connectTimer);

            stage = "connected";

            console.log("CONNECTED:", host, port);

            client.write(Buffer.from([0]));

            if (payload.length) {
              remote.write(payload);
            }

            client.pipe(remote);
            remote.pipe(client);
            client.resume();
          });

          remote.on("error", err => {
            console.log("REMOTE ERROR:", err.message);
            clearTimeout(connectTimer);

            if (!acknowledged && !client.destroyed) {
              client.end(Buffer.from([1]));
            } else {
              client.destroy();
            }
          });

          remote.on("close", () => {
            clearTimeout(connectTimer);

            if (!acknowledged && !client.destroyed) {
              client.end(Buffer.from([1]));
            } else if (!client.destroyed) {
              client.destroy();
            }
          });
        } catch (err) {
          reject(err.message);
        }

        return;
      }

      return;
    }
  }

  client.on("data", onData);

  client.on("error", err => {
    console.log("CLIENT ERROR:", err.message);
    remote?.destroy();
  });

  client.on("close", () => {
    finished = true;
    clearTimeout(timer);
    clearTimeout(connectTimer);
    remote?.destroy();
  });
});

server.on("error", err => {
  console.error("SERVER ERROR:", err);
  process.exitCode = 1;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Authenticated TCP Relay listening on", PORT);
});
`;
/* =====================================================
   2. VLESS GATEWAY
===================================================== */

const GATEWAY_SOURCE = String.raw`
import { connect } from "cloudflare:sockets";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function uuidFromBytes(bytes) {
  const h = Array.from(
    bytes,
    b => b.toString(16).padStart(2, "0")
  ).join("");

  return h.slice(0,8) + "-" + h.slice(8,12) + "-" +
    h.slice(12,16) + "-" + h.slice(16,20) + "-" +
    h.slice(20,32);
}

function decodeEarlyData(value) {
  if (!value) return null;

  try {
    let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    normalized += "=".repeat((4 - normalized.length % 4) % 4);

    const binary = atob(normalized);

    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function bytesOf(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
  }

  if (data && typeof data.arrayBuffer === "function") {
    return new Uint8Array(await data.arrayBuffer());
  }

  throw new Error("Unsupported WebSocket data");
}

function parseVLESS(bytes) {
  if (bytes.length < 24) {
    throw new Error("VLESS header too short");
  }

  const version = bytes[0];
  const uuid = uuidFromBytes(bytes.slice(1, 17));
  let i = 18 + bytes[17];

  if (i + 4 > bytes.length) {
    throw new Error("Invalid VLESS header");
  }

  const command = bytes[i++];

  if (command !== 1) {
    throw new Error("Only VLESS TCP is supported");
  }

  const port = (bytes[i++] << 8) | bytes[i++];
  const type = bytes[i++];
  let host = "";

  if (type === 1) {
    if (i + 4 > bytes.length) {
      throw new Error("Invalid IPv4");
    }

    host = Array.from(bytes.slice(i, i + 4)).join(".");
    i += 4;
  } else if (type === 2) {
    if (i >= bytes.length) {
      throw new Error("Invalid domain");
    }

    const length = bytes[i++];

    if (i + length > bytes.length) {
      throw new Error("Invalid domain length");
    }

    host = new TextDecoder().decode(bytes.slice(i, i + length));
    i += length;
  } else if (type === 3) {
    if (i + 16 > bytes.length) {
      throw new Error("Invalid IPv6");
    }

    const parts = [];

    for (let n = 0; n < 16; n += 2) {
      parts.push(
        ((bytes[i+n] << 8) | bytes[i+n+1]).toString(16)
      );
    }

    host = parts.join(":");
    i += 16;
  } else {
    throw new Error("Unknown address type");
  }

  if (!host || port < 1 || port > 65535) {
    throw new Error("Invalid destination");
  }

  return {
    version,
    uuid: uuid.toLowerCase(),
    host,
    port,
    payload: bytes.slice(i)
  };
}

async function authorizeUUID(env, uuid) {
  if (!env.NEXUS_API_URL || !env.NEXUS_GATEWAY_SECRET || !env.GATEWAY_ID) {
    throw new Error("V2 backend authentication variables are missing");
  }

  const endpoint = env.NEXUS_API_URL.replace(/\/+$/, "") +
    "/api/internal/gateway/auth?uuid=" + encodeURIComponent(uuid) +
    "&gateway_id=" + encodeURIComponent(env.GATEWAY_ID);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "X-Nexus-Gateway-Secret": env.NEXUS_GATEWAY_SECRET
    }
  });

  if (!response.ok) {
    throw new Error("Backend authorization failed: " + response.status);
  }

  const result = await response.json();

  if (result.authorized !== true) {
    throw new Error(
      result.reason || "UUID is not authorized by Trendify Nexus V2"
    );
  }

  return result;
}

async function handleVLESS(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket Required", { status: 426 });
  }

  if (
    !env.RELAY_SECRET ||
    !env.RELAY_HOST ||
    !env.RELAY_PORT ||
    !env.NEXUS_API_URL ||
    !env.NEXUS_GATEWAY_SECRET ||
    !env.GATEWAY_ID ||
    env.RELAY_HOST === "SET_RELAY_HOST" ||
    env.NEXUS_API_URL === "SET_BACKEND_URL" ||
    env.GATEWAY_ID === "SET_GATEWAY_ID" ||
    env.NEXUS_GATEWAY_SECRET === "SET_NEXUS_GATEWAY_SECRET"
  ) {
    return new Response("Gateway environment is incomplete", {
      status: 503
    });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const ws = pair[1];

  ws.accept();

  let socket;
  let writer;
  let closed = false;
  let relayHandshakePending = true;
  let chain = Promise.resolve();

  function closeAll() {
    if (closed) return;

    closed = true;

    try { writer?.releaseLock(); } catch {}
    try { socket?.close(); } catch {}
    try { ws.close(); } catch {}
  }

  async function connectRelay(parsed) {
    const secret = new TextEncoder().encode(env.RELAY_SECRET);
    const host = new TextEncoder().encode(parsed.host);
    const relayPort = Number(env.RELAY_PORT);

    if (secret.length < 16 || secret.length > 256) {
      throw new Error("Invalid relay secret");
    }

    if (!host.length || host.length > 255) {
      throw new Error("Invalid destination hostname");
    }

    if (
      !Number.isInteger(relayPort) ||
      relayPort < 1 ||
      relayPort > 65535
    ) {
      throw new Error("Invalid relay port");
    }

    socket = connect({
      hostname: String(env.RELAY_HOST).trim(),
      port: relayPort
    });

    await socket.opened;

    if (closed) {
      return socket.close();
    }

    writer = socket.writable.getWriter();

    const frame = new Uint8Array(
      2 + secret.length + 2 + host.length +
      2 + parsed.payload.length
    );

    let offset = 0;

    frame[offset++] = (secret.length >> 8) & 255;
    frame[offset++] = secret.length & 255;

    frame.set(secret, offset);
    offset += secret.length;

    frame[offset++] = (host.length >> 8) & 255;
    frame[offset++] = host.length & 255;

    frame.set(host, offset);
    offset += host.length;

    frame[offset++] = (parsed.port >> 8) & 255;
    frame[offset++] = parsed.port & 255;

    frame.set(parsed.payload, offset);

    await writer.write(frame);

    socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (closed || ws.readyState !== WebSocket.OPEN) return;

        const data = chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk);

        if (relayHandshakePending) {
          if (data.length < 1) return;

          relayHandshakePending = false;

          if (data[0] !== 0) {
            closeAll();
            return;
          }

          ws.send(new Uint8Array([parsed.version, 0]));

          if (data.length > 1) {
            ws.send(data.slice(1));
          }

          return;
        }

        if (data.length) {
          ws.send(data);
        }
      }
    })).catch(err => {
      if (!closed) {
        console.log("RELAY STREAM ERROR", err.message);
      }
    }).finally(closeAll);
  }

  async function onMessage(data) {
    const bytes = await bytesOf(data);

    if (writer) {
      await writer.write(bytes);
      return;
    }

    const parsed = parseVLESS(bytes);

    await authorizeUUID(env, parsed.uuid);
    await connectRelay(parsed);
  }

  function enqueue(data) {
    chain = chain.then(() => onMessage(data)).catch(err => {
      console.log("VLESS ERROR:", err.message);
      closeAll();
    });
  }

  const early = decodeEarlyData(
    request.headers.get("sec-websocket-protocol")
  );

  if (early?.length) {
    enqueue(early);
  }

  ws.addEventListener("message", event => enqueue(event.data));
  ws.addEventListener("close", closeAll);
  ws.addEventListener("error", closeAll);

  const headers = {};
  const protocol = request.headers.get("sec-websocket-protocol");

  if (protocol) {
    headers["sec-websocket-protocol"] = protocol;
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "*"
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
      return handleVLESS(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};
`;

/* =====================================================
   4. CLOUDFLARE WORKER DEPLOYMENT
===================================================== */

async function deployWorker(
  accountId,
  token,
  workerName,
  source,
  bindings = {},
  secretNames = [],
  kvNamespaces = []
) {
  const textBindings = Object.entries(bindings).map(
    ([name, value]) => ({
      type: secretNames.includes(name)
        ? "secret_text"
        : "plain_text",
      name,
      text: String(value)
    })
  );

  const namespaceBindings = kvNamespaces.map(
    ({ name, namespaceId }) => ({
      type: "kv_namespace",
      name,
      namespace_id: namespaceId
    })
  );

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-10",
    bindings: [
      ...textBindings,
      ...namespaceBindings
    ]
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
    new Blob([source], {
      type: "application/javascript+module"
    }),
    "index.js"
  );

  await cf(
    `/accounts/${accountId}/workers/scripts/${workerName}`,
    token,
    {
      method: "PUT",
      body: form
    }
  );

  await cf(
    `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ enabled: true })
    }
  );
}

/* =====================================================
   5. INSTALLER API
   Creates backend and relay repositories.
   Does NOT deploy a Cloudflare Gateway Worker.
===================================================== */

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    if (request.method !== "POST") {
      return json({
        success: false,
        message: "Method Not Allowed"
      }, 405);
    }

    let backendRepository = null;
    let relayRepository = null;

    try {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({
          success: false,
          message: "بدنه درخواست JSON معتبر نیست."
        }, 400);
      }

      const githubToken = String(body.githubToken || "").trim();
      const cloudflareToken = String(body.cloudflareToken || "").trim();
      const accountId = String(body.accountId || "").trim();

      if (!githubToken || !cloudflareToken || !accountId) {
        return json({
          success: false,
          message: "هر سه فیلد الزامی هستند."
        }, 400);
      }

      const tokenCheck = await cf(
        "/user/tokens/verify",
        cloudflareToken
      );

      if (tokenCheck.status !== "active") {
        throw new Error("Cloudflare API Token فعال نیست.");
      }

      const userResponse = await github(
        "https://api.github.com/user",
        githubToken
      );

      if (!userResponse.ok) {
        throw new Error(
          "GitHub Token معتبر نیست یا مجوز ساخت Repository ندارد."
        );
      }

      const githubUser = await userResponse.json();
      const owner = githubUser.login;

      /*
       * 1. Create backend repository from the existing
       * Trendify Nexus V2 backend template.
       */

      const backendName =
        "trendify-nexus-backend-" + randomHex(5);

      await createGitHubRepo(
        githubToken,
        backendName,
        "Trendify Nexus V2 Backend"
      );

      backendRepository =
        `https://github.com/${owner}/${backendName}`;

      const copiedFiles = await copyBackendTemplate(
        githubToken,
        owner,
        backendName
      );

      /*
       * 2. Create the TCP relay repository.
       */

      const relayName =
        "trendify-nexus-relay-" + randomHex(5);

      await createGitHubRepo(
        githubToken,
        relayName,
        "Trendify Nexus Authenticated TCP Relay"
      );

      relayRepository =
        `https://github.com/${owner}/${relayName}`;

      const relaySecret = randomHex(32);

      const packageJson = JSON.stringify({
        name: relayName,
        version: "1.0.0",
        private: true,
        type: "module",
        main: "server.js",
        scripts: {
          start: "node server.js"
        },
        engines: {
          node: ">=20"
        }
      }, null, 2);

      const dockerfile = [
        "FROM node:22-alpine",
        "WORKDIR /app",
        "COPY package.json .",
        "COPY server.js .",
        "EXPOSE 443",
        'CMD ["npm", "start"]'
      ].join("\n");

      const railwayJson = JSON.stringify({
        $schema: "https://railway.app/railway.schema.json",
        deploy: {
          startCommand: "npm start",
          restartPolicyType: "ON_FAILURE",
          restartPolicyMaxRetries: 10
        }
      }, null, 2);

      const readme = [
        "# Trendify Nexus TCP Relay",
        "",
        "## Railway Variables",
        "PORT=443",
        "RELAY_SECRET=<secret provided by the installer>",
        "",
        "## Setup",
        "1. Deploy this repository to Railway.",
        "2. Set PORT and RELAY_SECRET.",
        "3. Create a Railway TCP Proxy targeting port 443.",
        "4. Configure the relay host and port in the backend-managed Gateway.",
        "",
        "Keep RELAY_SECRET private."
      ].join("\n");

      
            
      const relaySource = await fetchRelaySource();

      const relayFiles = {
        "server.js": relaySource,
        "package.json": packageJson,
        "Dockerfile": dockerfile,
        "railway.json": railwayJson,
        "README.md": readme
      };

      for (const [path, content] of Object.entries(relayFiles)) {
        await putRepoFile(
          owner,
          relayName,
          path,
          content,
          githubToken
        );
      }



      /*
       * IMPORTANT:
       * No deployWorker() call here.
       * Gateway creation remains the responsibility
       * of the V2 backend.
       */

      return json({
        success: true,
        message: "مخزن بک‌اند و ریلے ساخته شدند.",
        backendRepository,
        relayRepository,
        relaySecret,
        backendFilesCopied: copiedFiles,
        nextSteps: [
          "مخزن بک‌اند ساخته‌شده را در Railway مستقر کن.",
          "PostgreSQL و DATABASE_URL را برای بک‌اند تنظیم کن.",
          "متغیرهای Cloudflare موردنیاز بک‌اند را در Railway تنظیم کن.",
          "مخزن Relay را در Railway مستقر کن.",
          "در Relay متغیرهای PORT=443 و RELAY_SECRET را تنظیم کن.",
          "TCP Proxy را در Railway ایجاد کن.",
          "از طریق بک‌اند، Gateway را ایجاد و تنظیم کن."
        ]
      });

    } catch (error) {
      return json({
        success: false,
        message: error?.message || "Installer failed",
        backendRepository,
        relayRepository
      }, 500);
    }
  }
};
