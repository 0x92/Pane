import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUpdateDirectoryWritable } from '../../../packages/runpane/src/updatePreflight';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
describe('update directory permissions', () => {
  it('proves create, write, rename and cleanup without leaving a probe', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-preflight-'));
    directories.push(directory);
    assertUpdateDirectoryWritable(directory);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('rejects a Windows-style ACL denial even when access would report writable', () => {
    vi.spyOn(fs, 'accessSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw Object.assign(new Error('Access is denied'), { code: 'EACCES' }); });
    expect(() => assertUpdateDirectoryWritable('owned-install')).toThrow(expect.objectContaining({
      code: 'ERR_UPDATE_PREFLIGHT',
      next: expect.stringContaining('Pane has not been stopped'),
    }));
  });
});

describe('snapshot capacity before downtime', () => {
  it('rejects a snapshot that exceeds actual available capacity', async () => {
    const { assertUpdateCapacity } = await import('../../../packages/runpane/src/updateCapacity');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-capacity-'));
    directories.push(directory);
    const disk = fs.statfsSync(directory);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ ...disk, bavail: 1, bsize: 4096 });
    expect(() => assertUpdateCapacity(directory, { paneDir: directory, userData: directory }, directory)).toThrow(expect.objectContaining({ code: 'ERR_UPDATE_DISK_SPACE' }));
  });
});
