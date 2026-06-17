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

    it('rejects octal IPv4 encodings of loopback', () => {
      expect(validation.isPrivateOrLocalHost('0177.0.0.1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('0177.0.0.01')).toBe(true);
      expect(validation.isSafeHttpUrl('http://0177.0.0.1/video')).toBe(false);
    });

    it('rejects shorthand (class-A/B/C) IPv4 encodings of loopback', () => {
      expect(validation.isPrivateOrLocalHost('127.1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('127.0.1')).toBe(true);
      expect(validation.isSafeHttpUrl('http://127.1/video')).toBe(false);
    });

    it('rejects per-octet hex IPv4 encodings of loopback', () => {
      expect(validation.isPrivateOrLocalHost('0x7f.0x0.0x0.0x1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('0x7f.0.0.1')).toBe(true);
      expect(validation.isSafeHttpUrl('http://0x7f.0.0.1/video')).toBe(false);
    });

    it('rejects mixed and short encodings of private ranges', () => {
      // 10.0.0.1 as a 32-bit integer and as shorthand.
      expect(validation.isPrivateOrLocalHost('167772161')).toBe(true);
      expect(validation.isPrivateOrLocalHost('10.1')).toBe(true);
      // 169.254.x link-local via decimal of 169.254.0.1.
      expect(validation.isPrivateOrLocalHost('2851995649')).toBe(true);
    });

    it('still allows genuine public hosts and does not misclassify hostnames', () => {
      expect(validation.isPrivateOrLocalHost('8.8.8.8')).toBe(false);
      expect(validation.isPrivateOrLocalHost('example.com')).toBe(false);
      expect(validation.isPrivateOrLocalHost('dead.beef')).toBe(false);
      expect(validation.isSafeHttpUrl('https://example.com/video')).toBe(true);
    });
  });
});
