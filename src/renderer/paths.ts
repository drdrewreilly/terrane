/**
 * Link paths: the line drawn for each link, worked out from the displays' rectangles (in pixels).
 *
 * R1 (for lines): every part of a link's drawn line (LINE_WIDTH wide) is at least MIN_GAP (16 px) from every display
 * but its own two, so the middle of the line keeps LINE_GAP from them.
 * R2: a link's line never crosses a display. It runs from the edge of one of its displays to the edge of the other and
 * never enters either (and, by R1, keeps clear of every other).
 *
 * Within that rule each line is as short as it can be (the shortest path from one display's edge to the other's that
 * avoids the other displays), and is made of straight segments: a single segment where one is clear, and otherwise one
 * that bends only at the corners of the displays in its way (the visibility-graph method, with Dijkstra's algorithm).
 *
 * A line needs room to pass between two displays: where every two displays are at least ROOM_FOR_LINES apart, every
 * link has a clear path. Closer displays can shut a line in; `clear` is false when no path meets R1 and R2.
 */

export interface Point {
  x: number;
  y: number;
}

/** A display: its top-left corner and size. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinkPath {
  /** SVG path data. */
  d: string;
  length: number;
  /** False if no path keeps R2; the line is then drawn straight between the displays' centres. */
  clear: boolean;
  /** The ends of the path's segments, in order. */
  points: Point[];
}

/** A link to route: the indexes of its source and target displays. */
export interface RouteRequest {
  id: string;
  source: number;
  target: number;
}

/** The thickness of a link's line. */
export const LINE_WIDTH = 2;
/** R1: the least gap between two displays, and between a link's line and any display but its own two. */
export const MIN_GAP = 16;
/** How far the middle of a line keeps from every display but its own two: the gap, plus half the line's width. */
export const LINE_GAP = MIN_GAP + LINE_WIDTH / 2;
/** Displays at least this far apart always leave room for lines between them (their LINE_GAP margins do not meet). */
export const ROOM_FOR_LINES = 2 * LINE_GAP + 1;
/** The bounds of the regions (beyond the box around a link's two displays) whose displays are tried first, before all. */
const NEAR = [64, 256];
/** Below this, lengths count as nothing (for touching rather than entering). */
const EPSILON = 1e-6;

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const intersect = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The point of `r` nearest `p`. */
function nearest(r: Rect, p: Point): Point {
  return { x: Math.min(Math.max(p.x, r.x), r.x + r.width), y: Math.min(Math.max(p.y, r.y), r.y + r.height) };
}

/** Whether the segment from `p` to `q` passes through the inside of `r` (touching or running along its edge does not count). */
function enters(p: Point, q: Point, r: Rect): boolean {
  const x0 = r.x + EPSILON;
  const x1 = r.x + r.width - EPSILON;
  const y0 = r.y + EPSILON;
  const y1 = r.y + r.height - EPSILON;
  if (x0 >= x1 || y0 >= y1) return false;
  // A segment wholly to one side of the rectangle cannot enter it (the quick test, as most cannot).
  if ((p.x <= x0 && q.x <= x0) || (p.x >= x1 && q.x >= x1) || (p.y <= y0 && q.y <= y0) || (p.y >= y1 && q.y >= y1)) return false;
  // Clips the segment to each side's half-plane in turn (Liang-Barsky).
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const range = { t0: 0, t1: 1 };
  const clip = (step: number, room: number): boolean => {
    if (Math.abs(step) < 1e-12) return room > 0;
    const t = room / step;
    if (step < 0) range.t0 = Math.max(range.t0, t);
    else range.t1 = Math.min(range.t1, t);
    return range.t0 < range.t1;
  };
  if (!clip(-dx, p.x - x0) || !clip(dx, x1 - p.x) || !clip(-dy, p.y - y0) || !clip(dy, y1 - p.y)) return false;
  return range.t1 - range.t0 > EPSILON;
}

/**
 * The obstacles for a link: every other display, grown by LINE_GAP, and its own two as they are (the line may run
 * up to their edges, but not into them).
 */
function obstacles(rects: Rect[], source: number, target: number): Rect[] {
  return rects.map((r, i) => (i === source || i === target ? r : grow(r, LINE_GAP)));
}

const clearOf = (p: Point, q: Point, blocks: Rect[]) => !blocks.some((r) => enters(p, q, r));

/**
 * The shortest straight segment from `a`'s edge to `b`'s that is clear of `blocks`, if there is one. Where the two face
 * each other (their spans along x, or along y, overlap) every segment across the shared span is as short as the others,
 * and the clear one nearest its middle is used; where they do not, the only shortest segment joins their nearest corners.
 */
function straight(a: Rect, b: Rect, blocks: Rect[]): [Point, Point] | undefined {
  const across = (horizontal: boolean): [Point, Point] | undefined => {
    // `along` is the axis the two share a span on; the segment runs across the other.
    const [pos, size, crossPos, crossSize] = horizontal ? (['y', 'height', 'x', 'width'] as const) : (['x', 'width', 'y', 'height'] as const);
    const lo = Math.max(a[pos], b[pos]);
    const hi = Math.min(a[pos] + a[size], b[pos] + b[size]);
    if (lo > hi) return undefined;
    const [first, second] = a[crossPos] < b[crossPos] ? [a, b] : [b, a];
    const [from, to] = [first[crossPos] + first[crossSize], second[crossPos]];
    if (from > to) return undefined;
    // The span, less the parts where another display lies across the gap between the two.
    let free: [number, number][] = [[lo, hi]];
    for (const r of blocks) {
      if (r === a || r === b || !(r[crossPos] < to && r[crossPos] + r[crossSize] > from)) continue;
      const [cut0, cut1] = [r[pos], r[pos] + r[size]];
      free = free.flatMap(([l, h]): [number, number][] => (cut1 <= l || cut0 >= h ? [[l, h]] : ([[l, Math.min(h, cut0)], [Math.max(l, cut1), h]] as [number, number][]).filter(([x, y]) => y >= x)));
    }
    const middle = (lo + hi) / 2;
    const places = free.map(([l, h]) => Math.min(Math.max(middle, l), h)).sort((p, q) => Math.abs(p - middle) - Math.abs(q - middle));
    for (const place of places) {
      const ends: [Point, Point] = horizontal ? [{ x: from, y: place }, { x: to, y: place }] : [{ x: place, y: from }, { x: place, y: to }];
      if (clearOf(ends[0], ends[1], blocks)) return first === a ? ends : [ends[1], ends[0]];
    }
    return undefined;
  };
  const facing = across(true) ?? across(false);
  if (facing) return facing;
  const xOverlap = Math.max(a.x, b.x) <= Math.min(a.x + a.width, b.x + b.width);
  const yOverlap = Math.max(a.y, b.y) <= Math.min(a.y + a.height, b.y + b.height);
  if (xOverlap || yOverlap) return undefined;
  const corner = (r: Rect, other: Rect): Point => ({ x: r.x + r.width < other.x ? r.x + r.width : r.x, y: r.y + r.height < other.y ? r.y + r.height : r.y });
  const ends: [Point, Point] = [corner(a, b), corner(b, a)];
  return clearOf(ends[0], ends[1], blocks) ? ends : undefined;
}

/**
 * The shortest path from `a`'s edge to `b`'s that bends at corners of `blocks` (other than `a` and `b`) and is clear of
 * them all, or undefined if there is none. A shortest path that bends first at a corner leaves `a` at the point of `a`
 * nearest that corner, and reaches `b` at the point of `b` nearest the last.
 */
function around(a: Rect, b: Rect, blocks: Rect[]): Point[] | undefined {
  const corners = blocks
    .filter((r) => r !== a && r !== b)
    .flatMap((r) => [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }])
    .filter((c) => !blocks.some((r) => c.x > r.x + EPSILON && c.x < r.x + r.width - EPSILON && c.y > r.y + EPSILON && c.y < r.y + r.height - EPSILON));
  const n = corners.length;
  const cost = corners.map((c) => (clearOf(nearest(a, c), c, blocks) ? distance(nearest(a, c), c) : Infinity));
  const previous = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  let [end, endCost] = [-1, Infinity];
  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k += 1) if (!done[k] && cost[k] < Infinity && (i < 0 || cost[k] < cost[i])) i = k;
    if (i < 0 || cost[i] >= endCost) break;
    done[i] = true;
    const atB = nearest(b, corners[i]);
    if (clearOf(corners[i], atB, blocks) && cost[i] + distance(corners[i], atB) < endCost) [end, endCost] = [i, cost[i] + distance(corners[i], atB)];
    for (let k = 0; k < n; k += 1) {
      const via = cost[i] + distance(corners[i], corners[k]);
      if (!done[k] && via < cost[k] && clearOf(corners[i], corners[k], blocks)) [cost[k], previous[k]] = [via, i];
    }
  }
  if (end < 0) return undefined;
  const path = [nearest(b, corners[end])];
  for (let k = end; k >= 0; k = previous[k]) path.unshift(corners[k]);
  path.unshift(nearest(a, path[0]));
  return path;
}

function pathOf(points: Point[], clear: boolean): LinkPath {
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  let length = 0;
  for (let k = 1; k < points.length; k += 1) length += distance(points[k - 1], points[k]);
  return { d: points.map((p, k) => `${k ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join(' '), length, clear, points };
}

/** The path of the link between `rects[source]` and `rects[target]`. */
function routeLink(rects: Rect[], source: number, target: number): LinkPath {
  const [a, b] = [rects[source], rects[target]];
  const blocks = obstacles(rects, source, target);
  const [ga, gb] = [blocks[source], blocks[target]];
  const line = straight(ga, gb, blocks);
  if (line) return pathOf(line, true);
  // The visibility graph grows with the number of displays, so it is tried first with only the displays near the two,
  // then with all of them. A path found with fewer is kept only if it is clear of them all, and is then no longer than
  // the path all of them would give.
  const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) };
  for (const reach of [...NEAR, Infinity]) {
    const region = grow(box, reach);
    const near = reach === Infinity ? blocks : blocks.filter((r) => r === ga || r === gb || intersect(region, r));
    if (reach !== Infinity && near.length === blocks.length) continue;
    const path = around(ga, gb, near);
    if (path && path.every((p, k) => k === 0 || clearOf(path[k - 1], p, blocks))) return pathOf(path, true);
  }
  return pathOf([centre(a), centre(b)], false);
}

/** The paths of the given links between the displays `rects`. */
export function routeLinks(rects: Rect[], links: RouteRequest[]): Map<string, LinkPath> {
  return new Map(links.map((link) => [link.id, routeLink(rects, link.source, link.target)]));
}
