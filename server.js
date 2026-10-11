
import http from "node:http";
import installer from "./index.js";

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || "localhost";

    const request = new Request(
      `${protocol}://${host}${req.url || "/"}`,
      {
        method: req.method,
        headers: req.headers,
        ...(req.method !== "GET" && req.method !== "HEAD"
          ? { body }
          : {})
      }
    );

    const response = await installer.fetch(request);

    res.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries())
    );

    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Installer server error:", error);

    res.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify({
      success: false,
      message: "خطای داخلی Installer"
    }));
  }
});

server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Trendify Nexus Installer is running");
});
