import { describe, expect, it, vi } from 'vitest';

interface MenuItem {
  label?: string;
  submenu?: MenuItem[];
  click?: () => void;
}

const templateStore: { template: MenuItem[] | null } = { template: null };
const openExternal = vi.fn();

vi.mock('electron', () => ({
  app: { name: 'ROSI', getVersion: () => '4.3.0' },
  shell: { openExternal },
  Menu: {
    buildFromTemplate: (template: MenuItem[]) => {
      templateStore.template = template;
      return {};
    },
  },
}));

function menuItem(label: string): MenuItem {
  const pending = [...(templateStore.template ?? [])];
  while (pending.length > 0) {
    const item = pending.shift();
    if (item?.label === label) return item;
    if (item?.submenu) pending.push(...item.submenu);
  }
  throw new Error(`Menu item not found: ${label}`);
}

describe('appMenu', () => {
  it('omits Check for Updates on Microsoft Store builds', async () => {
    const { buildDarwinApplicationMenu } = await import('../main/appMenu');
    buildDarwinApplicationMenu({
      getMainWindow: () => null,
      isMsStore: true,
    });
    const appMenu = templateStore.template?.[0];
    const labels = (appMenu?.submenu ?? []).map((item) => item.label).filter(Boolean);
    expect(labels).not.toContain('Check for Updates…');
    expect(labels).toContain('Settings…');
  });

  it('includes Check for Updates on GitHub builds', async () => {
    const { buildDarwinApplicationMenu } = await import('../main/appMenu');
    buildDarwinApplicationMenu({
      getMainWindow: () => null,
      isMsStore: false,
    });
    const appMenu = templateStore.template?.[0];
    const labels = (appMenu?.submenu ?? []).map((item) => item.label).filter(Boolean);
    expect(labels).toContain('Check for Updates…');
  });

  it('routes custom actions to the window and opens help links', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
    };
    const { buildDarwinApplicationMenu } = await import('../main/appMenu');
    buildDarwinApplicationMenu({
      getMainWindow: () => mainWindow as never,
      isMsStore: false,
    });

    menuItem('Settings…').click?.();
    menuItem('Check for Updates…').click?.();
    menuItem('Toggle Sidebar').click?.();
    menuItem('View Licenses').click?.();
    menuItem('Documentation').click?.();
    menuItem('Report an Issue').click?.();

    expect(send.mock.calls).toEqual([
      ['menu-action', 'open-settings'],
      ['menu-action', 'check-for-updates'],
      ['menu-action', 'toggle-sidebar'],
      ['menu-action', 'show-licenses'],
    ]);
    expect(openExternal.mock.calls).toEqual([
      ['https://github.com/BurntToasters/ROSI#readme'],
      ['https://github.com/BurntToasters/ROSI/issues'],
    ]);
  });

  it('does not dispatch actions without a live window', async () => {
    const send = vi.fn();
    const { buildDarwinApplicationMenu } = await import('../main/appMenu');

    buildDarwinApplicationMenu({ getMainWindow: () => null, isMsStore: true });
    menuItem('Settings…').click?.();

    buildDarwinApplicationMenu({
      getMainWindow: () => ({ isDestroyed: () => true, webContents: { send } }) as never,
      isMsStore: true,
    });
    menuItem('Toggle Sidebar').click?.();

    expect(send).not.toHaveBeenCalled();
  });
});
