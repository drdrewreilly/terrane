import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import plusIcon from './icons/plus.svg';

/** The id of the default node type: it cannot be deleted. */
export const DEFAULT_TYPE_ID = 'default';

/** The colours a node type's displays can have: light pastels (white first, the default type's colour). */
export const PALETTE: { name: string; colour: string }[] = [
  { name: 'White', colour: '#ffffff' },
  { name: 'Rose', colour: '#fde2e4' },
  { name: 'Peach', colour: '#ffe8d1' },
  { name: 'Lemon', colour: '#fff7c2' },
  { name: 'Mint', colour: '#dcf5e3' },
  { name: 'Aqua', colour: '#d5f2f2' },
  { name: 'Sky', colour: '#dbeafe' },
  { name: 'Lavender', colour: '#ece4fb' },
];

/** The type of `node`: the one with its `type`, else the default type. */
export const typeOf = (node: NodeRecord, types: NodeType[]) => types.find((type) => type.id === node.type) ?? types.find((type) => type.id === DEFAULT_TYPE_ID) ?? types[0];

/** `node`'s value for `property`: its own if it is of the property's kind, else the property's default value. */
export const valueOf = (node: NodeRecord | undefined, property: PropertyDefinition): PropertyValue => {
  const value = node?.properties?.[property.id];
  return property.kind === 'text' ? (typeof value === 'string' ? value : property.value) : typeof value === 'boolean' ? value : property.value;
};

/** A small square of a colour, outlined so that white shows. */
function Swatch({ colour }: { colour: string }) {
  return <span data-testid="node-type-swatch" className="inline-block h-4 w-4 shrink-0 rounded border border-slate-300" style={{ backgroundColor: colour }} />;
}

/** A modal `<dialog>`, opened when it is shown; its own close event (Escape) calls `onCancel`. */
function Modal({ testId, label, className, onCancel, children }: { testId: string; label: string; className: string; onCancel: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const onClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onCancel();
  };
  return (
    <dialog ref={dialog} onClose={onClose} aria-label={label} data-testid={testId} className={`m-auto rounded p-4 shadow-lg backdrop:bg-black/30 ${className}`}>
      {children}
    </dialog>
  );
}

interface NodeTypeManagerProps {
  nodeTypes: NodeType[];
  nodes: NodeRecord[];
  onCreate: (input: NodeTypeInput) => Promise<WorkspaceResult>;
  onUpdate: (id: string, input: NodeTypeInput) => Promise<WorkspaceResult>;
  onDelete: (id: string) => Promise<WorkspaceResult>;
  onClose: () => void;
}

/**
 * What the node types button opens: the workspace's node types, each with its colour, its name and how many nodes are of
 * it, and with Edit and Delete buttons; "New type" below them. New type and Edit (or double-clicking a type) open the node
 * type dialog. The default type can be edited but not deleted. Deleting a type that has nodes first asks, since its
 * nodes become nodes of the default type. A change that fails shows why, and the dialog stays open.
 */
export function NodeTypeManager({ nodeTypes, nodes, onCreate, onUpdate, onDelete, onClose }: NodeTypeManagerProps) {
  /** The node type dialog: for a new type, or for editing `type`. */
  const [editing, setEditing] = useState<{ type?: NodeType }>();
  /** The type whose deletion is being confirmed. */
  const [deleting, setDeleting] = useState<NodeType>();
  const [failure, setFailure] = useState<string>();
  const count = (type: NodeType) => nodes.filter((node) => typeOf(node, nodeTypes)?.id === type.id).length;
  const defaultName = nodeTypes.find((type) => type.id === DEFAULT_TYPE_ID)?.name ?? 'Default';

  const run = async (action: () => Promise<WorkspaceResult>) => {
    setFailure(undefined);
    const result = await action();
    if (result.status === 'failed') setFailure(result.message);
  };
  const remove = (type: NodeType) => {
    if (count(type) > 0) setDeleting(type);
    else void run(() => onDelete(type.id));
  };

  return (
    <>
      <Modal testId="node-types-dialog" label="Node types" className="w-96" onCancel={onClose}>
        <h2 className="mb-3 text-base font-semibold">Node types</h2>
        <ul className="mb-3 flex flex-col divide-y divide-slate-100 rounded border border-slate-200">
          {nodeTypes.map((type) => {
            const nodesOfType = count(type);
            return (
              <li key={type.id} data-testid="node-type-entry" data-type-id={type.id} className="flex items-center gap-2 px-2 py-1.5 text-sm" onDoubleClick={() => setEditing({ type })}>
                <Swatch colour={type.colour} />
                <span data-testid="node-type-entry-name" className="min-w-0 flex-1 truncate">
                  {type.name}
                </span>
                <span data-testid="node-type-entry-count" className="text-xs text-slate-500">
                  {nodesOfType === 1 ? '1 node' : `${nodesOfType} nodes`}
                </span>
                <button type="button" data-testid="node-type-edit" className="rounded px-2 py-0.5 text-slate-700 hover:bg-slate-100" onClick={() => setEditing({ type })}>
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="node-type-delete"
                  disabled={type.id === DEFAULT_TYPE_ID}
                  title={type.id === DEFAULT_TYPE_ID ? 'The default type cannot be deleted' : undefined}
                  className="rounded px-2 py-0.5 text-red-700 hover:bg-red-50 disabled:text-slate-300 disabled:hover:bg-transparent"
                  onClick={() => remove(type)}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
        {failure && (
          <p role="alert" data-testid="node-types-error" className="mb-3 rounded bg-red-50 p-2 text-sm text-red-800">
            {failure}
          </p>
        )}
        <div className="flex justify-between gap-2 text-sm">
          <button type="button" data-testid="node-type-new" className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100" onClick={() => setEditing({})}>
            New type
          </button>
          <button type="button" data-testid="node-types-close" className="rounded bg-slate-900 px-3 py-1.5 text-white" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
      {editing && (
        <NodeTypeDialog
          type={editing.type}
          names={nodeTypes.filter((type) => type.id !== editing.type?.id).map((type) => type.name)}
          onSubmit={(input) => {
            const type = editing.type;
            setEditing(undefined);
            void run(() => (type ? onUpdate(type.id, input) : onCreate(input)));
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <Modal testId="node-type-delete-dialog" label="Delete node type" className="w-80" onCancel={() => setDeleting(undefined)}>
          <p className="text-sm">
            Delete the node type “{deleting.name}”? Its {count(deleting) === 1 ? 'node becomes a node' : `${count(deleting)} nodes become nodes`} of the type “{defaultName}”.
          </p>
          <div className="mt-3 flex justify-end gap-2 text-sm">
            <button type="button" data-testid="node-type-delete-cancel" className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100" onClick={() => setDeleting(undefined)}>
              Cancel
            </button>
            <button
              type="button"
              data-testid="node-type-delete-confirm"
              className="rounded bg-red-700 px-3 py-1.5 text-white"
              onClick={() => {
                const type = deleting;
                setDeleting(undefined);
                void run(() => onDelete(type.id));
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** A property being edited: `row` tells the rows apart; `id` is absent for a property not yet saved. */
interface PropertyRow {
  row: number;
  id?: string;
  key: string;
  kind: 'text' | 'boolean';
  value: PropertyValue;
}

interface NodeTypeDialogProps {
  /** The type being edited ("Save"); absent for a new type ("Create"). */
  type?: NodeType;
  /** The names of the other node types, which this one cannot take. */
  names: string[];
  onSubmit: (input: NodeTypeInput) => void;
  onCancel: () => void;
}

/**
 * Creates or edits a node type: its name (which no other type may have), the colour of its nodes' displays (from a
 * palette of light pastels), and its properties, each a key with a text or true/false value (the value its nodes start
 * with). The "+" button under the properties adds one; each has a button that removes it. Create (or Save) is disabled
 * until the name is given and not taken, and every property has a key that no other property of the type has.
 */
export function NodeTypeDialog({ type, names, onSubmit, onCancel }: NodeTypeDialogProps) {
  const [name, setName] = useState(type?.name ?? '');
  const [colour, setColour] = useState(type?.colour ?? PALETTE[0].colour);
  const nextRow = useRef(0);
  const row = (property: Omit<PropertyRow, 'row'>): PropertyRow => ({ ...property, row: nextRow.current++ });
  const [properties, setProperties] = useState<PropertyRow[]>(() => (type?.properties ?? []).map((property) => row(property)));
  const added = useRef<number>(undefined);
  const keyInputs = useRef(new Map<number, HTMLInputElement>());

  // A property just added has its key focused.
  useEffect(() => {
    if (added.current === undefined) return;
    keyInputs.current.get(added.current)?.focus();
    added.current = undefined;
  }, [properties]);

  const trimmed = name.trim();
  const nameTaken = names.includes(trimmed);
  const keys = properties.map((property) => property.key.trim());
  const keyError = (index: number) => (keys[index] === '' ? 'A property needs a key.' : keys.indexOf(keys[index]) !== index ? 'Another property has this key.' : undefined);
  const ready = trimmed !== '' && !nameTaken && properties.every((_, index) => keyError(index) === undefined);

  const update = (target: number, change: Partial<PropertyRow>) => setProperties((current) => current.map((property) => (property.row === target ? { ...property, ...change } : property)));
  const add = () => {
    const property = row({ key: '', kind: 'text', value: '' });
    added.current = property.row;
    setProperties((current) => [...current, property]);
  };

  return (
    <Modal testId="node-type-dialog" label={type ? 'Edit node type' : 'New node type'} className="w-[28rem]" onCancel={onCancel}>
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit({ name: trimmed, colour, properties: properties.map(({ id, key, kind, value }) => ({ ...(id === undefined ? {} : { id }), key: key.trim(), kind, value })) });
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="node-type-name">Name</label>
          <input
            id="node-type-name"
            data-testid="node-type-name"
            autoFocus
            value={name}
            aria-invalid={nameTaken || undefined}
            onChange={(event) => setName(event.target.value)}
            className={`rounded border px-2 py-1 ${nameTaken ? 'border-red-500' : 'border-slate-300'}`}
          />
          {nameTaken && (
            <span data-testid="node-type-name-taken" role="alert" className="text-red-700">
              Another node type already has this name.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <span id="node-type-colour">Colour</span>
          <div role="radiogroup" aria-labelledby="node-type-colour" className="flex flex-wrap gap-1.5">
            {PALETTE.map((option) => (
              <button
                key={option.colour}
                type="button"
                role="radio"
                aria-checked={colour === option.colour}
                aria-label={option.name}
                title={option.name}
                data-testid="node-type-colour"
                data-colour={option.colour}
                onClick={() => setColour(option.colour)}
                className={`h-7 w-7 rounded border ${colour === option.colour ? 'border-slate-900 ring-2 ring-slate-900 ring-offset-1' : 'border-slate-300'}`}
                style={{ backgroundColor: option.colour }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span>Properties</span>
          {properties.length === 0 && <span className="text-slate-400">None</span>}
          <ul className="flex flex-col gap-1.5">
            {properties.map((property, index) => {
              const error = keyError(index);
              return (
                <li key={property.row} data-testid="node-type-property" className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={(element) => {
                        if (element) keyInputs.current.set(property.row, element);
                        else keyInputs.current.delete(property.row);
                      }}
                      aria-label="Key"
                      placeholder="Key"
                      data-testid="property-key"
                      value={property.key}
                      aria-invalid={error !== undefined || undefined}
                      onChange={(event) => update(property.row, { key: event.target.value })}
                      className={`w-28 min-w-0 rounded border px-2 py-1 ${error ? 'border-red-500' : 'border-slate-300'}`}
                    />
                    <select
                      aria-label="Kind"
                      data-testid="property-kind"
                      value={property.kind}
                      onChange={(event) => {
                        const kind = event.target.value as PropertyRow['kind'];
                        update(property.row, { kind, value: kind === 'text' ? '' : false });
                      }}
                      className="rounded border border-slate-300 px-1 py-1"
                    >
                      <option value="text">Text</option>
                      <option value="boolean">True/false</option>
                    </select>
                    {property.kind === 'text' ? (
                      <input
                        aria-label="Value"
                        placeholder="Value"
                        data-testid="property-value"
                        value={property.value as string}
                        onChange={(event) => update(property.row, { value: event.target.value })}
                        className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1"
                      />
                    ) : (
                      <label className="flex flex-1 items-center gap-1">
                        <input type="checkbox" aria-label="Value" data-testid="property-value" checked={property.value as boolean} onChange={(event) => update(property.row, { value: event.target.checked })} />
                        {property.value ? 'True' : 'False'}
                      </label>
                    )}
                    <button
                      type="button"
                      aria-label="Remove property"
                      title="Remove property"
                      data-testid="property-remove"
                      className="rounded px-1.5 text-slate-500 hover:bg-slate-100"
                      onClick={() => setProperties((current) => current.filter((candidate) => candidate.row !== property.row))}
                    >
                      ×
                    </button>
                  </div>
                  {error && (
                    <span data-testid="property-key-error" className="text-xs text-red-700">
                      {error}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" aria-label="Add property" title="Add property" data-testid="property-add" className="self-start rounded border border-slate-300 p-1.5 hover:bg-slate-100" onClick={add}>
            <img src={plusIcon} alt="" className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 text-slate-600 hover:bg-slate-100" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" data-testid="node-type-submit" disabled={!ready} className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-40">
            {type ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
