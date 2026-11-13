import { LINE_WIDTH } from './paths';

/** What a selected link looks like (D15). */
const SELECTED_GLOW = 'drop-shadow(0 0 2px #2563eb)';

interface LinkDisplayProps {
  id: string;
  /** SVG path data, from paths.ts. */
  d: string;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  /** The line was right-clicked, at (`x`, `y`) in the window. */
  onMenu: (x: number, y: number) => void;
}

/**
 * A link's display (PRD 8.3): a black line, LINE_WIDTH thick, with no arrowheads. A wider, invisible copy of the line
 * underneath takes the clicks (select), double-clicks (edit the weight and description) and right-clicks (select, and open
 * the link popup), since the line itself is hard to hit.
 * Pressing or dragging on it selects no text. Both lines keep their width at any zoom: only their length scales.
 */
export function LinkDisplay({ id, d, selected, onSelect, onEdit, onMenu }: LinkDisplayProps) {
  return (
    <g data-testid="link" data-link-id={id} data-selected={selected}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" pointerEvents="stroke" className="cursor-pointer"
        // A press (or a drag from it) on the line starts no text selection, which would spread into the nodes' text.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect} onDoubleClick={onEdit}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect();
          onMenu(event.clientX, event.clientY);
        }} />
      <path data-testid="link-line" d={d} fill="none" stroke="black" strokeWidth={LINE_WIDTH} vectorEffect="non-scaling-stroke" pointerEvents="none" style={selected ? { filter: SELECTED_GLOW } : undefined} />
    </g>
  );
}
