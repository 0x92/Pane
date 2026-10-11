import { app, session, webContents } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { DOCS_BROWSER_PARTITION, SHARED_BROWSER_PARTITION } from '../../../shared/constants/browserPartitions';
import { PaneError, reasonOf } from '../../../shared/paneError';

/** Folders under `<userData>/Partitions` that Clear browser data keeps: the stores Pane still uses. */
const KEPT_PARTITION_FOLDERS: ReadonlySet<string> = new Set(
  [SHARED_BROWSER_PARTITION, DOCS_BROWSER_PARTITION].map(partition => partition.replace(/^persist:/, '')),
);

interface ClearBrowserDataDeps {
  userDataPath: string;
  sharedSession: { clearStorageData(): Promise<void>; clearCache(): Promise<void> };
  reloadBrowserTabs(): void;
  /** Deletes one leftover store. `fs.rm` removes a link itself, never what it points to. */
  removeStore?: (target: string) => Promise<void>;
}

/**
 * Signs out of every site in Pane's browser: clears the shared store, deletes the
 * per-project and per-Session stores older versions left behind, and reloads open
 * tabs. The shared store is cleared even when an old store can't be deleted, and
 * running it again retries the deletion.
 */
export async function clearBrowserData({
  userDataPath,
  sharedSession,
  reloadBrowserTabs,
  removeStore = target => fs.rm(target, { recursive: true, force: true }),
}: ClearBrowserDataDeps): Promise<void> {
  await sharedSession.clearStorageData();
  await sharedSession.clearCache();

  const partitionsDir = path.join(userDataPath, 'Partitions');
  let failure: { target: string; cause: unknown } | null = null;
  let leftovers: string[] = [];
  try {
    leftovers = await leftoverStoreNames(partitionsDir);
  } catch (cause) {
    failure = { target: partitionsDir, cause };
  }
  for (const name of leftovers) {
    const target = path.join(partitionsDir, name);
    try {
      await removeStore(target);
    } catch (cause) {
      failure ??= { target, cause };
    }
  }

  reloadBrowserTabs();

  if (failure) {
    throw new PaneError(
      'browser-data-cleanup-incomplete',
      `Pane cleared your logins but couldn't remove some older browser data at ${failure.target}: ${reasonOf(failure.cause)}.`,
      'Close any open browser tabs and run Clear browser data again.',
    );
  }
}

async function leftoverStoreNames(partitionsDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(partitionsDir)).filter(name => !KEPT_PARTITION_FOLDERS.has(name));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Clears this computer's browser data in the running app and reloads its open browser tabs. */
export function clearPaneBrowserData(): Promise<void> {
  const sharedSession = session.fromPartition(SHARED_BROWSER_PARTITION);
  return clearBrowserData({
    userDataPath: app.getPath('userData'),
    sharedSession,
    reloadBrowserTabs: () => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.getType() === 'webview' && contents.session === sharedSession) contents.reload();
      }
    },
  });
}
