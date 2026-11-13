import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

interface SplitViewProps {
  first: ReactNode;
  second: ReactNode;
  /** The first area's (left or top) starting share of the total width or height (0 to 1); with `sizeSecond`, the second area's. */
  initialFirst: number;
  /**
   * The second area (right or bottom) is the one given a size, and the first takes the rest, so that the first is the one
   * that grows and shrinks with the split view. Not with `fitFirst`.
   */
  sizeSecond?: boolean;
  direction: 'row' | 'column';
  /**
   * The first area is never larger than its content, so dragging cannot open empty space after it. It fits its content
   * until the splitter is dragged short of the content; it then keeps the dragged size (or its content's, if that becomes
   * smaller) until the splitter is dragged back to the end of the content. It is sized again whenever the content or the
   * split view changes size.
   */
  fitFirst?: boolean;
}

/**
 * Two areas separated by a splitter that can be dragged to change how the space is shared between them: side by side
 * (`direction` "row", a vertical splitter) or one above the other ("column", a horizontal splitter). The sized area (the
 * first, or the second with `sizeSecond`) is never so large that the splitter is pushed out of view.
 */
export function SplitView({ first, second, initialFirst, direction, fitFirst = false, sizeSecond = false }: SplitViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const firstArea = useRef<HTMLDivElement>(null);
  const splitter = useRef<HTMLDivElement>(null);
  const [firstShare, setFirstShare] = useState(initialFirst);
  /** With `fitFirst`: the size (in pixels) the splitter was dragged to, or null while the first area fits its content. */
  const dragged = useRef<number | null>(null);
  const row = direction === 'row';

  /** The size of the first area's content (in pixels). */
  const contentSize = () => {
    const element = firstArea.current?.firstElementChild as HTMLElement | null | undefined;
    return element ? (row ? element.offsetWidth : element.offsetHeight) : 0;
  };

  /** Sets the first area's size (in pixels), kept between 0 and the room the splitter leaves (and, with `fitFirst`, its content's size). */
  const setFirstSize = (size: number) => {
    const total = row ? container.current!.clientWidth : container.current!.clientHeight;
    const room = total - (row ? splitter.current!.offsetWidth : splitter.current!.offsetHeight);
    const most = fitFirst ? Math.min(room, contentSize()) : room;
    if (total > 0) setFirstShare(Math.max(0, Math.min(most, size)) / total);
  };

  useLayoutEffect(() => {
    if (!fitFirst) return;
    const content = () => firstArea.current!.firstElementChild as HTMLElement | null;
    const fit = () => setFirstSize(dragged.current ?? Infinity);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container.current!);
    const element = content();
    if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [fitFirst, row]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return;
    const box = container.current.getBoundingClientRect();
    const at = row ? event.clientX - box.left : event.clientY - box.top;
    // With `sizeSecond`, the size set is the second area's: from the splitter's far side to the end.
    const size = sizeSecond ? (row ? box.width : box.height) - at - (row ? splitter.current!.offsetWidth : splitter.current!.offsetHeight) : at;
    // Dragged to (or past) the end of the content, the first area goes back to fitting it.
    if (fitFirst) dragged.current = size >= contentSize() - 0.5 ? null : Math.max(0, size);
    setFirstSize(size);
  };

  /** The size of the sized area (the first, or with `sizeSecond` the second). */
  const sized = row ? { width: `${firstShare * 100}%` } : { height: `${firstShare * 100}%` };

  return (
    <div ref={container} className={`flex min-h-0 min-w-0 flex-1 ${row ? '' : 'flex-col'}`}>
      <div ref={firstArea} className={`flex min-h-0 min-w-0 flex-col overflow-auto ${sizeSecond ? 'flex-1' : 'shrink-0'}`} style={sizeSecond ? undefined : sized}>
        {first}
      </div>
      <div
        ref={splitter}
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        data-testid="splitter"
        className={`shrink-0 touch-none bg-slate-200 hover:bg-slate-400 ${row ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={onPointerMove}
      />
      <div className={`flex min-h-0 min-w-0 flex-col overflow-auto ${sizeSecond ? 'shrink-0' : 'flex-1'}`} style={sizeSecond ? sized : undefined}>
        {second}
      </div>
    </div>
  );
}
