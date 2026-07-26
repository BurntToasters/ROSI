import { app, Menu, shell, type BrowserWindow } from 'electron';
import type { MenuAction } from '../types';

const DOCS_URL = 'https://github.com/BurntToasters/ROSI#readme';
const ISSUES_URL = 'https://github.com/BurntToasters/ROSI/issues';

export interface AppMenuOptions {
  getMainWindow: () => BrowserWindow | null;
  isMsStore: boolean;
}

function sendMenuAction(win: BrowserWindow | null, action: MenuAction): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('menu-action', action);
}

export function configureAboutPanel(): void {
  if (process.platform !== 'darwin') return;
  app.setAboutPanelOptions({
    applicationName: 'ROSI',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: 'Copyright © BurntToasters',
  });
}

export function buildDarwinApplicationMenu(options: AppMenuOptions): Menu {
  const { getMainWindow, isMsStore } = options;

  const rosieMenuItems: Electron.MenuItemConstructorOptions[] = [
    { role: 'about' },
    { type: 'separator' },
    {
      label: 'Settings…',
      accelerator: 'Cmd+,',
      click: () => sendMenuAction(getMainWindow(), 'open-settings'),
    },
  ];

  if (!isMsStore) {
    rosieMenuItems.push({
      label: 'Check for Updates…',
      click: () => sendMenuAction(getMainWindow(), 'check-for-updates'),
    });
  }

  rosieMenuItems.push(
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' }
  );

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: rosieMenuItems,
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          click: () => sendMenuAction(getMainWindow(), 'toggle-sidebar'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => {
            void shell.openExternal(DOCS_URL);
          },
        },
        {
          label: 'Report an Issue',
          click: () => {
            void shell.openExternal(ISSUES_URL);
          },
        },
        { type: 'separator' },
        {
          label: 'View Licenses',
          click: () => sendMenuAction(getMainWindow(), 'show-licenses'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installDarwinApplicationMenu(options: AppMenuOptions): void {
  if (process.platform !== 'darwin') return;
  configureAboutPanel();
  Menu.setApplicationMenu(buildDarwinApplicationMenu(options));
}
