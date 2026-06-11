import { describe, it, expect } from 'vitest';
import * as validation from '../utils/validation';

describe('validation helpers', () => {
  describe('isSafeHttpUrl', () => {
    it('accepts http/https URLs', () => {
      expect(validation.isSafeHttpUrl('http://example.com')).toBe(true);
      expect(validation.isSafeHttpUrl('https://example.com/path?q=1')).toBe(true);
      expect(validation.isSafeHttpUrl('HTTPS://example.com')).toBe(true);
      expect(validation.isSafeHttpUrl('  https://example.com  ')).toBe(true);
    });

    it('rejects non-http(s) URLs and invalid input', () => {
      expect(validation.isSafeHttpUrl('ftp://example.com')).toBe(false);
      expect(validation.isSafeHttpUrl('file:///tmp/test')).toBe(false);
      expect(validation.isSafeHttpUrl('/relative/path')).toBe(false);
      expect(validation.isSafeHttpUrl('not a url')).toBe(false);
      expect(validation.isSafeHttpUrl('')).toBe(false);
      expect(validation.isSafeHttpUrl(null)).toBe(false);
    });

    it('rejects private and local hosts', () => {
      expect(validation.isSafeHttpUrl('http://localhost/video')).toBe(false);
      expect(validation.isSafeHttpUrl('http://127.0.0.1/video')).toBe(false);
      expect(validation.isSafeHttpUrl('http://192.168.1.1/video')).toBe(false);
      expect(validation.isSafeHttpUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    });

    it('rejects decimal IPv4 host literals', () => {
      expect(validation.isSafeHttpUrl('http://2130706433/video')).toBe(false);
    });

    it('rejects DNS rebinding hostnames', () => {
      expect(validation.isSafeHttpUrl('http://127.0.0.1.nip.io/video')).toBe(false);
      expect(validation.isSafeHttpUrl('http://app.localtest.me/video')).toBe(false);
      expect(validation.isPrivateOrLocalHost('evil.nip.io')).toBe(true);
      expect(validation.isPrivateOrLocalHost('tenant.sslip.io')).toBe(true);
    });
  });

  describe('isPrivateOrLocalHost', () => {
    it('detects local and private hosts', () => {
      expect(validation.isPrivateOrLocalHost('localhost')).toBe(true);
      expect(validation.isPrivateOrLocalHost('127.0.0.1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('10.0.0.1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('192.168.0.1')).toBe(true);
      expect(validation.isPrivateOrLocalHost('169.254.169.254')).toBe(true);
      expect(validation.isPrivateOrLocalHost('example.com')).toBe(false);
    });
  });

  describe('isSafeExternalUrl', () => {
    it('accepts http/https and ms-windows-store URLs', () => {
      expect(validation.isSafeExternalUrl('https://example.com')).toBe(true);
      expect(validation.isSafeExternalUrl('http://example.com')).toBe(true);
      expect(validation.isSafeExternalUrl('ms-windows-store://pdp/?ProductId=9N0BQSTFL4SV')).toBe(
        true
      );
      expect(validation.isSafeExternalUrl('MS-WINDOWS-STORE://pdp/?ProductId=9N0BQSTFL4SV')).toBe(
        true
      );
    });

    it('accepts mailto links', () => {
      expect(validation.isSafeExternalUrl('mailto:support@example.com')).toBe(true);
      expect(validation.isSafeExternalUrl('  mailto:help@rosie.run  ')).toBe(true);
    });

    it('rejects other schemes and invalid input', () => {
      expect(validation.isSafeExternalUrl('file:///tmp/test')).toBe(false);
      expect(validation.isSafeExternalUrl('javascript:alert(1)')).toBe(false);
      expect(validation.isSafeExternalUrl('not a url')).toBe(false);
      expect(validation.isSafeExternalUrl('')).toBe(false);
      expect(validation.isSafeExternalUrl(undefined)).toBe(false);
    });
  });

  describe('isAllowedNavigationUrl', () => {
    it('only allows file URLs', () => {
      expect(validation.isAllowedNavigationUrl('file:///C:/app/index.html')).toBe(true);
      expect(validation.isAllowedNavigationUrl('file:///Users/test/app/index.html')).toBe(true);
      expect(validation.isAllowedNavigationUrl('https://example.com')).toBe(false);
      expect(validation.isAllowedNavigationUrl('javascript:alert(1)')).toBe(false);
      expect(validation.isAllowedNavigationUrl('')).toBe(false);
    });

    it('restricts file URLs to an allowed base when provided', () => {
      const base = '/Users/test/app';
      expect(validation.isAllowedNavigationUrl('file:///Users/test/app/index.html', base)).toBe(
        true
      );
      expect(validation.isAllowedNavigationUrl('file:///Users/test/other/index.html', base)).toBe(
        false
      );
    });
  });
});
