// openfront v2: one local port for the Cloudflare tunnel.
// Does what nginx.conf does on a real server, without nginx:
//   /w<n>/...         -> game worker n (port 3001+n), prefix stripped
//   /api/create_game  -> a random game worker
//   everything else   -> master (port 3000: page, assets, lobbies, maps)
// WebSockets are forwarded the same way. No dependencies.
import http from "node:http";
import net from "node:net";

const LISTEN_PORT = Number(process.env.ROUTER_PORT ?? 8080);
const NUM_WORKERS = Number(process.env.NUM_WORKERS ?? 2);
const MASTER_PORT = 3000;

function route(url) {
  const m = /^\/w(\d+)(\/[^?]*)?(\?.*)?$/.exec(url);
  if (m && Number(m[1]) < NUM_WORKERS) {
    return { port: 3001 + Number(m[1]), path: (m[2] ?? "/") + (m[3] ?? "") };
  }
  if (url === "/api/create_game" || url.startsWith("/api/create_game?")) {
    const n = Math.floor(Math.random() * NUM_WORKERS);
    return { port: 3001 + n, path: url };
  }
  return { port: MASTER_PORT, path: url };
}

function forwardedHeaders(req) {
  const headers = { ...req.headers };
  const ip = req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${ip}`
    : ip;
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "https";
  return headers;
}

const server = http.createServer((req, res) => {
  const target = route(req.url ?? "/");
  const proxyReq = http.request(
    {
      host: "127.0.0.1",
      port: target.port,
      path: target.path,
      method: req.method,
      headers: forwardedHeaders(req),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(
      `openfront router: port ${target.port} not reachable (${err.code})`,
    );
  });
  req.pipe(proxyReq);
});

// WebSockets: replay the upgrade request to the target and splice the sockets.
server.on("upgrade", (req, socket, head) => {
  const target = route(req.url ?? "/");
  // Game traffic is a stream of small messages (turns every 100 ms, clicks):
  // with Nagle's algorithm on, a small write waits for the previous one's
  // ACK, and Windows delays ACKs by up to 200 ms. Send every message at once.
  socket.setNoDelay(true);
  const upstream = net.connect(target.port, "127.0.0.1", () => {
    upstream.setNoDelay(true);
    const headers = forwardedHeaders(req);
    let raw = `${req.method} ${target.path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const value of Array.isArray(v) ? v : [v])
        raw += `${k}: ${value}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`openfront router on http://localhost:${LISTEN_PORT}`);
});
