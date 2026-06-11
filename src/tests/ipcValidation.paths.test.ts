import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validateDownloadPath, validateFfmpegPathValue } from '../utils/ipcValidation';

function pathOutsideAllowedDownloadBases(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp', 'rosi-outside-test');
  }
  return '/tmp/rosi-outside-test';
}

describe('ipc path validation', () => {
  it('accepts home-relative download paths', () => {
    const homeFolder = path.join(os.homedir(), 'Downloads', 'rosi');
    const result = validateDownloadPath(homeFolder);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(path.resolve(homeFolder));
    }
  });

  it('rejects relative download paths', () => {
    const result = validateDownloadPath('relative/downloads');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PATH');
    }
  });

  it('rejects paths outside allowed download bases', () => {
    const result = validateDownloadPath(pathOutsideAllowedDownloadBases());
    expect(result.ok).toBe(false);
  });

  it('accepts empty download path as clear-to-default', () => {
    const result = validateDownloadPath('   ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('');
  });

  it('validates ffmpeg path sentinel and empty values', () => {
    expect(validateFfmpegPathValue(undefined).ok).toBe(true);
    expect(validateFfmpegPathValue('ffmpeg').ok).toBe(true);
    expect(validateFfmpegPathValue('   ').ok).toBe(true);
    expect(validateFfmpegPathValue('relative/ffmpeg').ok).toBe(false);
    expect(validateFfmpegPathValue(path.join(os.homedir(), 'bin', 'ffprobe')).ok).toBe(false);
  });
});
