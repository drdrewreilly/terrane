import { MIN_GAP, ROOM_FOR_LINES, routeLinks, type LinkPath, type Point, type Rect } from './paths';

/**
 * How the network is shown at a zoom. The zoom scales the distances between the displays' centres (about the middle of
 * the box around them). Displays are shown at their full size (their size at zoom 1) at every zoom, except where that
 * would break R1 or R2 at that zoom: then a display shrinks (about its centre) only as far as keeping them needs.
 *
 * - R1 between displays: two displays too close shrink until they are MIN_GAP apart (see shrink).
 * - R1 for lines, and R2: lines are routed afresh at each zoom to keep them (see paths.ts). Where a line cannot be
 *   routed, the displays near its two ends shrink further, to keep ROOM_FOR_LINES apart, which always leaves room for
 *   lines between them; if lines are still shut in after a few rounds, every display keeps that room.
 *
 * Lines keep their width at every zoom.
 */

/** A display, from the layout: its centre at zoom 1 and its full size, in pixels. */
export interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface View {
  /** Each display's rectangle, in pixels from the middle of the network. */
  rects: Map<string, Rect>;
  paths: Map<string, LinkPath>;
  /** The factor each display is shrunk by (1: full size). */
  scales: Map<string, number>;
}

type Link = { id: string; source: string; target: string };

/** The smallest factor a display shrinks to: zooming out stops where the rules could need any smaller (see furthestZoom). */
export const MIN_SCALE = 0.1;
/** How many rounds of making room near shut-in lines are tried before every display is made to keep that room. */
const ROOM_ROUNDS = 4;

/** The middle of the box around the displays' centres: the point a zoom scales the distances from. */
function middle(placed: Placed[]): Point {
  if (placed.length === 0) return { x: 0, y: 0 };
  const xs = placed.map((p) => p.x);
  const ys = placed.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** The displays' centres at `zoom`, in pixels from the middle of the network. */
function centres(placed: Placed[], zoom: number): Point[] {
  const m = middle(placed);
  return placed.map((p) => ({ x: (p.x - m.x) * zoom, y: (p.y - m.y) * zoom }));
}

/** The gap displays i and j must keep: ROOM_FOR_LINES if either is to leave room for lines, MIN_GAP otherwise. */
const gapFor = (roomy: boolean[], i: number, j: number) => (roomy[i] || roomy[j] ? ROOM_FOR_LINES : MIN_GAP);

/**
 * The largest factor for display i, given the others' factors, at which it keeps its gap from every other display:
 * two displays keep a gap when they are that far apart along x or along y.
 */
function largest(placed: Placed[], at: Point[], scales: number[], roomy: boolean[], i: number): number {
  let most = 1;
  for (let j = 0; j < placed.length; j += 1) {
    if (j === i) continue;
    const gap = gapFor(roomy, i, j);
    const alongX = (2 * (Math.abs(at[i].x - at[j].x) - gap) - placed[j].width * scales[j]) / placed[i].width;
    const alongY = (2 * (Math.abs(at[i].y - at[j].y) - gap) - placed[j].height * scales[j]) / placed[i].height;
    most = Math.min(most, Math.max(alongX, alongY));
  }
  return most;
}

/**
 * Each display's factor at the centres `at`, so that every two keep their gap. Each pair that is too close shrinks both
 * of its displays by the same factor, just far enough (shrinking never brings any other pair closer, so one pass keeps
 * every gap); then each display grows back as far as the others now leave it room, so that none is smaller than needed.
 */
function shrink(placed: Placed[], at: Point[], roomy: boolean[]): number[] {
  const scales = placed.map(() => 1);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const [a, b, gap] = [placed[i], placed[j], gapFor(roomy, i, j)];
      const alongX = (2 * (Math.abs(at[i].x - at[j].x) - gap)) / (a.width * scales[i] + b.width * scales[j]);
      const alongY = (2 * (Math.abs(at[i].y - at[j].y) - gap)) / (a.height * scales[i] + b.height * scales[j]);
      const factor = Math.max(alongX, alongY);
      if (factor < 1) [scales[i], scales[j]] = [scales[i] * Math.max(factor, 0), scales[j] * Math.max(factor, 0)];
    }
  }
  for (let i = 0; i < placed.length; i += 1) scales[i] = Math.max(scales[i], Math.min(1, largest(placed, at, scales, roomy, i)));
  return scales;
}

const rectsAt = (placed: Placed[], at: Point[], scales: number[]): Rect[] =>
  placed.map((p, i) => {
    const [width, height] = [p.width * scales[i], p.height * scales[i]];
    return { x: at[i].x - width / 2, y: at[i].y - height / 2, width, height };
  });

/** The view at `zoom`. */
export function viewAt(placed: Placed[], links: Link[], zoom: number): View {
  const at = centres(placed, zoom);
  const index = new Map(placed.map((p, i) => [p.id, i]));
  const requests = links.flatMap((link) => {
    const [source, target] = [index.get(link.source), index.get(link.target)];
    return source === undefined || target === undefined || source === target ? [] : [{ id: link.id, source, target }];
  });
  const roomy = placed.map(() => false);
  for (let round = 0; ; round += 1) {
    const scales = zoom >= 1 && !roomy.includes(true) ? placed.map(() => 1) : shrink(placed, at, roomy);
    const rects = rectsAt(placed, at, scales);
    const paths = routeLinks(rects, requests);
    const shut = requests.filter((request) => !paths.get(request.id)!.clear);
    if (shut.length === 0 || roomy.every(Boolean)) {
      return { rects: new Map(placed.map((p, i) => [p.id, rects[i]])), paths, scales: new Map(placed.map((p, i) => [p.id, scales[i]])) };
    }
    // The displays near each shut-in line's two ends (within the larger of the two's full size) are to leave room.
    let added = false;
    for (const { source, target } of shut) {
      const [a, b] = [rects[source], rects[target]];
      const reach = Math.max(placed[source].width, placed[source].height, placed[target].width, placed[target].height);
      const [x0, y0] = [Math.min(a.x, b.x) - reach, Math.min(a.y, b.y) - reach];
      const [x1, y1] = [Math.max(a.x + a.width, b.x + b.width) + reach, Math.max(a.y + a.height, b.y + b.height) + reach];
      rects.forEach((r, k) => {
        if (!roomy[k] && r.x < x1 && r.x + r.width > x0 && r.y < y1 && r.y + r.height > y0) [roomy[k], added] = [true, true];
      });
    }
    if (!added || round + 1 >= ROOM_ROUNDS) roomy.fill(true);
  }
}

/** The box that takes in every display and every path of a view, with `margin` around it. */
export function bounds(rects: Iterable<Rect>, paths: Iterable<LinkPath>, margin: number): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rects) [x0, y0, x1, y1] = [Math.min(x0, r.x), Math.min(y0, r.y), Math.max(x1, r.x + r.width), Math.max(y1, r.y + r.height)];
  for (const path of paths) for (const p of path.points) [x0, y0, x1, y1] = [Math.min(x0, p.x), Math.min(y0, p.y), Math.max(x1, p.x), Math.max(y1, p.y)];
  if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0 - margin, y: y0 - margin, width: x1 - x0 + 2 * margin, height: y1 - y0 + 2 * margin };
}

/**
 * Roughly the box the displays of the view at `zoom` take up (not their paths), with `margin` around it: their sizes
 * are those that keep R1 between displays (without the further shrinking that makes room for lines), so it is quick.
 */
export function extentAt(placed: Placed[], zoom: number, margin: number): Rect {
  const at = centres(placed, zoom);
  const scales = zoom >= 1 ? placed.map(() => 1) : shrink(placed, at, placed.map(() => false));
  return bounds(rectsAt(placed, at, scales), [], margin);
}

/**
 * As far out as zooming goes: the largest zoom (≤ 1) at which the whole network, paths included, fits in `width` by
 * `height` pixels, but no further out than the zoom at which every two displays can still keep ROOM_FOR_LINES apart at
 * MIN_SCALE (so the rules can always be kept).
 */
export function furthestZoom(placed: Placed[], links: Link[], width: number, height: number, margin: number): number {
  if (placed.length === 0) return 1;
  // The nearest zoom at which some pair could keep ROOM_FOR_LINES apart only by shrinking below MIN_SCALE.
  let floor = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const [a, b] = [placed[i], placed[j]];
      const [dx, dy] = [Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
      const needX = dx > 0 ? (ROOM_FOR_LINES + (MIN_SCALE * (a.width + b.width)) / 2) / dx : Infinity;
      const needY = dy > 0 ? (ROOM_FOR_LINES + (MIN_SCALE * (a.height + b.height)) / 2) / dy : Infinity;
      floor = Math.max(floor, Math.min(needX, needY));
    }
  }
  floor = Math.min(1, floor);
  const fits = (zoom: number) => {
    const view = viewAt(placed, links, zoom);
    const box = bounds(view.rects.values(), view.paths.values(), margin);
    return box.width <= width && box.height <= height;
  };
  if (fits(1)) return 1;
  // The displays' box shrinks steadily as the zoom falls, so the fit is found by halving, on the displays alone, then
  // checked with the paths (which can reach beyond the displays).
  const displaysFit = (zoom: number) => {
    const box = extentAt(placed, zoom, margin);
    return box.width <= width && box.height <= height;
  };
  let [lo, hi] = [floor, 1];
  if (!displaysFit(lo)) return floor;
  for (let k = 0; k < 20; k += 1) {
    const mid = (lo + hi) / 2;
    if (displaysFit(mid)) lo = mid;
    else hi = mid;
  }
  for (let k = 0; k < 8 && lo > floor && !fits(lo); k += 1) lo = Math.max(floor, lo * 0.95);
  return lo;
}
