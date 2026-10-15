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

async function putRepoFile(owner, repo, filePath, base64Content, token) {
  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url =
    "https://api.github.com/repos/" +
    encodeURIComponent(owner) + "/" +
    encodeURIComponent(repo) + "/contents/" +
    encodedPath;

  const existing = await github(url, token);
  let sha;

  if (existing.ok) {
    const current = await existing.json();
    sha = current.sha;
  } else if (existing.status !== 404) {
    throw new Error(
      "GitHub read failed (" + filePath + "): " +
      await existing.text()
    );
  }

  const response = await github(url, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Copy Trendify Nexus V2 backend: " + filePath,
      content: base64Content,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      "GitHub upload failed (" + filePath + "): " +
      await response.text()
    );
  }
}

/* =====================================================
   VLESS GATEWAY SOURCE
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
  if (
    !env.NEXUS_API_URL ||
    !env.NEXUS_GATEWAY_SECRET ||
    !env.GATEWAY_ID
  ) {
    throw new Error("V2 backend authentication variables are missing");
  }

  const endpoint =
    env.NEXUS_API_URL.replace(/\/+$/, "") +
    "/api/internal/gateway/auth?uuid=" +
    encodeURIComponent(uuid) +
    "&gateway_id=" +
    encodeURIComponent(env.GATEWAY_ID);

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
    !env.GATEWAY_ID
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

             // The current Railway relay does not send a handshake byte.
    // Return the VLESS response header before forwarding relay data.
    ws.send(new Uint8Array([parsed.version, 0]));

    socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (closed || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        const data = chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk);

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
   CLOUDFLARE WORKER DEPLOYMENT
===================================================== */

async function deployWorker(
  accountId,
  token,
  workerName,
  source,
  bindings = {},
  secretNames = []
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

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-10",
    bindings: textBindings
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
   INSTALLER API
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

    let repository = null;
    let gatewayUrl = null;
    let repoCreated = false;
    let workerName = null;

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
      const backendUrl = String(body.backendUrl || "")
        .trim()
        .replace(/\/+$/, "");
      const gatewayId = String(body.gatewayId || "").trim();
      const nexusGatewaySecret = String(
        body.nexusGatewaySecret || ""
      ).trim();
      const relayHost = String(body.relayHost || "").trim();
      const relayPort = Number(body.relayPort || 0);
      const relaySecret = String(body.relaySecret || "").trim();
      const sourceRepo = String(
        body.backendRepository ||
        "Trendiify/trendify-nexus-backend"
      ).trim();

      if (
        !githubToken ||
        !cloudflareToken ||
        !accountId ||
        !backendUrl ||
        !/^\d+$/.test(gatewayId) ||
        !nexusGatewaySecret ||
        !relayHost ||
        !Number.isInteger(relayPort) ||
        relayPort < 1 ||
        relayPort > 65535 ||
        relaySecret.length < 16 ||
        relaySecret.length > 256
      ) {
        return json({
          success: false,
          message:
            "اطلاعات GitHub، Cloudflare، بک‌اند، Gateway ID و Relay را کامل و صحیح وارد کن."
        }, 400);
      }

      if (!/^https:\/\//i.test(backendUrl)) {
        return json({
          success: false,
          message: "آدرس بک‌اند باید با https:// شروع شود."
        }, 400);
      }

      if (
        !/^[a-zA-Z0-9.-]+$/.test(relayHost) ||
        relayHost.length > 253
      ) {
        return json({
          success: false,
          message: "آدرس Relay معتبر نیست."
        }, 400);
      }

      /* 1. Verify Cloudflare token */
      const tokenCheck = await cf(
        "/user/tokens/verify",
        cloudflareToken
      );

      if (tokenCheck.status !== "active") {
        throw new Error("Cloudflare API Token فعال نیست.");
      }

      /* 2. Verify GitHub token */
      const userResponse = await github(
        "https://api.github.com/user",
        githubToken
      );

      if (!userResponse.ok) {
        throw new Error(
          "GitHub Token معتبر نیست یا دسترسی لازم را ندارد."
        );
      }

      const githubUser = await userResponse.json();
      const owner = githubUser.login;

      /* 3. Get workers.dev subdomain */
      const accountInfo = await cf(
        "/accounts/" + encodeURIComponent(accountId) +
        "/workers/subdomain",
        cloudflareToken
      );

      const subdomain = accountInfo.subdomain;

      if (!subdomain) {
        throw new Error(
          "ابتدا دامنه workers.dev را برای این حساب Cloudflare فعال کن."
        );
      }

      /* 4. Verify backend authentication endpoint */
      const authProbe = await fetch(
        backendUrl +
        "/api/internal/gateway/auth?uuid=" +
        encodeURIComponent("00000000-0000-4000-8000-000000000000") +
        "&gateway_id=" +
        encodeURIComponent(gatewayId),
        {
          headers: {
            "X-Nexus-Gateway-Secret": nexusGatewaySecret
          }
        }
      );

      if (authProbe.status === 401) {
        throw new Error(
          "Secret بک‌اند اشتباه است یا با NEXUS_GATEWAY_SECRET یکی نیست."
        );
      }

      if (!authProbe.ok) {
        throw new Error(
          "مسیر احراز هویت بک‌اند پاسخ معتبر نداد: " +
          authProbe.status
        );
      }

      const probeData = await authProbe.json().catch(() => null);

      if (
        !probeData ||
        typeof probeData.authorized !== "boolean"
      ) {
        throw new Error(
          "پاسخ احراز هویت با نسخه V2 بک‌اند سازگار نیست."
        );
      }

      /* 5. Validate source repository */
      const src = sourceRepo.split("/");

      if (
        src.length !== 2 ||
        !src[0] ||
        !src[1]
      ) {
        throw new Error(
          "ریپازیتوری بک‌اند باید به شکل owner/repo باشد."
        );
      }

      const sourceMetaRes = await github(
        "https://api.github.com/repos/" +
        encodeURIComponent(src[0]) + "/" +
        encodeURIComponent(src[1]),
        githubToken
      );

      if (!sourceMetaRes.ok) {
        throw new Error(
          "ریپازیتوری مبدا قابل خواندن نیست: " +
          await sourceMetaRes.text()
        );
      }

      const sourceMeta = await sourceMetaRes.json();
      const branch = sourceMeta.default_branch || "main";

      const treeRes = await github(
        "https://api.github.com/repos/" +
        encodeURIComponent(src[0]) + "/" +
        encodeURIComponent(src[1]) +
        "/git/trees/" +
        encodeURIComponent(branch) +
        "?recursive=1",
        githubToken
      );

      if (!treeRes.ok) {
        throw new Error(
          "خواندن فهرست فایل‌های بک‌اند ناموفق بود: " +
          await treeRes.text()
        );
      }

      const tree = await treeRes.json();

      if (tree.truncated) {
        throw new Error(
          "فهرست فایل‌های ریپازیتوری بیش از حد بزرگ است؛ کپی خودکار متوقف شد."
        );
      }

      const blocked =
        /(^|\/)(\.git|node_modules|\.env(?:\..*)?|coverage|\.wrangler)(\/|$)|(^|\/)(\.DS_Store|npm-debug\.log)$/i;

      const sourceFiles = (tree.tree || []).filter(
        file =>
          file.type === "blob" &&
          !blocked.test(file.path)
      );

      if (!sourceFiles.length) {
        throw new Error(
          "هیچ فایل قابل کپی در ریپازیتوری مبدا پیدا نشد."
        );
      }

      /* 6. Create private destination repository */
      const repoName = "trendify-nexus-v2-" + randomHex(5);

      const createRepo = await github(
        "https://api.github.com/user/repos",
        githubToken,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: repoName,
            description:
              "Trendify Nexus V2 backend copy created by installer",
            private: true,
            auto_init: true
          })
        }
      );

      if (!createRepo.ok) {
        throw new Error(
          "ساخت ریپازیتوری خصوصی ناموفق بود: " +
          await createRepo.text()
        );
      }

      repoCreated = true;
      repository =
        "https://github.com/" + owner + "/" + repoName;

      /* 7. Copy source files without Base64 corruption */
      for (const file of sourceFiles) {
        const contentUrl =
          "https://api.github.com/repos/" +
          encodeURIComponent(src[0]) + "/" +
          encodeURIComponent(src[1]) + "/contents/" +
          file.path
            .split("/")
            .map(encodeURIComponent)
            .join("/") +
          "?ref=" + encodeURIComponent(branch);

        const contentRes = await github(
          contentUrl,
          githubToken
        );

        if (!contentRes.ok) {
          throw new Error(
            "خواندن فایل " + file.path + " ناموفق بود: " +
            await contentRes.text()
          );
        }

        const contentJson = await contentRes.json();

        if (
          contentJson.type !== "file" ||
          typeof contentJson.content !== "string"
        ) {
          throw new Error(
            "محتوای فایل از GitHub دریافت نشد: " +
            file.path
          );
        }

        const base64Content =
          contentJson.content.replace(/\s/g, "");

        if (!base64Content) {
          throw new Error(
            "محتوای فایل خالی یا غیرقابل‌خواندن است: " +
            file.path
          );
        }

        await putRepoFile(
          owner,
          repoName,
          file.path,
          base64Content,
          githubToken
        );
      }

      /* 8. Deploy Cloudflare Gateway Worker */
      workerName = "nexus-gw-" + randomHex(5);
      gatewayUrl =
        "https://" + workerName + "." +
        subdomain + ".workers.dev";

      await deployWorker(
        accountId,
        cloudflareToken,
        workerName,
        GATEWAY_SOURCE,
        {
          RELAY_HOST: relayHost,
          RELAY_PORT: String(relayPort),
          RELAY_SECRET: relaySecret,
          GATEWAY_ID: gatewayId,
          GATEWAY_REGION: String(body.region || "eu"),
          NEXUS_API_URL: backendUrl,
          NEXUS_GATEWAY_SECRET: nexusGatewaySecret
        },
        [
          "RELAY_SECRET",
          "NEXUS_GATEWAY_SECRET"
        ]
      );

      return json({
        success: true,
        message:
          "ریپازیتوری بک‌اند کپی شد و Gateway Worker ایجاد شد.",
        backendRepository: repository,
        sourceBackendRepository: sourceRepo,
        gatewayName: workerName,
        gatewayUrl,
        gatewayId: Number(gatewayId),
        relay: {
          host: relayHost,
          port: relayPort,
          configured: true
        },
        nextSteps: [
          "ریپازیتوری خصوصی بک‌اند را در میزبان بک‌اند خودت Deploy کن؛ اینستالر سرویس Railway نمی‌سازد.",
          "Gateway ID باید مربوط به Gateway واقعی و فعال در دیتابیس V2 باشد.",
          "مسیر WebSocket گیتوی: " + gatewayUrl + "/ws",
          "مقادیر Secret در تنظیمات Worker ثبت می‌شوند و داخل ریپازیتوری قرار نمی‌گیرند."
        ]
      });
    } catch (error) {
      return json({
        success: false,
        message: error?.message || "Installer failed",
        repositoryMayHaveBeenCreated: repoCreated,
        repository,
        workerName,
        gatewayUrl
      }, 500);
    }
  }
};
