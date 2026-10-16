import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { RunpaneError } from './errors';

const UPDATE_STEPS = ['stage', 'checkpoint', 'stop', 'snapshot', 'install', 'launch', 'health', 'restore'] as const;
type UpdateStep = typeof UPDATE_STEPS[number];
const phaseSchema = boundary.enumeration('accepted', ...UPDATE_STEPS, 'complete', 'needs-attention', 'failed');
const journalSchema = boundary.object({
  id: boundary.nonEmptyString,
  host: boundary.nonEmptyString,
  scope: boundary.enumeration('both', 'pane', 'cli'),
  version: boundary.nonEmptyString,
  phase: phaseSchema,
  completed: boundary.array(boundary.enumeration(...UPDATE_STEPS)),
  helperPid: boundary.optional(boundary.number),
  updatedAt: boundary.nonEmptyString,
  appUpdated: boundary.boolean,
  cliUpdated: boundary.boolean,
  hostReachable: boundary.boolean,
  restored: boundary.array(boundary.object({ panelId: boundary.string, outcome: boundary.string, reason: boundary.string })),
  error: boundary.optional(boundary.string),
});
export type UpdateJournal = ReturnType<typeof journalSchema.decode>;

/** Commit one complete journal image; a crash leaves either the old or new image. */
export function writeUpdateJson<T extends object>(file: string, value: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

export function readUpdateJournal(file: string): UpdateJournal {
  return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), journalSchema);
}

export interface UpdateSteps {
  /** Each step reconciles its recorded effect before repeating after a crash. */
  run(step: UpdateStep, journal: UpdateJournal): Promise<Partial<UpdateJournal>>;
}

export async function executeUpdate(file: string, steps: UpdateSteps): Promise<UpdateJournal> {
  let journal = readUpdateJournal(file);
  if (['complete', 'needs-attention', 'failed'].includes(journal.phase)) return journal;
  journal = { ...journal, helperPid: process.pid, updatedAt: new Date().toISOString() };
  writeUpdateJson(file, journal); // This helper's durable acknowledgement, not the supervisor launch result.
  try {
    for (const step of UPDATE_STEPS) {
      const persisted = readUpdateJournal(file);
      if (['complete', 'needs-attention', 'failed'].includes(persisted.phase)) return persisted;
      if (journal.completed.includes(step)) continue;
      journal = { ...journal, phase: step, updatedAt: new Date().toISOString() };
      writeUpdateJson(file, journal);
      const outcome = await steps.run(step, journal);
      const after = readUpdateJournal(file);
      if (['complete', 'needs-attention', 'failed'].includes(after.phase)) return after;
      journal = { ...journal, ...outcome, completed: [...journal.completed, step], updatedAt: new Date().toISOString() };
      writeUpdateJson(file, journal);
    }
    const attention = journal.restored.some(item => item.outcome === 'needs-attention');
    journal = { ...journal, phase: attention ? 'needs-attention' : 'complete' };
  } catch (error) {
    journal = { ...journal, ...readUpdateJournal(file), phase: journal.phase === 'stop' || journal.completed.includes('stop') ? 'needs-attention' : 'failed',
      error: error instanceof Error ? error.message : String(error) };
  }
  writeUpdateJson(file, journal);
  return journal;
}

/** A host/install has one durable owner. Never steal a lock based only on a PID. */
export function claimUpdateLock(directory: string, id: string, statusFile: string) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (!fs.existsSync(directory)) throw error;
    const file = path.join(directory, 'owner.json');
    if (!fs.existsSync(file)) throw new RunpaneError('ERR_UPDATE_LOCK_PENDING', 'Another updater is claiming this installation. Nothing was changed.', 'Wait a moment and run update again.');
    const owner = decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.object({ id: boundary.nonEmptyString, statusFile: boundary.nonEmptyString }));
    return { ...owner, acquired: false };
  }
  writeUpdateJson(path.join(directory, 'owner.json'), { id, statusFile });
  return { id, statusFile, acquired: true };
}

/** Elect one releaser, then recheck ownership inside the lock before deleting it. */
export function releaseUpdateLock(directory: string, id: string): void {
  const marker = path.join(directory, 'releasing');
  let fd: number;
  try { fd = fs.openSync(marker, 'wx', 0o600); }
  catch { return; }
  fs.closeSync(fd);
  try {
    const owner = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')), boundary.object({ id: boundary.nonEmptyString }));
    if (owner.id === id) fs.rmSync(directory, { recursive: true });
    else fs.unlinkSync(marker);
  } catch {
    // An incomplete ownership record is evidence to inspect, never permission
    // to remove a lock another update may own.
  }
}
