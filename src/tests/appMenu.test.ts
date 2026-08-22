import { describe, expect, it, vi } from 'vitest';

const templateStore: { template: unknown[] | null } = { template: null };

vi.mock('electron', () => ({
  app: { name: 'ROSI', getVersion: () => '4.3.0' },
  shell: { openExternal: vi.fn() },
  Menu: {
    buildFromTemplate: (template: unknown[]) => {
      templateStore.template = template;
      return {};
    },
  },
}));

describe('appMenu', () => {
  it('omits Check for Updates on Microsoft Store builds', async () => {
    const { buildDarwinApplicationMenu } = await import('../main/appMenu');
    buildDarwinApplicationMenu({
      getMainWindow: () => null,
      isMsStore: true,
    });
    const appMenu = (
      templateStore.template as { label?: string; submenu?: { label?: string }[] }[]
    )[0];
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
    const appMenu = (templateStore.template as { submenu?: { label?: string }[] }[])[0];
    const labels = (appMenu?.submenu ?? []).map((item) => item.label).filter(Boolean);
    expect(labels).toContain('Check for Updates…');
  });
});
