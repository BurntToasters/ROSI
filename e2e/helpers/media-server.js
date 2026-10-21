import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

/**
 * Deterministic pseudo-random payload so every run downloads byte-identical
 * files and the evidence report can pin their SHA-256 values.
 */
export function deterministicBytes(size, seed) {
  const out = Buffer.alloc(size);
  let offset = 0;
  let counter = 0;
  while (offset < size) {
    const block = crypto
      .createHash("sha256")
      .update(`${seed}:${counter}`)
      .digest();
    block.copy(out, offset, 0, Math.min(block.length, size - offset));
    offset += block.length;
    counter += 1;
  }
  return out;
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Serve fixtures as direct media downloads. `slow` routes trickle bytes so a
 * download stays in flight long enough to be cancelled.
 */
export async function startMediaServer(routes) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname });
    const route = routes[url.pathname];
    if (!route) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    const body = route.file ? fs.readFileSync(route.file) : route.body;
    let start = 0;
    let end = body.length - 1;
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const headers = {
      "Content-Type": route.contentType ?? "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), end) : end;
      headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const slice = body.subarray(start, end + 1);
    if (!route.slow) {
      response.end(slice);
      return;
    }
    let position = 0;
    const timer = setInterval(() => {
      if (response.destroyed || position >= slice.length) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(slice.subarray(position, position + 16 * 1024));
      position += 16 * 1024;
    }, 250);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
