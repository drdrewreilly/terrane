import { useState } from 'react';
import { handlerFor, isFileNode } from './handlers';
import { displayLines } from './handlers/display';
import { imageHandler, showsImage, useNodeImage } from './handlers/image';
import { SplitView } from './SplitView';

/** A node's displayed text (its display lines) on one line: line breaks become spaces. */
export const displayText = (node: NodeRecord) => displayLines(node).join(' ').replace(/\r?\n/g, ' ');

interface NodeListProps {
  nodes: NodeRecord[];
  /** The ids of the nodes that have at least one link. */
  linked: Set<string>;
  /** The user double-clicked a node's entry. */
  onOpenNode: (node: NodeRecord) => void;
  /** The user right-clicked a node's entry, at (`x`, `y`) in the window. */
  onNodeMenu: (node: NodeRecord, x: number, y: number) => void;
}

/**
 * The node list: a search box above the nodes, which are split by a draggable splitter into those without a link (top,
 * sized to fit its entries) and those with one (bottom). Each change to the search text shows only the nodes whose displayed text contains it
 * (ignoring case).
 */
export function NodeList({ nodes, linked, onOpenNode, onNodeMenu }: NodeListProps) {
  const [search, setSearch] = useState('');
  const query = search.toLowerCase();
  const shown = nodes.filter((node) => displayText(node).toLowerCase().includes(query));
  const entries = (list: NodeRecord[]) => list.map((node) => <NodeEntry key={node.id} node={node} onOpenNode={onOpenNode} onNodeMenu={onNodeMenu} />);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="node-list">
      <input
        type="search"
        aria-label="Search nodes"
        placeholder="Search"
        data-testid="node-search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="m-1 min-w-0 rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <SplitView
        direction="column"
        initialFirst={0}
        // The unlinked part starts as tall as its entries: the splitter sits under the last one (or under the search box if
        // there are none). Dragging it up shows fewer unlinked entries (they scroll) and more linked ones; it cannot be
        // dragged below the last unlinked entry.
        fitFirst
        first={<ul data-testid="unlinked-nodes">{entries(shown.filter((node) => !linked.has(node.id)))}</ul>}
        second={<ul data-testid="linked-nodes">{entries(shown.filter((node) => linked.has(node.id)))}</ul>}
      />
    </div>
  );
}

/**
 * A node's entry: its displayed text on one line. Clicking it (or Enter or Space while it has focus) expands it to show all
 * of the text, wrapped (and, for an image node whose display shows its image, the image above it), and below it the node's
 * properties; clicking it again collapses it. A double-click's two clicks cancel out, so it only opens the node.
 */
function NodeEntry({ node, onOpenNode, onNodeMenu }: { node: NodeRecord; onOpenNode: NodeListProps['onOpenNode']; onNodeMenu: NodeListProps['onNodeMenu'] }) {
  const [expanded, setExpanded] = useState(false);
  const image = isFileNode(node) && handlerFor(node.filename).id === imageHandler.id && showsImage(node) ? node : undefined;
  const toggle = () => setExpanded((current) => !current);

  return (
    <li
      data-testid="node-entry"
      data-node-id={node.id}
      data-expanded={expanded}
      tabIndex={0}
      aria-expanded={expanded}
      className="flex cursor-default select-none items-start gap-1 border-b border-slate-100 px-1 py-0.5 text-sm hover:bg-slate-50"
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        toggle();
      }}
      onDoubleClick={() => onOpenNode(node)}
      onContextMenu={(event) => {
        event.preventDefault();
        onNodeMenu(node, event.clientX, event.clientY);
      }}
    >
      <div className="min-w-0 flex-1">
        {expanded && image && <EntryImage node={image} />}
        <div data-testid="node-entry-text" className={expanded ? 'whitespace-pre-line break-words' : 'truncate'}>
          {displayLines(node).join('\n')}
        </div>
        {expanded && <NodeProperties node={node} />}
      </div>
    </li>
  );
}

/** A node's text properties (title, description and body), each labelled; an empty one is shown as a dash. */
function NodeProperties({ node }: { node: NodeRecord }) {
  const properties: [string, string | null][] = [
    ['Title', node.title],
    ['Description', node.description],
    ['Body', node.body],
  ];
  return (
    <dl data-testid="node-entry-properties" className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-t border-slate-100 pt-1 text-xs">
      {properties.map(([label, value]) => (
        <div key={label} data-testid="node-entry-property" data-property={label.toLowerCase()} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className={`whitespace-pre-line break-words ${value === null ? 'text-slate-400' : ''}`}>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function EntryImage({ node }: { node: FileNode }) {
  const src = useNodeImage(node, true);
  return <div data-testid="node-entry-image">{src && <img src={src} alt={node.filename} className="max-h-40 max-w-full object-contain" />}</div>;
}
