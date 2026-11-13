import { ITEM_CLASS, MENU_CLASS, MenuBackdrop, useFitted } from './Menu';

/** The popup shown on right-clicking an empty part of the canvas, at (`x`, `y`) in the window: for now only "Create node". A press off it cancels. */
export function CanvasMenu({ x, y, onCreateNode, onCancel }: { x: number; y: number; onCreateNode: () => void; onCancel: () => void }) {
  const [menu, at] = useFitted<HTMLUListElement>(x, y);
  return (
    <MenuBackdrop testId="canvas-menu-backdrop" onCancel={onCancel}>
      <ul ref={menu} role="menu" data-testid="canvas-menu" className={MENU_CLASS} style={at}>
        <li role="menuitem" data-testid="canvas-menu-create-node" className={ITEM_CLASS} onClick={onCreateNode}>
          Create node
        </li>
      </ul>
    </MenuBackdrop>
  );
}
