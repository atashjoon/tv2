```js
import http from "node:http";
import installer from "./index.js";

const PORT = Number(process.env.PORT || 3000);

function getRequestHeaders(headers) {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;

    // These are managed by the HTTP server/fetch implementation.
    if (
      ["connection", "host", "content-length", "transfer-encoding"]
        .includes(name.toLowerCase())
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(name, item);
      }
    } else {
      result.set(name, String(value));
    }
  }

  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);

    const forwardedProto = String(
      req.headers["x-forwarded-proto"] || "https"
    ).split(",")[0].trim();

    const protocol =
      forwardedProto === "http" ? "http" : "https";

    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `${protocol}://${host}`);

    const method = String(req.method || "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    const request = new Request(url, {
      method,
      headers: getRequestHeaders(req.headers),
      ...(hasBody && body.length > 0 ? { body } : {})
    });

    const response = await installer.fetch(request);

    const responseHeaders = Object.fromEntries(
      response.headers.entries()
    );

    res.writeHead(response.status, responseHeaders);

    if (method === "HEAD" || response.status === 204 ||
        response.status === 304) {
      res.end();
      return;
    }

    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Installer server error:", error);

    if (res.headersSent) {
      res.destroy();
      return;
    }

    res.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });

    res.end(JSON.stringify({
      success: false,
      message: "خطای داخلی Installer"
    }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trendify Nexus Installer is running on port ${PORT}`);
});

server.on("error", error => {
  console.error("Installer HTTP server error:", error);
});
```
