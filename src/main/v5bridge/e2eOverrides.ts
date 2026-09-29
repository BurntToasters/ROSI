/**
 * Test-only switches for bridge E2E builds, applied before any module reads
 * userData. Production config.json has no `e2e` block, which
 * build-scripts/check-bridge-config.js enforces before every build.
 * Must be the first import in main.ts.
 */
import * as path from 'path';
import { app } from 'electron';
import { bridgeConfig } from './config';

const e2e = bridgeConfig().e2e;
if (e2e) {
  if (e2e.userDataDir) {
    app.setPath('userData', e2e.userDataDir);
    app.setAppLogsPath(path.join(e2e.userDataDir, 'logs'));
  }
  if (e2e.remoteDebuggingPort) {
    app.commandLine.appendSwitch('remote-debugging-port', String(e2e.remoteDebuggingPort));
    app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1');
  }
  if (e2e.useMockKeychain) app.commandLine.appendSwitch('use-mock-keychain');
}
