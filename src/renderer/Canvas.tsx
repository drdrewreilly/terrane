import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react';
import { renderNode } from './handlers';
import { runLayout, type Layout } from './layout';
import { LinkDisplay } from './LinkDisplay';
import { LINE_WIDTH, type Anchor, type Rect } from './paths';
import { bounds, extentAt, fitZoom, viewAt, type Placed } from './view';
import { LinkDialog, linkChanged } from './LinkDialog';

/** Pixels per distance unit: the scale the layout's coordinate space is shown at (9.5). */
const UNIT_PX = 1;
/** Space (in pixels) between the displays and the edges of the canvas. */
const MARGIN = 16;
/** How much a wheel turn zooms: the zoom changes by a factor of e for each ZOOM_RATE pixels of wheel delta. */
const ZOOM_RATE = 500;

const CONNECTION_POINTS: { anchor: Anchor; style: CSSProperties }[] = [
  { anchor: 'top', style: { left: '50%', top: 0 } },
  { anchor: 'top-right', style: { left: '100%', top: 0 } },
  { anchor: 'right', style: { left: '100%', top: '50%' } },
  { anchor: 'bottom-right', style: { left: '100%', top: '100%' } },
  { anchor: 'bottom', style: { left: '50%', top: '100%' } },
  { anchor: 'bottom-left', style: { left: 0, top: '100%' } },
  { anchor: 'left', style: { left: 0, top: '50%' } },
  { anchor: 'top-left', style: { left: 0, top: 0 } },
];

/** A short, stable hash of `text` (cyrb53), as hex: identifies the network a saved layout was worked out for. */
function hash(text: string): string {
  let [h1, h2] = [0xdeadbeef, 0x41c6ce57];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

interface Size {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** A link being dragged: from the point pressed on the source's display (`from`) to the pointer (`to`), in pixels from the content's top left. */
interface Drag {
  source: string;
  from: Point;
  to: Point;
}

interface CanvasProps {
  /** The layout saved for the workspace, if any: used as it is if it was worked out for this network. */
  saved?: SavedLayout;
  /** A layout has been worked out (not taken from `saved`), to be saved. */
  onLayout?: (layout: SavedLayout) => void;
  nodes: NodeRecord[];
  links: WorkspaceLink[];
  onCreateLink: (source: string, target: string) => void;
  /** The user saved the link dialog with a changed weight or description. */
  onUpdateLink: (link: string, input: LinkInput) => void;
  /** The user double-clicked a node's display. */
  onOpenNode: (node: NodeRecord) => void;
  /** The user right-clicked a node's display, at (`x`, `y`) in the window. */
  onNodeMenu: (node: NodeRecord, x: number, y: number) => void;
  /** The node whose display is highlighted, if any. */
  highlighted?: string;
}

/**
 * The canvas (PRD 9.5): the layout's coordinate space, shown at UNIT_PX pixels per distance unit, with each node's
 * display where the layout puts it and each link's display along its path. The canvas never scrolls (and never shows
 * scrollbars): pressing the primary button on an empty part of it shows a grab hand, and dragging moves (pans) the
 * network. The network is centred on the canvas, and each time the layout settles it is centred again.
 *
 * Over the canvas, turning the mouse wheel down zooms out and turning it up zooms in, about the point under the pointer.
 * Zooming out brings the displays closer together; they keep their full size (and their text its size) unless the
 * layout's rules call for them to shrink (see view.ts), and links keep their width. The view at
 * zoom 1 is as far in as it goes; as far out as it goes is the first zoom at which the whole network fits on the
 * canvas. Zooming out keeps the network within reach: it never leaves the network further out of view than it needs
 * to, so at the furthest zoom the whole network is in view. A workspace opens zoomed right out.
 *
 * The layout runs whenever the network changes, starting from the positions of the previous run (or, on opening, of the
 * layout saved in the workspace), and each run is saved in the workspace. On opening, a saved layout worked out for the
 * same network (the same nodes, at the same display sizes, and the same links) is used as it is, and the layout does not
 * run. While a layout is pending, a spinner shows in the centre of the canvas. Pressing on a display and dragging shows a line from the pressed point to the pointer, and
 * releasing over another node's display creates a link from the first node (the source) to the other (the target);
 * releasing over the source's own display, or over no display, creates nothing. Hovering over a display shows its eight
 * connection points (its edges' midpoints and its corners), which for now do nothing: a press on one starts no
 * drag.
 */
export function Canvas({ saved, onLayout, nodes, links, onCreateLink, onUpdateLink, onOpenNode, onNodeMenu, highlighted }: CanvasProps) {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const [sizes, setSizes] = useState(new Map<string, Size>());
  const [layout, setLayout] = useState<Layout>();
  /** The network (see `network` below) the current layout was run for. */
  const [laidOut, setLaidOut] = useState<string>();
  /** Where the current layout came from: the workspace's saved layout, or a run of the layout. */
  const [source, setSource] = useState<'saved' | 'run'>();
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<WorkspaceLink>();
  const [drag, setDrag] = useState<Drag>();
  /** How far (in pixels) the network has been panned from the centre of the canvas. */
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  /** The pan under way, if any: where the pointer was pressed and the pan at that moment. */
  const [panning, setPanning] = useState<{ pointer: Point; pan: Point }>();
  /** The scale the network is shown at: 1 is as far in as it goes. */
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);

  // A display that changes size on its own (one that grows to fit its content once its font is in) renders the canvas
  // again, so it is measured again.
  const [, setResized] = useState(0);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => setResized((count) => count + 1));
    for (const element of elements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [nodes]);

  // Measure each display (in pixels): the layout works with their sizes.
  useLayoutEffect(() => {
    const measured = new Map<string, Size>();
    for (const node of nodes) {
      const element = elements.current.get(node.id);
      if (element) measured.set(node.id, { width: element.offsetWidth, height: element.offsetHeight });
    }
    const same = measured.size === sizes.size && [...measured].every(([id, size]) => sizes.get(id)?.width === size.width && sizes.get(id)?.height === size.height);
    if (!same) setSizes(measured);
  });

  const network = JSON.stringify([nodes.map((node) => [node.id, sizes.get(node.id)]), links.map((link) => [link.id, link.source, link.target, link.weight])]);
  useEffect(() => {
    if (nodes.some((node) => !sizes.has(node.id))) return;
    // The layout saved for this network (on opening the workspace, before any other has been worked out) is used as it is.
    const key = hash(network);
    if (!layout && saved?.network === key && nodes.every((node) => saved.positions[node.id])) {
      setLayout({ positions: new Map(Object.entries(saved.positions)), scale: saved.scale, minSpace: saved.minSpace, satisfied: saved.satisfied });
      setLaidOut(network);
      setSource('saved');
      return;
    }
    // The layout blocks the renderer while it runs, so it waits until the spinner has been painted (the frame, then a
    // task after it); the spinner's CSS animation keeps turning while the layout runs.
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        const units = nodes.map((node) => ({ id: node.id, width: sizes.get(node.id)!.width / UNIT_PX, height: sizes.get(node.id)!.height / UNIT_PX }));
        // Starting from the positions of the last layout: this canvas's, or else the one saved.
        const start = layout?.positions ?? new Map(Object.entries(saved?.positions ?? {}));
        const next = runLayout(units, links, start);
        setLayout(next);
        setLaidOut(network);
        setSource('run');
        const round = (n: number) => Math.round(n * 100) / 100;
        const positions = Object.fromEntries([...next.positions].map(([id, at]) => [id, { x: round(at.x), y: round(at.y) }]));
        if (nodes.length > 0) onLayout?.({ network: key, positions, scale: next.scale, minSpace: next.minSpace, satisfied: next.satisfied });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
    // `network` stands for nodes, links and sizes: the layout runs only when one of them changes.
  }, [network]);
  const waiting = laidOut !== network;

  // Every display the layout has placed: its centre (in pixels, at zoom 1) and its full size.
  const placed = useMemo<Placed[]>(() => {
    const placed: Placed[] = [];
    for (const node of nodes) {
      const at = layout?.positions.get(node.id);
      const size = sizes.get(node.id);
      if (at && size) placed.push({ id: node.id, x: at.x * UNIT_PX, y: at.y * UNIT_PX, ...size });
    }
    return placed;
  }, [nodes, sizes, layout]);
  const routable = useMemo(() => {
    const ids = new Set(placed.map((p) => p.id));
    return links.filter((link) => link.source !== link.target && ids.has(link.source) && ids.has(link.target));
  }, [links, placed]);
  // The links with a clear path at zoom 1: at every other zoom, the displays shrink as far as they must to keep them clear.
  const clear = useMemo(() => {
    const full = viewAt(placed, routable, 1);
    return new Set([...full.paths].filter(([, path]) => path.clear).map(([id]) => id));
  }, [placed, routable]);
  const view = useMemo(() => viewAt(placed, routable, zoom, zoom < 1 ? clear : undefined), [placed, routable, zoom, clear]);
  const { rects, paths } = view;

  // The content takes in every display and every link's path (a curve can bow out beyond the displays), in pixels from
  // the network's anchor, which is at the centre of the canvas (moved by the pan).
  const box = bounds(rects.values(), paths.values(), MARGIN);
  const { width, height } = box;
  const toPx = (rect: Rect, size: Size) => ({ left: rect.x + rect.width / 2 - size.width / 2 - box.x, top: rect.y + rect.height / 2 - size.height / 2 - box.y });

  /** The zoom at which the whole network (with its margin) first fits on the canvas: as far out as zooming goes. */
  // Worked out again only when the network or the canvas's size changes.
  const fitCache = useRef<{ placed: Placed[]; width: number; height: number; zoom: number }>(undefined);
  const fit = () => {
    const element = canvas.current;
    if (!element) return 1;
    const [width, height] = [element.clientWidth, element.clientHeight];
    const cached = fitCache.current;
    if (cached?.placed === placed && cached.width === width && cached.height === height) return cached.zoom;
    const zoom = fitZoom(placed, routable, width, height, MARGIN);
    fitCache.current = { placed, width, height, zoom };
    return zoom;
  };

  // Once the layout has settled, centre the network on the canvas again (at a zoom no further out than now fits it).
  // Until the wheel is first turned (the workspace has just been opened), each layout shows the network zoomed right out.
  const fitting = useRef(true);
  /** The zoom the network is to be centred on the canvas at, once it is shown at it. */
  const centring = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (!layout) return;
    const furthest = fit();
    const next = fitting.current ? furthest : Math.max(zoom, furthest);
    setZoom(next);
    centring.current = next;
  }, [layout]);
  // The network's box need not be centred on its anchor (leaves can move to one side of it), so it is the box that is centred.
  useLayoutEffect(() => {
    if (centring.current === undefined || centring.current !== zoom) return;
    centring.current = undefined;
    setPan({ x: -(box.x + box.width / 2), y: -(box.y + box.height / 2) });
  });

  // Working out a view can take longer than a frame, so the wheel turns that arrive meanwhile are added up and applied
  // together, once a frame, to the latest zoom and pan.
  const latest = useRef({ zoom, pan, fit, placed, routable });
  latest.current = { zoom, pan, fit, placed, routable };
  const wheeled = useRef<{ deltaY: number; clientX: number; clientY: number }>(undefined);
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (event.deltaY === 0) return;
    const pending = wheeled.current;
    wheeled.current = { deltaY: (pending?.deltaY ?? 0) + event.deltaY, clientX: event.clientX, clientY: event.clientY };
    if (!pending) requestAnimationFrame(applyWheel);
  };
  const applyWheel = () => {
    const element = canvas.current;
    const turned = wheeled.current;
    wheeled.current = undefined;
    if (!element || !turned) return;
    const { zoom, pan, fit, placed, routable } = latest.current;
    const next = Math.min(1, Math.max(fit(), zoom * Math.exp(-turned.deltaY / ZOOM_RATE)));
    if (next === zoom) return;
    fitting.current = false;
    // The pointer, from the centre of the canvas; the point of the network under it stays under it (the zoom scales the
    // distances from the network's anchor).
    const area = element.getBoundingClientRect();
    const pointer = { x: turned.clientX - area.left - area.width / 2, y: turned.clientY - area.top - area.height / 2 };
    let x = pointer.x - ((pointer.x - pan.x) * next) / zoom;
    let y = pointer.y - ((pointer.y - pan.y) * next) / zoom;
    if (next < zoom) {
      // Zooming out, the network stays as much in view as it can: wholly inside the canvas along an axis where it is
      // smaller than the canvas, covering it along one where it is larger.
      const extent = extentAt(placed, routable, next, MARGIN);
      const clamp = (value: number, canvasSize: number, start: number, size: number) => {
        const bound = Math.abs(canvasSize - size) / 2;
        const middle = start + size / 2;
        return Math.max(-bound - middle, Math.min(bound - middle, value));
      };
      x = clamp(x, element.clientWidth, extent.x, extent.width);
      y = clamp(y, element.clientHeight, extent.y, extent.height);
    }
    setZoom(next);
    setPan({ x, y });
  };

  /** A point in the window, in pixels from the content's top left. */
  const toContent = (clientX: number, clientY: number): Point => {
    const box = content.current!.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };
  const startDrag = (event: PointerEvent<HTMLElement>, source: string) => {
    // Only the primary button drags a link: a right-click opens the node popup instead.
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = toContent(event.clientX, event.clientY);
    setDrag({ source, from: at, to: at });
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const to = toContent(event.clientX, event.clientY);
    setDrag((current) => current && { ...current, to });
  };
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const source = drag?.source;
    setDrag(undefined);
    if (!source) return;
    // Released over the source's own display (or no display): no link (D6).
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    if (target && target !== source) onCreateLink(source, target);
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <main
        ref={canvas}
        className={`relative min-h-0 flex-1 overflow-hidden ${panning ? 'cursor-grab' : ''}`}
        data-testid="workspace"
        // A click on the background (the canvas itself or its content area, not a display or the dialog) deselects.
        onClick={(event) => {
          if (event.target === canvas.current || event.target === content.current) setSelected(undefined);
        }}
        // A press of the primary button on the background (not a display or a link) starts a pan.
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target !== canvas.current && event.target !== content.current)) return;
          event.preventDefault();
          // preventDefault stops the press clearing any text selection, so it is cleared here.
          window.getSelection()?.removeAllRanges();
          event.currentTarget.setPointerCapture(event.pointerId);
          setPanning({ pointer: { x: event.clientX, y: event.clientY }, pan });
        }}
        onPointerMove={(event) => {
          if (panning) setPan({ x: panning.pan.x + event.clientX - panning.pointer.x, y: panning.pan.y + event.clientY - panning.pointer.y });
        }}
        onPointerUp={() => setPanning(undefined)}
        onPointerCancel={() => setPanning(undefined)}
        onWheel={onWheel}
      >
        {/* The network's anchor at the centre of the canvas, moved by the pan. Nothing is scaled: the view is worked out in pixels. */}
        <div
          ref={content}
          data-testid="network"
          data-zoom={zoom}
          data-layout={source}
          className="absolute left-1/2 top-1/2"
          style={{ width, height, transform: `translate(${Math.round(pan.x + box.x)}px, ${Math.round(pan.y + box.y)}px)` }}
        >
          <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height}>
            <g transform={`translate(${-box.x} ${-box.y})`}>
              {links.map((link) => {
                const path = paths.get(link.id);
                return path ? <LinkDisplay key={link.id} id={link.id} d={path.d} selected={selected === link.id} onSelect={() => setSelected(link.id)} onEdit={() => setEditing(link)} /> : null;
              })}
            </g>
          </svg>
          {nodes.map((node) => {
            const rect = rects.get(node.id);
            const size = sizes.get(node.id);
            const scale = view.scales.get(node.id) ?? 1;
            return (
              <div
                key={node.id}
                ref={(element) => {
                  if (element) elements.current.set(node.id, element);
                  else elements.current.delete(node.id);
                }}
                data-node-id={node.id}
                data-scale={scale}
                data-highlighted={highlighted === node.id}
                className={`group absolute rounded ${highlighted === node.id ? 'outline-2 outline-offset-2 outline-blue-600' : ''}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onNodeMenu(node, event.clientX, event.clientY);
                }}
                onDoubleClick={(event) => {
                  if (!(event.target as Element).closest('[data-testid=connection-point]')) onOpenNode(node);
                }}
                // Positioned at full size and shrunk about its centre: its measured size stays its full size.
                style={rect && size ? { ...toPx(rect, size), transform: scale < 1 ? `scale(${scale})` : undefined } : { left: 0, top: 0, visibility: 'hidden' }}
                onPointerDown={(event) => startDrag(event, node.id)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(undefined)}
              >
                {renderNode(node)}
                {CONNECTION_POINTS.map(({ anchor, style }) => (
                  <span
                    key={anchor}
                    data-testid="connection-point"
                    data-anchor={anchor}
                    className="invisible absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none rounded-full border border-slate-700 bg-white group-hover:visible"
                    style={style}
                    // The connection points do nothing for now: a press on one does not reach the display's own handlers.
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                ))}
              </div>
            );
          })}
          {/* Above the displays, so the end of the line stays visible over the target. */}
          {drag && (
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={width} height={height}>
              <line data-testid="link-drag" x1={drag.from.x} y1={drag.from.y} x2={drag.to.x} y2={drag.to.y} stroke="black" strokeWidth={LINE_WIDTH} vectorEffect="non-scaling-stroke" />
            </svg>
          )}
        </div>
        {editing && (
          <LinkDialog
            link={editing}
            onClose={(input) => {
              setEditing(undefined);
              if (input && linkChanged(editing, input)) onUpdateLink(editing.id, input);
            }}
          />
        )}
      </main>
      {/* Over the canvas rather than in it, so it stays in the centre of what the canvas shows when it is panned. */}
      {waiting && (
        <div data-testid="layout-wait" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-slate-700" />
        </div>
      )}
    </div>
  );
}
