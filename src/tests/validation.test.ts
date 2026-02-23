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

    it('rejects other schemes and invalid input', () => {
      expect(validation.isSafeExternalUrl('file:///tmp/test')).toBe(false);
      expect(validation.isSafeExternalUrl('javascript:alert(1)')).toBe(false);
      expect(validation.isSafeExternalUrl('mailto:support@example.com')).toBe(false);
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
  });
});
