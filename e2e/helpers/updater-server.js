// Local update server for the updater E2E. It serves static-format manifests
// (`latest-{target}.json`) and signed payloads, signed with a key the scenario
// generated at test time. Routes are set per scenario, and every request is
// logged so specs can assert which feed records the engine asked for.
import http from "node:http";
import { manifestSignature, signUpdateArtifact } from "./updater-signing.js";

/**
 * Starts the server on 127.0.0.1 with an ephemeral port.
 * `key` comes from generateUpdaterSigningKey().
 */
export async function startUpdaterServer({ key }) {
  const routes = new Map();
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push({ path: pathname, at: Date.now() });
    const route = routes.get(pathname);
    if (!route) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    const send = () => {
      if (route.truncate) {
        // Promise the whole body, deliver half, then drop the connection.
        response.writeHead(200, {
          "Content-Type": route.contentType,
          "Content-Length": Buffer.byteLength(route.body) * 2,
        });
        response.write(
          route.body.subarray(0, Math.floor(route.body.length / 2)),
        );
        setTimeout(() => response.destroy(), 50);
        return;
      }
      response.writeHead(route.status ?? 200, {
        "Content-Type": route.contentType,
        "Content-Length": Buffer.byteLength(route.body),
      });
      response.end(route.body);
    };
    if (route.gate) {
      // The response is held until the scenario releases it.
      route.gate.then(send);
    } else {
      send();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * Serves a signed manifest that points at `payload`. `target` is the platform
   * key inside the manifest; `route` is the name in `latest-{route}.json`
   * (defaults to `target`). With no explicit target the engine requests the
   * OS name only, e.g. `latest-darwin.json`, and then looks up `{os}-{arch}`.
   * `gate` holds the artifact response and `manifestGate` holds the manifest
   * response until the scenario resolves the promise.
   */
  function publish({
    target,
    route = target,
    version,
    payload,
    fileName,
    gate = null,
    manifestGate = null,
  }) {
    const artifactPath = `/artifacts/${fileName}`;
    routes.set(artifactPath, {
      contentType: "application/octet-stream",
      body: payload,
      gate,
    });
    const signature = manifestSignature(
      signUpdateArtifact(key, payload, { fileName, version }),
    );
    const manifest = {
      version,
      notes: `Controlled ${version}`,
      pub_date: new Date().toISOString(),
      platforms: {
        [target]: { url: `${base}${artifactPath}`, signature },
      },
    };
    routes.set(`/latest-${route}.json`, {
      contentType: "application/json",
      body: JSON.stringify(manifest),
      gate: manifestGate,
    });
    return manifest;
  }

  /** Answers the target's manifest with a status code (404 for a missing feed). */
  function respond(target, status, body = "") {
    routes.set(`/latest-${target}.json`, {
      status,
      contentType: "text/plain",
      body,
    });
  }

  /** Serves `bytes` for an artifact that was signed as something else. */
  function tamper(fileName, bytes) {
    const artifact = routes.get(`/artifacts/${fileName}`);
    routes.set(`/artifacts/${fileName}`, { ...artifact, body: bytes });
  }

  /** Makes the artifact drop after half its body. */
  function truncate(fileName) {
    const artifact = routes.get(`/artifacts/${fileName}`);
    routes.set(`/artifacts/${fileName}`, { ...artifact, truncate: true });
  }

  /** Removes a route so the feed answers 404 again. */
  function unpublish(target) {
    routes.delete(`/latest-${target}.json`);
  }

  return {
    base,
    /** The endpoint template handed to e2e_configure_updater. */
    endpoint: `${base}/latest-{{target}}.json`,
    requests,
    publish,
    respond,
    unpublish,
    tamper,
    truncate,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
