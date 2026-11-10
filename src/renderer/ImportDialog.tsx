import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

/** The keys used when their fields are left empty (shown as the fields' placeholders). */
const DEFAULT_NODES_KEY = 'nodes';
const DEFAULT_LINKS_KEY = 'edges';

/** The last part of a path. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

interface ImportDialogProps {
  /** Called with the workspace the import left, once nodes have been imported; the dialog is then closed by the caller. */
  onImported: (result: ImportResult) => void;
  onCancel: () => void;
}

/**
 * What the Import button opens: a "File" button for choosing a JSON file, the keys of its nodes ("Nodes") and links
 * ("Links"), each defaulting to its placeholder, and "Import", which is disabled until a file is chosen. Importing creates
 * a node for each object in the array under the nodes key and a link for each under the links key (see
 * `Workspace.importFile`); a key the file does not have is skipped. If the import fails (the file is not a JSON object,
 * say), the reason is shown and the dialog stays open.
 */
export function ImportDialog({ onImported, onCancel }: ImportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<string>();
  const [nodesKey, setNodesKey] = useState('');
  const [linksKey, setLinksKey] = useState('');
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const chooseFile = async () => {
    const path = await window.workspaceBridge.pickImportFile();
    setFile(path ?? undefined);
    setFailure(undefined);
  };

  const submit = async () => {
    if (!file || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await window.workspaceBridge.importFile({ nodesKey: nodesKey.trim() || DEFAULT_NODES_KEY, linksKey: linksKey.trim() || DEFAULT_LINKS_KEY });
      if (result.status === 'failed') setFailure(result.message);
      else onImported(result);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /** Only the dialog's own close event (Escape) cancels. */
  const onClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onCancel();
  };

  return (
    <dialog ref={dialog} onClose={onClose} data-testid="import-dialog" className="m-auto w-96 rounded p-4 shadow-lg backdrop:bg-black/30">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-3 text-sm">
          <button type="button" data-testid="import-file" disabled={busy} className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100 disabled:opacity-40" onClick={() => void chooseFile()}>
            File
          </button>
          <span data-testid="import-path" title={file} className="min-w-0 flex-1 truncate text-slate-600">
            {file ? baseName(file) : 'No file chosen'}
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="import-nodes">Nodes</label>
          <input
            id="import-nodes"
            data-testid="import-nodes"
            placeholder={DEFAULT_NODES_KEY}
            value={nodesKey}
            onChange={(event) => {
              setNodesKey(event.target.value);
              setFailure(undefined);
            }}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="import-links">Links</label>
          <input id="import-links" data-testid="import-links" placeholder={DEFAULT_LINKS_KEY} value={linksKey} onChange={(event) => setLinksKey(event.target.value)} className="rounded border border-slate-300 px-2 py-1" />
        </div>
        {failure && (
          <p role="alert" data-testid="import-error" className="rounded bg-red-50 p-2 text-sm text-red-800">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" data-testid="import-cancel" disabled={busy} className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-40" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" data-testid="import-submit" disabled={!file || busy} className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-40">
            Import
          </button>
        </div>
      </form>
    </dialog>
  );
}
