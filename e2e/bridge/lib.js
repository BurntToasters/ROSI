/** Small helpers for the bridge E2E driver: CDP, HTTP feed, processes, polling. */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeout = 60_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `Timed out waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`
  );
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Local HTTP feed. `routes` maps URL paths to { file } or { body, type }. */
function startFeed(port) {
  const routes = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    const route = routes.get(url.pathname);
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    if (route.file) {
      const size = fs.statSync(route.file).size;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
      fs.createReadStream(route.file).pipe(res);
      return;
    }
    const body = Buffer.from(route.body);
    res.writeHead(200, {
      'content-type': route.type || 'application/json',
      'content-length': body.length,
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        routes,
        requests,
        count: (pathname) => requests.filter((item) => item === pathname).length,
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

/** Evaluate an expression in the ROSI 4 main window over the DevTools protocol. */
async function cdpEvaluate(port, expression, timeout = 30_000) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error(`no main window target yet (${targets.map((t) => t.url).join(', ')})`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('DevTools websocket failed'));
  });
  try {
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      })
    );
    const reply = await Promise.race([
      new Promise((resolve) => {
        ws.onmessage = (message) => {
          const data = JSON.parse(message.data);
          if (data.id === 1) resolve(data);
        };
      }),
      sleep(timeout).then(() => {
        throw new Error('DevTools evaluate timed out');
      }),
    ]);
    const details = reply.result?.exceptionDetails;
    if (details) throw new Error(details.exception?.description || details.text);
    return reply.result?.result?.value;
  } finally {
    ws.close();
  }
}

const MODAL_STATE = `(() => {
  const modal = document.getElementById('app-modal');
  if (!modal || !modal.classList.contains('active')) return null;
  return {
    title: document.getElementById('modal-title')?.textContent ?? '',
    message: document.getElementById('modal-message')?.textContent ?? '',
    buttons: [...document.querySelectorAll('#modal-buttons button')].map((b) => b.textContent),
  };
})()`;

async function waitForModal(port, titlePattern, timeout = 60_000) {
  return waitFor(
    `modal ${titlePattern}`,
    async () => {
      const modal = await cdpEvaluate(port, MODAL_STATE);
      return modal && titlePattern.test(modal.title) ? modal : null;
    },
    { timeout }
  );
}

async function clickModalButton(port, label, before = '') {
  const clicked = await cdpEvaluate(
    port,
    `(() => { ${before}
      const button = [...document.querySelectorAll('#modal-buttons button')].find((b) => b.textContent === ${JSON.stringify(label)});
      if (!button) return false;
      button.click();
      return true;
    })()`
  );
  if (!clicked) throw new Error(`modal button "${label}" not found`);
}

/** Click a modal button and wait until the modal has finished closing. */
async function dismissModal(port, label) {
  await clickModalButton(port, label);
  await waitFor('modal to close', async () => (await cdpEvaluate(port, MODAL_STATE)) === null, {
    timeout: 10_000,
    interval: 200,
  });
  await sleep(500);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

function powershell(script) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return result.stdout.trim();
}

/** Processes whose executable lives under `dir`. */
function processesUnder(dir) {
  if (process.platform === 'win32') {
    const out = powershell(
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psQuote(dir)}, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`
    );
    return out ? out.split(/\r?\n/).map((line) => line.split('|')) : [];
  }
  const out = run('ps', ['-Ao', 'pid=,comm='], { check: false }).stdout;
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].startsWith(dir))
    .map((m) => [m[1], m[2]]);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = {
  sleep,
  waitFor,
  sha256File,
  startFeed,
  cdpEvaluate,
  waitForModal,
  clickModalButton,
  dismissModal,
  run,
  powershell,
  psQuote,
  processesUnder,
  MODAL_STATE,
  path,
};
