import { useState } from 'react';
import { ITEM_CLASS, MENU_CLASS, MenuBackdrop, useFitted } from './Menu';
import { displayText } from './NodeList';

/** How many characters (spaces included) of each node's displayed text the popup shows. */
const TEXT_LENGTH = 30;

interface NodeMenuProps {
  /** The node that was right-clicked: not listed. */
  source: string;
  nodes: NodeRecord[];
  /** The ids of the nodes that have at least one link. */
  linked: Set<string>;
  /** Every link: the nodes already linked to the right-clicked node (either way) are not listed, as two nodes have at most one link. */
  links: WorkspaceLink[];
  /** Where the right-click was, in the window. */
  x: number;
  y: number;
  /** The pointer moved onto a listed node (its id) or off the list (undefined). */
  onHover: (id: string | undefined) => void;
  onSelect: (target: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}

/**
 * The nodes the node `source` can be linked to: every other node it is not already linked to (either way), those without
 * a link first. With no `source` (a node not yet created), every node.
 */
export function linkTargets(source: string | undefined, nodes: NodeRecord[], links: WorkspaceLink[], linked: Set<string>): NodeRecord[] {
  const joined = new Set(links.flatMap((link) => (link.source === source ? [link.target] : link.target === source ? [link.source] : [])));
  const others = nodes.filter((node) => node.id !== source && !joined.has(node.id));
  return [...others.filter((node) => !linked.has(node.id)), ...others.filter((node) => linked.has(node.id))];
}

/**
 * The popup shown on right-clicking a node (in the node list or on the canvas): "Link to..." above "Delete".
 *
 * Hovering "Link to..." shows, next to the popup, every other node the right-clicked one is not already linked to, those
 * without a link first, each shown by the first TEXT_LENGTH characters of its displayed text; hovering one highlights it
 * on the canvas, and choosing one asks for a link from the right-clicked node to it. "Link to..." is disabled when there
 * is no such node. "Delete" deletes the right-clicked node. A press anywhere off the popup cancels.
 */
export function NodeMenu({ source, nodes, linked, links, x, y, onHover, onSelect, onDelete, onCancel }: NodeMenuProps) {
  const ordered = linkTargets(source, nodes, links, linked);
  const [menu, at] = useFitted<HTMLUListElement>(x, y);
  /** Where the list of nodes opens (beside "Link to..."), while it is open. */
  const [targets, setTargets] = useState<{ x: number; y: number; leftOf: number }>();

  return (
    <MenuBackdrop testId="node-menu-backdrop" onCancel={onCancel}>
      <ul ref={menu} role="menu" data-testid="node-menu" className={MENU_CLASS} style={at}>
        <li
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={targets !== undefined}
          aria-disabled={ordered.length === 0}
          data-testid="node-menu-link"
          className={`flex items-center justify-between gap-4 ${ordered.length === 0 ? 'cursor-default whitespace-pre px-3 py-0.5 text-slate-400' : `${ITEM_CLASS} ${targets ? 'bg-slate-100' : ''}`}`}
          onPointerEnter={(event) => {
            if (ordered.length === 0) return;
            const item = event.currentTarget.getBoundingClientRect();
            const list = event.currentTarget.parentElement!.getBoundingClientRect();
            // Its first node level with "Link to..." (less the list's border and padding).
            setTargets({ x: list.right, y: item.top - 5, leftOf: list.left });
          }}
        >
          <span>Link to...</span>
          <span aria-hidden="true">▸</span>
        </li>
        <li
          role="menuitem"
          data-testid="node-menu-delete"
          className={ITEM_CLASS}
          onPointerEnter={() => {
            setTargets(undefined);
            onHover(undefined);
          }}
          onClick={onDelete}
        >
          Delete
        </li>
      </ul>
      {targets && <TargetList nodes={ordered} at={targets} onHover={onHover} onSelect={onSelect} />}
    </MenuBackdrop>
  );
}

/** The nodes "Link to..." can link to, in a list beside the popup. */
function TargetList({ nodes, at, onHover, onSelect }: { nodes: NodeRecord[]; at: { x: number; y: number; leftOf: number }; onHover: NodeMenuProps['onHover']; onSelect: NodeMenuProps['onSelect'] }) {
  const [list, position] = useFitted<HTMLUListElement>(at.x, at.y, at.leftOf);
  return (
    <ul ref={list} role="menu" data-testid="node-menu-targets" className={MENU_CLASS} style={position} onPointerLeave={() => onHover(undefined)}>
      {nodes.map((node) => (
        <li key={node.id} role="menuitem" data-testid="node-menu-item" data-node-id={node.id} className={ITEM_CLASS} onPointerEnter={() => onHover(node.id)} onClick={() => onSelect(node.id)}>
          {displayText(node).slice(0, TEXT_LENGTH)}
        </li>
      ))}
    </ul>
  );
}
