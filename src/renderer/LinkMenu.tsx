import { ITEM_CLASS, MENU_CLASS, MenuBackdrop, useFitted } from './Menu';

/** The popup shown on right-clicking a link, at (`x`, `y`) in the window: for now only "Delete". A press off it cancels. */
export function LinkMenu({ x, y, onDelete, onCancel }: { x: number; y: number; onDelete: () => void; onCancel: () => void }) {
  const [menu, at] = useFitted<HTMLUListElement>(x, y);
  return (
    <MenuBackdrop testId="link-menu-backdrop" onCancel={onCancel}>
      <ul ref={menu} role="menu" data-testid="link-menu" className={MENU_CLASS} style={at}>
        <li role="menuitem" data-testid="link-menu-delete" className={ITEM_CLASS} onClick={onDelete}>
          Delete
        </li>
      </ul>
    </MenuBackdrop>
  );
}
