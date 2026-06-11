import { describe, expect, it } from 'vitest';
import * as validation from '../utils/validation';

describe('validation edge cases', () => {
  describe('isPrivateOrLocalHost', () => {
    it('rejects hex IPv4 literals', () => {
      expect(validation.isPrivateOrLocalHost('0x7f000001')).toBe(true);
      expect(validation.isSafeHttpUrl('http://0x7f000001/video')).toBe(false);
    });

    it('rejects IPv6 loopback and link-local hosts', () => {
      expect(validation.isPrivateOrLocalHost('::1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('fe80::1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('::ffff:127.0.0.1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('::ffff:7f00:1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('fc00::1')).toBe(true);
      expect(validation.isSafeHttpUrl('http://[::1]/video')).toBe(false);
      expect(validation.isSafeHttpUrl('http://[fc00::1]/video')).toBe(false);
    });

    it('rejects localhost subdomains', () => {
      expect(validation.isPrivateOrLocalHost('app.localhost')).toBe(true);
      expect(validation.isSafeHttpUrl('http://app.localhost/video')).toBe(false);
    });
  });
});
