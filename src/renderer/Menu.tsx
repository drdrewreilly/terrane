import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** The look of a popup's list, and of an item in it. */
export const MENU_CLASS = 'fixed max-h-80 overflow-auto rounded border border-slate-300 bg-white py-1 text-sm shadow-lg';
export const ITEM_CLASS = 'cursor-pointer whitespace-pre px-3 py-0.5 hover:bg-slate-100';

/**
 * A popup's position: (`x`, `y`) in the window, moved left or up as far as the popup needs to stay inside the window. If
 * it would run off the right and `leftOf` is given, it goes to the left of `leftOf` instead (a submenu, which then opens
 * on the other side of its menu).
 */
export function useFitted<T extends HTMLElement>(x: number, y: number, leftOf?: number) {
  const ref = useRef<T>(null);
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const [width, height] = [element.offsetWidth, element.offsetHeight];
    let left = x;
    if (left + width > window.innerWidth) left = leftOf !== undefined && leftOf - width >= 0 ? leftOf - width : window.innerWidth - width;
    const top = Math.max(0, Math.min(y, window.innerHeight - height));
    left = Math.max(0, left);
    if (left !== at.left || top !== at.top) setAt({ left, top });
  });
  return [ref, at] as const;
}

/** What is under a popup: it covers the window, and a press on it (off the popup) cancels the popup. */
export function MenuBackdrop({ testId, onCancel, children }: { testId: string; onCancel: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50"
      data-testid={testId}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>
  );
}
