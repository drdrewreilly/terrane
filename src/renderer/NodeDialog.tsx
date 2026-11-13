import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { isFileNode } from './handlers';
import { DEFAULT_TYPE_ID, typeOf, valueOf } from './NodeTypes';

const FIELDS: { field: DisplayField; label: string; rows: number }[] = [
  { field: 'title', label: 'Title', rows: 1 },
  { field: 'description', label: 'Description', rows: 2 },
  { field: 'body', label: 'Body', rows: 10 },
];

/** Whether `path` is absolute (Windows or POSIX); a file copied into the workspace has a path relative to it. */
const isAbsolutePath = (path: string) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path);

/** Whether `node` has a file copied into the workspace. */
export const hasCopiedFile = (node: NodeRecord) => isFileNode(node) && !isAbsolutePath(node.path);

/** The last part of a path. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** `title` if `taken` does not hold it, else with the first free integer from 2 added to its end (as main/workspace.ts does). */
const uniqueTitle = (title: string, taken: Set<string>) => {
  if (!taken.has(title)) return title;
  let n = 2;
  while (taken.has(`${title}${n}`)) n += 1;
  return `${title}${n}`;
};

interface NodeDialogProps {
  /** The node being edited ("Save"); absent for a new node ("Create"). */
  node?: NodeRecord;
  /** The titles of the workspace's other nodes, which this node cannot take. */
  titles: string[];
  /** The workspace's node types, the default first. */
  nodeTypes: NodeType[];
  /** The nodes this node can be linked to: every other node it is not linked to, in the order they are listed. */
  linkTargets: NodeRecord[];
  /** Create (or Save) was pressed, with the node to link this one to if one was chosen under "Link to...". */
  onSubmit: (input: NodeInput, linkTo?: string) => void;
  onCancel: () => void;
  /** Delete was pressed (only when editing): the node is to be deleted. */
  onDelete?: () => void;
}

/**
 * What the Add button (and Ctrl+N) opens to create a node, and double-clicking a node opens to edit it: a title, a
 * description and a body, each with a checkbox for whether it is shown in the node's display (a checkbox is disabled while
 * its field is empty, and fields left empty are stored as `null`), and a "File" button with a checkbox for copying the file
 * into the workspace. "Create" (or "Save") is disabled until the node has a title, one that no other node has (the dialog
 * says so when it is taken), and at least one ticked field has text. A file chosen while the title is empty gives the node
 * its name as the title, with an integer at its end if another node has that title.
 *
 * Above them, the node's type (the default type for a new node); below them, a field for each of the type's properties (a
 * text box, or a checkbox for a true/false one), filled in with the node's values or, for a new node, the type's own.
 * Choosing another type fills them in with that type's values.
 *
 * Under the File button, "Link to..." lists by title every other node this one is not linked to (none chosen to begin
 * with; disabled if there are none). Choosing one links this node to it once Create (or Save) is pressed.
 *
 * Editing a node whose file was copied into the workspace: the copy checkbox stays ticked and disabled until another file
 * is chosen, and then saving asks whether to keep the old copy in the workspace. Editing a node, a Delete button deletes it.
 */
export function NodeDialog({ node, titles, nodeTypes, linkTargets, onSubmit, onCancel, onDelete }: NodeDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const editing = node !== undefined;
  const fileNode = node && isFileNode(node) ? node : undefined;
  const copiedIn = fileNode !== undefined && !isAbsolutePath(fileNode.path);
  const [text, setText] = useState<Record<DisplayField, string>>({ title: node?.title ?? '', description: node?.description ?? '', body: node?.body ?? '' });
  const [ticked, setTicked] = useState<Record<DisplayField, boolean>>(
    node ? { title: node.display.includes('title'), description: node.display.includes('description'), body: node.display.includes('body') } : { title: true, description: false, body: false },
  );
  /** The node's file: its path, and whether it was just chosen (rather than being the edited node's current file). */
  const [file, setFile] = useState<{ path: string; picked: boolean } | undefined>(fileNode && { path: fileNode.path, picked: false });
  const [copy, setCopy] = useState(copiedIn);
  const [askKeep, setAskKeep] = useState(false);
  /** The node chosen under "Link to...": its id, or empty for none. */
  const [linkTo, setLinkTo] = useState('');
  const [typeId, setTypeId] = useState(() => (node ? typeOf(node, nodeTypes)?.id : undefined) ?? DEFAULT_TYPE_ID);
  const type = nodeTypes.find((candidate) => candidate.id === typeId);
  /** The values of the chosen type's properties, by property id. */
  const [values, setValues] = useState<Record<string, PropertyValue>>(() => Object.fromEntries((type?.properties ?? []).map((property) => [property.id, valueOf(node, property)])));
  const chooseType = (id: string) => {
    setTypeId(id);
    const chosen = nodeTypes.find((candidate) => candidate.id === id);
    setValues(Object.fromEntries((chosen?.properties ?? []).map((property) => [property.id, id === node?.type ? valueOf(node, property) : property.value])));
  };

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const display = FIELDS.map(({ field }) => field).filter((field) => ticked[field] && text[field] !== '');
  const copyLocked = copiedIn && !file?.picked;
  const taken = new Set(titles);
  const title = text.title.trim();
  const titleTaken = taken.has(title);
  const ready = title !== '' && !titleTaken && display.length > 0;

  const chooseFile = async () => {
    const path = await window.workspaceBridge.pickFile();
    if (!path) return;
    setFile({ path, picked: true });
    setText((current) => (current.title.trim() === '' ? { ...current, title: uniqueTitle(baseName(path), taken) } : current));
  };

  const submit = (keepOldCopy?: boolean) =>
    onSubmit({ ...text, display, type: typeId, properties: values, file: file && { source: file.picked ? file.path : undefined, copy }, ...(keepOldCopy === undefined ? {} : { keepOldCopy }) }, linkTo || undefined);

  /** Only the dialog's own close event (not one from a dialog inside it) cancels. */
  const onClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onCancel();
  };

  return (
    <>
      <dialog ref={dialog} onClose={onClose} data-testid="node-dialog" className="m-auto w-96 rounded p-4 shadow-lg backdrop:bg-black/30">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            if (copiedIn && file?.picked) setAskKeep(true);
            else submit();
          }}
        >
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="node-type">Type</label>
            <select id="node-type" data-testid="node-type" value={typeId} onChange={(event) => chooseType(event.target.value)} className="min-w-0 flex-1 rounded border border-slate-300 px-1 py-1">
              {nodeTypes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <span className="inline-block h-4 w-4 shrink-0 rounded border border-slate-300" style={{ backgroundColor: type?.colour }} />
          </div>
          {FIELDS.map(({ field, label, rows }) => (
            <div key={field} className="flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Show ${label.toLowerCase()}`}
                  data-testid={`show-${field}`}
                  checked={ticked[field]}
                  disabled={text[field] === ''}
                  onChange={(event) => setTicked((current) => ({ ...current, [field]: event.target.checked }))}
                />
                <label htmlFor={`node-${field}`}>{label}</label>
              </div>
              <textarea
                id={`node-${field}`}
                data-testid={`node-${field}`}
                autoFocus={field === 'title'}
                rows={rows}
                value={text[field]}
                aria-invalid={field === 'title' && titleTaken ? true : undefined}
                aria-describedby={field === 'title' && titleTaken ? 'node-title-taken' : undefined}
                onChange={(event) => setText((current) => ({ ...current, [field]: event.target.value }))}
                className={`resize-none rounded border px-2 py-1 ${field === 'title' && titleTaken ? 'border-red-500' : 'border-slate-300'}`}
              />
              {field === 'title' && titleTaken && (
                <span id="node-title-taken" data-testid="node-title-taken" role="alert" className="text-red-700">
                  Another node already has this title.
                </span>
              )}
            </div>
          ))}
          {type && type.properties.length > 0 && (
            <div data-testid="node-properties" className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-sm">
              {type.properties.map((property) => (
                <div key={property.id} className="contents">
                  <label htmlFor={`node-property-${property.id}`} className="truncate">
                    {property.key}
                  </label>
                  {property.kind === 'text' ? (
                    <input
                      id={`node-property-${property.id}`}
                      data-testid="node-property"
                      data-key={property.key}
                      value={values[property.id] as string}
                      onChange={(event) => setValues((current) => ({ ...current, [property.id]: event.target.value }))}
                      className="min-w-0 rounded border border-slate-300 px-2 py-1"
                    />
                  ) : (
                    <input
                      id={`node-property-${property.id}`}
                      type="checkbox"
                      data-testid="node-property"
                      data-key={property.key}
                      checked={values[property.id] as boolean}
                      onChange={(event) => setValues((current) => ({ ...current, [property.id]: event.target.checked }))}
                      className="justify-self-start"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center gap-3">
              <button type="button" data-testid="node-file" className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100" onClick={() => void chooseFile()}>
                File
              </button>
              <label className="flex items-center gap-2">
                <input type="checkbox" data-testid="node-copy" checked={copy} disabled={copyLocked} onChange={(event) => setCopy(event.target.checked)} />
                Copy into workspace
              </label>
            </div>
            {file && (
              <span data-testid="node-path" className="break-all text-slate-600">
                {file.path}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="node-link-to" className="shrink-0">
              Link to...
            </label>
            <select id="node-link-to" data-testid="node-link-to" value={linkTo} disabled={linkTargets.length === 0} onChange={(event) => setLinkTo(event.target.value)} className="min-w-0 flex-1 rounded border border-slate-300 px-1 py-1 disabled:text-slate-400">
              <option value="">{linkTargets.length === 0 ? 'No nodes to link to' : 'None'}</option>
              {linkTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.title}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            {editing && onDelete && (
              <button type="button" data-testid="node-delete" className="mr-auto rounded px-3 py-1.5 text-red-700 hover:bg-red-50" onClick={onDelete}>
                Delete
              </button>
            )}
            <button type="button" className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" data-testid="node-submit" disabled={!ready} className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-40">
              {editing ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </dialog>
      {askKeep && (
        <KeepCopyDialog
          question="Keep the copy of the previous file in the workspace?"
          onAnswer={(keep) => {
            setAskKeep(false);
            submit(keep);
          }}
          onCancel={() => setAskKeep(false)}
        />
      )}
    </>
  );
}

/**
 * Asks whether to keep a file copied into the workspace, or remove it from the workspace folder: on saving when another
 * file replaces it, and on deleting its node.
 */
export function KeepCopyDialog({ question, onAnswer, onCancel }: { question: string; onAnswer: (keep: boolean) => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog ref={dialog} onClose={onCancel} data-testid="keep-copy-dialog" className="m-auto w-80 rounded p-4 shadow-lg backdrop:bg-black/30">
      <p className="text-sm">{question}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" data-testid="delete-copy" className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100" onClick={() => onAnswer(false)}>
          Remove
        </button>
        <button type="button" data-testid="keep-copy" className="rounded bg-slate-900 px-3 py-1.5 text-white" onClick={() => onAnswer(true)}>
          Keep
        </button>
      </div>
    </dialog>
  );
}
