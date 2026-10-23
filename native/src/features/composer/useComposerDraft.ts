import { useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';

import { composerDraftStore } from './composerDrafts';
import { insertAtSelection, type Selection } from './insertText';

/** Text belongs to a durable key; cursor position belongs to the current view. */
export function useComposerDraft(key: string | null) {
  const draft = useSyncExternalStore(listener => composerDraftStore.subscribe(key, listener), () => composerDraftStore.read(key));
  const [selection, setSelection] = useState<{ key: string | null; cursor: Selection | null; moveTo?: Selection }>({ key, cursor: null });
  const cursorRef = useRef<{ key: string | null; cursor: Selection | null }>({ key, cursor: null });
  if (selection.key !== key) setSelection({ key, cursor: null });
  return {
    draft: draft.text,
    selection: selection.key === key ? selection.moveTo : undefined,
    // This callback deliberately owns this snapshot, even after navigation.
    confirmDelivery: () => composerDraftStore.confirm(draft),
    setDraft: (next: SetStateAction<string>) => {
      composerDraftStore.update(key, next);
      if (composerDraftStore.read(key).text === '' && cursorRef.current.key === key) cursorRef.current = { key, cursor: null };
      setSelection(current => current.key === key ? { key, cursor: composerDraftStore.read(key).text === '' ? null : current.cursor } : current);
    },
    onSelectionChange: (cursor: Selection) => {
      cursorRef.current = { key, cursor };
      setSelection(current => current.key === key ? { key, cursor } : current);
    },
    insert: (insert: string) => {
      const result = insertAtSelection(composerDraftStore.read(key).text, cursorRef.current.key === key ? cursorRef.current.cursor : null, insert);
      composerDraftStore.update(key, result.text);
      const cursor = { start: result.cursor, end: result.cursor };
      cursorRef.current = { key, cursor };
      setSelection(current => current.key === key ? { key, cursor, moveTo: cursor } : current);
    },
  };
}
