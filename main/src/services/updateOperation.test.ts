import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimUpdateLock, releaseUpdateLock, executeUpdate, readUpdateJournal, writeUpdateJson } from '../../../packages/runpane/src/updateOperation';

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-update-test-'));
  directories.push(directory);
  const file = path.join(directory, 'status.json');
  writeUpdateJson(file, { id: 'test', host: 'isolated', scope: 'both', version: '2.4.182', phase: 'accepted', completed: [], updatedAt: new Date().toISOString(), appUpdated: false, cliUpdated: false, hostReachable: false, restored: [] });
  return { directory, file };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe('durable update operation', () => {
  it('acknowledges the independent helper before staging and never stops after staging fails', async () => {
    const { file } = fixture();
    const seen: string[] = [];
    const result = await executeUpdate(file, { run: async step => {
      expect(readUpdateJournal(file).helperPid).toBe(process.pid);
      seen.push(step);
      throw new Error('signature mismatch');
    } });
    expect(seen).toEqual(['stage']);
    expect(result.phase).toBe('failed');
    expect(result.appUpdated).toBe(false);
  });
  it('keeps a post-shutdown failure inspectable without rolling data back', async () => {
    const { file } = fixture();
    const result = await executeUpdate(file, { run: async step => {
      if (step === 'health') throw new Error('new daemon is unreachable');
      return step === 'install' ? { appUpdated: true } : {};
    } });
    expect(result.phase).toBe('needs-attention');
    expect(result.appUpdated).toBe(true);
    expect(result.hostReachable).toBe(false);
  });
  it('resumes an interrupted operation without repeating completed effects', async () => {
    const { file } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), completed: ['stage', 'checkpoint', 'stop', 'snapshot', 'install'], phase: 'launch' });
    const seen: string[] = [];
    await executeUpdate(file, { run: async step => { seen.push(step); return {}; } });
    expect(seen).toEqual(['launch', 'health', 'restore']);
  });
  it('returns the existing operation when a second caller claims the host', () => {
    const { file, directory } = fixture();
    const lock = path.join(directory, 'lock');
    expect(claimUpdateLock(lock, 'first', file).acquired).toBe(true);
    expect(claimUpdateLock(lock, 'second', 'different')).toEqual({ id: 'first', statusFile: file, acquired: false });
  });
  it('never releases a newer operation when an old helper exits twice', () => {
    const { file, directory } = fixture();
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    releaseUpdateLock(lock, 'first');
    claimUpdateLock(lock, 'second', file);
    releaseUpdateLock(lock, 'first');
    expect(claimUpdateLock(lock, 'third', file)).toMatchObject({ acquired: false, id: 'second' });
  });
  it('honors caller failure before the helper can shut down Pane', async () => {
    const { file } = fixture();
    const seen: string[] = [];
    const result = await executeUpdate(file, { run: async step => {
      seen.push(step);
      writeUpdateJson(file, { ...readUpdateJournal(file), phase: 'failed', error: 'Caller canceled queued supervisor' });
      return {};
    } });
    expect(seen).toEqual(['stage']);
    expect(result.phase).toBe('failed');
  });

});
