import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { NativeHookJournal, recordNativeHook } from './nativeHookJournal';

describe('native lifecycle checkpoint journal', () => {
  it('keeps queued submissions and an unfinished composer out of the transferable checkpoint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-queue-'));
    const file = path.join(dir, 'events.jsonl');
    const journal = new NativeHookJournal(file, 'conversation-a');
    const hook = (name: string, extra = {}) => recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: name, ...extra });
    try {
      journal.input('First\r');
      journal.input('Queued\r');
      hook('UserPromptSubmit', { prompt: 'First' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      hook('UserPromptSubmit', { prompt: '<task-notification>Background finished</task-notification>' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      hook('UserPromptSubmit', { prompt: 'Queued' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('Unsubmitted draft');
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires a matching structured stop, preserves busy boundaries, and excludes prompt/tool contents', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-hooks-'));
    const file = path.join(dir, 'events.jsonl');
    try {
      const journal = new NativeHookJournal(file, 'conversation-a');
      expect(journal.checkpoint().ready).toBe(false);
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'SessionStart', cwd: '/workspace' });
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_INPUT', permission_mode: 'default' });
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'Stop', background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('Another prompt\r');
      expect(journal.checkpoint().ready).toBe(false);
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'PermissionRequest', tool_input: { key: 'PRIVATE_TOOL' } });
      expect(journal.checkpoint().ready).toBe(false);
      recordNativeHook(file, { session_id: 'conversation-b', hook_event_name: 'Stop', background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      expect(readFileSync(file, 'utf8')).not.toMatch(/PRIVATE_INPUT|PRIVATE_TOOL/);
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'SessionEnd' });
      expect(journal.ended()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
