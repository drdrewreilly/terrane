import { MIN_SPACE } from './layout';
import { CLEARANCE, LINE_WIDTH, routeLinks, segmentsCross, type LinkPath, type Point, type Rect, type RouteRequest } from './paths';

/**
 * How the network is shown at a zoom (the canvas's view of it). The zoom scales the distances between the displays'
 * centres; it does not scale the displays themselves, which keep their full size (their size at zoom 1) unless keeping
 * it would break the layout's rules at that zoom:
 *
 * 1. the minimum space (MIN_SPACE) between displays (9.4);
 * 2. no link crosses a display (every link that has a clear path at zoom 1 has one at this zoom; see paths.ts).
 *
 * Each display is shrunk on its own, only as far as its own neighbours call for: a display with room around it stays
 * at full size, and one that is shrunk is as large as it can be, the minimum space from at least one neighbour (see
 * spacedScales). A display linked only to one other display (a leaf) may also move round that display, so that its
 * link leaves it from another side or corner, where that lets it be larger (see arrange). Displays are shrunk further
 * to keep links clear only where that works (see viewAt). Everything is
 * worked out in pixels on the canvas, so links' widths and clearances are the same at every zoom; their paths are
 * routed afresh at each zoom.
 */

/** A display, from the layout: its centre (in distance units) and its full size (in pixels). */
export interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface View {
  /** Each display's rectangle, in pixels from the network's anchor (see anchor). */
  rects: Map<string, Rect>;
  paths: Map<string, LinkPath>;
  /** The factor each display is shrunk by (1: full size). */
  scales: Map<string, number>;
}

/** The smallest factor displays are shrunk to: below it they are not worth showing smaller. */
const MIN_SCALE = 0.05;
/** How much a display shrinks each time a link has no clear path at the scale tried. */
const SHRINK = 0.85;
const SHRINK_TRIES = 10;
/** The directions (evenly spaced, starting along the x axis, so including both axes and both diagonals) a leaf is tried in. */
const LEAF_DIRECTIONS = 24;
/** The scales a leaf is tried at in each direction, largest first. */
const LEAF_SCALES = [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.18, 0.12, MIN_SCALE];

type Link = { id: string; source: string; target: string };

/** The point of the layout's space that a zoom scales about: the middle of the displays' centres. */
export function anchor(placed: Placed[]): Point {
  if (placed.length === 0) return { x: 0, y: 0 };
  const xs = placed.map((p) => p.x);
  const ys = placed.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/**
 * The largest scale (≤ 1) for `a` at which it keeps the minimum space from `b` (at `bScale`) at `zoom`: the space
 * between them is the larger of their gaps along x and along y, so either axis may provide it.
 */
function room(a: Placed, b: Placed, bScale: number, zoom: number): number {
  const alongX = (Math.abs(a.x - b.x) * zoom - MIN_SPACE - (b.width * bScale) / 2) / (a.width / 2);
  const alongY = (Math.abs(a.y - b.y) * zoom - MIN_SPACE - (b.height * bScale) / 2) / (a.height / 2);
  return Math.max(alongX, alongY);
}

/**
 * Each display's scale at `zoom`: the largest at which it keeps the minimum space from every other display.
 *
 * It starts from a scale every pair can meet together (each display at the smallest scale that, shared with each of
 * its neighbours, keeps their space), then grows each display, one at a time, as far as its neighbours' scales leave
 * room, until none can grow. Each step keeps every space, so the result does; and a display it leaves shrunk is the
 * minimum space from a neighbour.
 */
export function spacedScales(placed: Placed[], zoom: number, always = false): number[] {
  const scales = placed.map(() => 1);
  if (zoom >= 1 && !always) return scales;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const [a, b] = [placed[i], placed[j]];
      const alongX = ((Math.abs(a.x - b.x) * zoom - MIN_SPACE) * 2) / (a.width + b.width);
      const alongY = ((Math.abs(a.y - b.y) * zoom - MIN_SPACE) * 2) / (a.height + b.height);
      const shared = Math.max(alongX, alongY);
      scales[i] = Math.min(scales[i], shared);
      scales[j] = Math.min(scales[j], shared);
    }
  }
  for (let pass = 0; pass < 20; pass += 1) {
    let grown = false;
    for (let i = 0; i < placed.length; i += 1) {
      if (scales[i] >= 1) continue;
      let most = 1;
      for (let j = 0; j < placed.length && most > scales[i]; j += 1) if (j !== i) most = Math.min(most, room(placed[i], placed[j], scales[j], zoom));
      if (most > scales[i] + 1e-6) {
        scales[i] = most;
        grown = true;
      }
    }
    if (!grown) break;
  }
  return scales.map((scale) => Math.max(MIN_SCALE, scale));
}

const centreOf = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const rectAround = (c: Point, width: number, height: number): Rect => ({ x: c.x - width / 2, y: c.y - height / 2, width, height });
const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

/** The space between two rectangles, for the minimum space: the larger of their gaps along x and along y. */
function spaceBetween(a: Rect, b: Rect): number {
  const [ca, cb] = [centreOf(a), centreOf(b)];
  return Math.max(Math.abs(ca.x - cb.x) - (a.width + b.width) / 2, Math.abs(ca.y - cb.y) - (a.height + b.height) / 2);
}

/** Whether the segment from `a` to `b` passes through the rectangle `r` (Liang-Barsky clipping). */
function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  let [t0, t1] = [0, 1];
  const sides: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.width - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.height - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Where the line from the centre of `r` towards `towards` leaves `r`. */
function edgeToward(r: Rect, towards: Point): Point {
  const c = centreOf(r);
  const [dx, dy] = [towards.x - c.x, towards.y - c.y];
  const t = Math.min(dx ? r.width / 2 / Math.abs(dx) : Infinity, dy ? r.height / 2 / Math.abs(dy) : Infinity, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The straight segment a link's line roughly takes: between the edges of its two displays, along the line joining their centres. */
function linkSegment(a: Rect, b: Rect): [Point, Point] {
  return [edgeToward(a, centreOf(b)), edgeToward(b, centreOf(a))];
}

/**
 * Where each display is shown at `zoom` (in pixels from the network's anchor), and the scale it is shown at.
 *
 * Every display but the leaves sits where the zoom puts it (its distance from the anchor scaled by the zoom), at the
 * largest scale that keeps the minimum space from the others (spacedScales). Each leaf (a display with one link, to a
 * display that has others: its hub) is then placed in turn: where the zoom puts it or, if that lets it be larger, in
 * another direction from its hub, so that its link leaves the hub from another side or corner. It keeps the gap from
 * its hub the zoom gives it (and no less than the minimum space). Another direction is used only if it meets the rules
 * there: the minimum space from every other display, a link that passes no other display within the clearance, no
 * other link through the leaf, and (where the zoomed position meets these) no more links crossed. Of the directions
 * that let the leaf be largest, the one nearest its zoomed direction is used. At zoom 1 every display is where the
 * layout put it, at full size.
 */
function arrange(placed: Placed[], links: Link[], zoom: number): { rects: Rect[]; scales: number[] } {
  const centre = anchor(placed);
  const zoomed = placed.map((p) => ({ x: (p.x - centre.x) * zoom, y: (p.y - centre.y) * zoom }));
  if (zoom >= 1) return { rects: placed.map((p, i) => rectAround(zoomed[i], p.width, p.height)), scales: placed.map(() => 1) };

  const index = new Map(placed.map((p, i) => [p.id, i]));
  const ends: [number, number][] = [];
  for (const link of links) {
    const [a, b] = [index.get(link.source), index.get(link.target)];
    if (a !== undefined && b !== undefined && a !== b) ends.push([a, b]);
  }
  const degree = placed.map(() => 0);
  for (const [a, b] of ends) {
    degree[a] += 1;
    degree[b] += 1;
  }
  const hubOf = new Map<number, number>();
  for (const [a, b] of ends) {
    if (degree[a] === 1 && degree[b] > 1) hubOf.set(a, b);
    if (degree[b] === 1 && degree[a] > 1) hubOf.set(b, a);
  }

  // Everything but the leaves, at the scales that keep the minimum space between them.
  const core = placed.map((_, i) => i).filter((i) => !hubOf.has(i));
  const coreScales = spacedScales(core.map((i) => ({ ...placed[i], x: zoomed[i].x, y: zoomed[i].y })), 1, true);
  const rects: (Rect | undefined)[] = placed.map(() => undefined);
  const scales = placed.map(() => 1);
  core.forEach((i, k) => {
    scales[i] = coreScales[k];
    rects[i] = rectAround(zoomed[i], placed[i].width * scales[i], placed[i].height * scales[i]);
  });

  // The links shown so far (both ends placed), as straight segments.
  const segments = () =>
    ends
      .filter(([a, b]) => rects[a] && rects[b])
      .map(([a, b]) => {
        const [from, to] = linkSegment(rects[a]!, rects[b]!);
        return { a, b, from, to };
      });

  // The leaves, hub by hub, each hub's in order round it.
  const angleFrom = (hub: number, k: number) => Math.atan2(zoomed[k].y - zoomed[hub].y, zoomed[k].x - zoomed[hub].x);
  const leaves = [...hubOf.keys()].sort((i, j) => {
    const [hi, hj] = [hubOf.get(i)!, hubOf.get(j)!];
    return hi !== hj ? hi - hj : angleFrom(hi, i) - angleFrom(hi, j);
  });
  for (const leaf of leaves) {
    const hub = hubOf.get(leaf)!;
    const hubRect = rects[hub]!;
    const hubCentre = centreOf(hubRect);
    const { width, height } = placed[leaf];
    const others: { r: Rect; k: number }[] = [];
    rects.forEach((r, k) => {
      if (r && k !== leaf) others.push({ r, k });
    });
    const shown = segments();

    // Whether the leaf can be at `rect`, and how many links its link then crosses.
    const check = (rect: Rect): { ok: boolean; crossings: number } => {
      if (others.some(({ r }) => spaceBetween(rect, r) < MIN_SPACE - 1e-6)) return { ok: false, crossings: 0 };
      const [from, to] = linkSegment(hubRect, rect);
      if (others.some(({ r, k }) => k !== hub && segmentHitsRect(from, to, inflate(r, CLEARANCE)))) return { ok: false, crossings: 0 };
      const keep = inflate(rect, CLEARANCE + LINE_WIDTH / 2);
      if (shown.some((s) => segmentHitsRect(s.from, s.to, keep))) return { ok: false, crossings: 0 };
      return { ok: true, crossings: shown.filter((s) => s.a !== hub && s.b !== hub && segmentsCross(from, to, s.from, s.to)).length };
    };

    // Where the zoom puts it, at the largest scale there that keeps the minimum space.
    const at = zoomed[leaf];
    let scale = 1;
    for (const { r } of others) {
      const c = centreOf(r);
      const alongX = (Math.abs(at.x - c.x) - r.width / 2 - MIN_SPACE) / (width / 2);
      const alongY = (Math.abs(at.y - c.y) - r.height / 2 - MIN_SPACE) / (height / 2);
      scale = Math.min(scale, Math.max(alongX, alongY));
    }
    scale = Math.max(MIN_SCALE, scale);
    let best = { rect: rectAround(at, width * scale, height * scale), scale, turn: 0 };
    const baseline = check(best.rect);

    // The gap from the hub the zoom gives it: its gap at zoom 1, scaled, and no less than the minimum space.
    const fullGap = spaceBetween(rectAround({ x: placed[hub].x, y: placed[hub].y }, placed[hub].width, placed[hub].height), rectAround({ x: placed[leaf].x, y: placed[leaf].y }, width, height));
    const gap = Math.max(MIN_SPACE, fullGap * zoom);
    const zoomedAngle = angleFrom(hub, leaf);
    for (let d = 0; d < LEAF_DIRECTIONS; d += 1) {
      const angle = (2 * Math.PI * d) / LEAF_DIRECTIONS;
      const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
      const turn = Math.abs(Math.atan2(Math.sin(angle - zoomedAngle), Math.cos(angle - zoomedAngle)));
      for (const tried of LEAF_SCALES) {
        // Only larger than the best so far, or as large and nearer the zoomed direction (so never as large as the zoomed
        // position itself, which has no turn).
        if (tried < best.scale || (tried === best.scale && turn >= best.turn)) break;
        const [w, h] = [width * tried, height * tried];
        // As near the hub as keeps the gap, along this direction.
        const t = Math.min(
          Math.abs(ux) > 1e-9 ? ((hubRect.width + w) / 2 + gap) / Math.abs(ux) : Infinity,
          Math.abs(uy) > 1e-9 ? ((hubRect.height + h) / 2 + gap) / Math.abs(uy) : Infinity,
        );
        const rect = rectAround({ x: hubCentre.x + ux * t, y: hubCentre.y + uy * t }, w, h);
        const result = check(rect);
        if (result.ok && (!baseline.ok || result.crossings <= baseline.crossings)) {
          best = { rect, scale: tried, turn };
          break;
        }
      }
    }
    rects[leaf] = best.rect;
    scales[leaf] = best.scale;
  }
  return { rects: rects as Rect[], scales };
}

function route(rects: Map<string, Rect>, links: Link[]): Map<string, LinkPath> {
  const ids = [...rects.keys()];
  const requests: RouteRequest[] = links.map((link) => ({ id: link.id, source: ids.indexOf(link.source), target: ids.indexOf(link.target) }));
  return routeLinks([...rects.values()], requests);
}

/**
 * The view at `zoom`. `clear` holds the links that have a clear path at zoom 1 (absent at zoom 1 itself): each should
 * have one at this zoom too. Where one does not, the displays its path passes within the clearance of (other than its
 * own two) are shrunk a step, and it and the links of the shrunk displays are routed again; this is kept only while it
 * clears more of them, so displays are never shrunk where that does not help.
 */
export function viewAt(placed: Placed[], links: Link[], zoom: number, clear?: Set<string>): View {
  const arranged = arrange(placed, links, zoom);
  const scales = [...arranged.scales];
  const rectOf = (i: number) => rectAround(centreOf(arranged.rects[i]), placed[i].width * scales[i], placed[i].height * scales[i]);
  let rects = new Map(placed.map((p, i) => [p.id, rectOf(i)]));
  let paths = route(rects, links);
  const blocked = () => (clear ? [...clear].filter((id) => paths.get(id)?.clear === false) : []);

  const byId = new Map(links.map((link) => [link.id, link]));
  for (let round = 0, stuck = blocked(); stuck.length > 0 && round < SHRINK_TRIES; round += 1) {
    // The displays in the way of the blocked links.
    const inWay = new Set<number>();
    for (const id of stuck) {
      const link = byId.get(id)!;
      for (const [k, r] of [...rects.values()].entries()) {
        if (placed[k].id === link.source || placed[k].id === link.target || scales[k] <= MIN_SCALE) continue;
        const near = inflate(r, CLEARANCE);
        if (paths.get(id)!.points.some((p) => p.x > near.x && p.x < near.x + near.width && p.y > near.y && p.y < near.y + near.height)) inWay.add(k);
      }
    }
    if (inWay.size === 0) break;
    const before = [...scales];
    for (const k of inWay) scales[k] = Math.max(MIN_SCALE, scales[k] * SHRINK);
    const nextRects = new Map(placed.map((p, i) => [p.id, rectOf(i)]));
    // Route again the blocked links and every link of a shrunk display (their ends have moved).
    const shrunk = new Set([...inWay].map((k) => placed[k].id));
    const again = links.filter((link) => stuck.includes(link.id) || shrunk.has(link.source) || shrunk.has(link.target));
    const nextPaths = new Map(paths);
    for (const [id, path] of route(nextRects, again)) nextPaths.set(id, path);
    const nextStuck = clear ? [...clear].filter((id) => nextPaths.get(id)?.clear === false) : [];
    if (nextStuck.length >= stuck.length) {
      scales.splice(0, scales.length, ...before);
      break;
    }
    [rects, paths, stuck] = [nextRects, nextPaths, nextStuck];
  }
  return { rects, paths, scales: new Map(placed.map((p, i) => [p.id, scales[i]])) };
}

/** The box (in pixels from the anchor) that takes in every display and every path of a view, with `margin` around it. */
export function bounds(rects: Iterable<Rect>, paths: Iterable<LinkPath>, margin: number): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const extend = (x: number, y: number) => ([x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]);
  for (const r of rects) {
    extend(r.x, r.y);
    extend(r.x + r.width, r.y + r.height);
  }
  for (const path of paths) for (const p of path.points) extend(p.x, p.y);
  if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0 - margin, y: y0 - margin, width: x1 - x0 + 2 * margin, height: y1 - y0 + 2 * margin };
}

/**
 * Roughly the box a view at `zoom` takes up (its displays, as arranged, not its paths): cheap enough to work out many
 * times over, as fitZoom does.
 */
export function extentAt(placed: Placed[], links: Link[], zoom: number, margin: number): Rect {
  return bounds(arrange(placed, links, zoom).rects, [], margin);
}

/** The largest zoom (≤ 1) at which the whole network, paths included, fits in `width` by `height` pixels: as far out as zooming goes. */
export function fitZoom(placed: Placed[], links: Link[], width: number, height: number, margin: number): number {
  const fits = (zoom: number) => {
    const box = extentAt(placed, links, zoom, margin);
    return box.width <= width && box.height <= height;
  };
  if (placed.length === 0 || fits(1)) return 1;
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  // The estimate leaves out the links' paths, which can bow out beyond the displays: check the view itself, and zoom out
  // a little further while it does not fit.
  let zoom = Math.max(lo, 1e-3);
  for (let tries = 0; tries < 4; tries += 1) {
    const view = viewAt(placed, links, zoom);
    const box = bounds(view.rects.values(), view.paths.values(), margin);
    if (box.width <= width && box.height <= height) break;
    zoom *= Math.min(width / box.width, height / box.height) * 0.99;
  }
  return zoom;
}
