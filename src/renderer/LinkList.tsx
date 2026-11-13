import { useState } from 'react';

/** A link's text in the list: its source node's title and its target node's title, separated by a hyphen. */
export const linkText = (link: WorkspaceLink, titles: Map<string, string>) => `${titles.get(link.source) ?? '?'} - ${titles.get(link.target) ?? '?'}`;

interface LinkListProps {
  links: WorkspaceLink[];
  nodes: NodeRecord[];
  /** The user double-clicked a link's entry. */
  onOpenLink: (link: WorkspaceLink) => void;
  /** The user right-clicked a link's entry, at (`x`, `y`) in the window. */
  onLinkMenu: (link: WorkspaceLink, x: number, y: number) => void;
}

/**
 * The link list, at the right of the screen: a search box above the network's links, each shown as its source node's
 * title and its target node's title, separated by a hyphen. Each change to the search text shows only the links whose
 * text contains it (ignoring case). Like the node list, but in one part: right-clicking an entry opens the link popup
 * (to delete the link), and double-clicking it opens the link dialog. Links are not created here.
 */
export function LinkList({ links, nodes, onOpenLink, onLinkMenu }: LinkListProps) {
  const [search, setSearch] = useState('');
  const query = search.toLowerCase();
  const titles = new Map(nodes.map((node) => [node.id, node.title]));
  const shown = links.filter((link) => linkText(link, titles).toLowerCase().includes(query));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="link-list">
      <input
        type="search"
        aria-label="Search links"
        placeholder="Search"
        data-testid="link-search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="m-1 min-w-0 rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <ul data-testid="links" className="min-h-0 flex-1 overflow-auto">
        {shown.map((link) => (
          <LinkEntry key={link.id} link={link} text={linkText(link, titles)} titles={titles} onOpenLink={onOpenLink} onLinkMenu={onLinkMenu} />
        ))}
      </ul>
    </div>
  );
}

/**
 * A link's entry: its text on one line. Clicking it (or Enter or Space while it has focus) expands it to show all of the
 * text, wrapped, and below it the link's data; clicking it again collapses it. A double-click's two clicks cancel out, so
 * it only opens the link.
 */
function LinkEntry({ link, text, titles, onOpenLink, onLinkMenu }: { link: WorkspaceLink; text: string; titles: Map<string, string> } & Pick<LinkListProps, 'onOpenLink' | 'onLinkMenu'>) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((current) => !current);

  return (
    <li
      data-testid="link-entry"
      data-link-id={link.id}
      data-expanded={expanded}
      tabIndex={0}
      aria-expanded={expanded}
      className="cursor-default select-none border-b border-slate-100 px-1 py-0.5 text-sm hover:bg-slate-50"
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        toggle();
      }}
      onDoubleClick={() => onOpenLink(link)}
      onContextMenu={(event) => {
        event.preventDefault();
        onLinkMenu(link, event.clientX, event.clientY);
      }}
    >
      <div data-testid="link-entry-text" className={expanded ? 'whitespace-pre-line break-words' : 'truncate'}>
        {text}
      </div>
      {expanded && <LinkProperties link={link} titles={titles} />}
    </li>
  );
}

/** A link's data, each labelled: its source and target (by title), its weight and its description (a dash if it has none). */
function LinkProperties({ link, titles }: { link: WorkspaceLink; titles: Map<string, string> }) {
  const properties: [string, string | null][] = [
    ['Source', titles.get(link.source) ?? null],
    ['Target', titles.get(link.target) ?? null],
    ['Weight', String(link.weight)],
    ['Description', link.description],
  ];
  return (
    <dl data-testid="link-entry-properties" className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-t border-slate-100 pt-1 text-xs">
      {properties.map(([label, value]) => (
        <div key={label} data-testid="link-entry-property" data-property={label.toLowerCase()} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className={`whitespace-pre-line break-words ${value === null ? 'text-slate-400' : ''}`}>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
