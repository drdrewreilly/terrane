import { LINE_GAP, MIN_GAP, ROOM_FOR_LINES, routeLinks, type LinkPath, type Point } from './paths';

/**
 * The layout: positions the node displays (their centres, in pixels at zoom 1).
 *
 * Rules, always met:
 *
 * - R1. At least MIN_GAP (16 px) between every two displays (they are that far apart along x or along y), and between
 *   every link's line and every display but its own two.
 * - R2. No link's line crosses a display.
 *
 * The lines are routed to keep both (see paths.ts); a line can be shut in where displays are too close for it to pass
 * between them, and spreading the displays out always makes room for it.
 *
 * Preferences, met as far as the rules allow, for each link of weight w (1 to 10), with `target(w)` longer for a lower
 * weight:
 *
 * - P1. The distance between its two displays' borders (the shortest distance from the edge of one to the edge of the
 *   other) is `target(w)`.
 * - P2. Its line is `target(w)` long.
 * - P3. P1 and P2 are balanced alike across the links: the variance, across all links, of (P1 error − P2 error) is as
 *   small as it can be, where each error is the distance or length less the target.
 *
 * A straight line runs between the displays' nearest points, so its length is the border distance, and P1 and P2 then
 * agree. P1 error − P2 error is the border distance less the line's length: how much further the line goes than the
 * straight way, as negative. P3 keeps that detour alike for every link, so it counts against lines that wind round
 * other displays.
 *
 * The preferences are measured by one score, made as low as the rules allow: the sum over the links of
 * (P1 error² + P2 error²), plus the sum over the links of the squared difference of (P1 error − P2 error) from its mean.
 *
 * A run:
 *
 * 1. Places each display that has no position (see seed).
 * 2. Descends the score, taking each link's line to be straight (the shortest it can be): every display moves a step
 *    down the score's slope, the steps shrinking as it goes. After each step, displays that come within R1's gap of
 *    another link's straight line are moved away from it, and then displays that break R1 between displays are moved apart.
 * 3. Routes the lines. Where a line cannot be routed, the displays near its ends are moved apart until they are
 *    ROOM_FOR_LINES apart (which always leaves room for a line between them). If lines are still shut in after a few
 *    rounds, all the displays are spread out about their middle (which only widens the gaps) until every line can be.
 * 4. Refines with the lines as they are routed: moves one display at a time, wherever lowers the score most, keeping a
 *    move only if R1 and R2 still hold.
 *
 * Each run starts from the positions it is given: none after a node or link is added or deleted, or when asked to lay out
 * from scratch; otherwise those of the previous run, or those saved in the workspace (see Canvas.tsx).
 */

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutLink {
  id: string;
  source: string;
  target: string;
  weight: number;
}

export interface Layout {
  /** The centre of each display. */
  positions: Map<string, Point>;
  /** True if both rules were met (they always should be). */
  satisfied: boolean;
}

/** Identifies the algorithm in the saved layout's network key, so layouts saved by another are not reused. */
export const LAYOUT_ALGORITHM = 'r1-lines-r2-p1-borders-p2-p3';

/** The target of a link of weight 10, and how much longer it is for each step down in weight. */
const SHORTEST = 40;
const STEP = 30;

/** Step 2: its number of steps, the most a display moves in its first step and in its last, and its rate of descent. */
const DESCENT_STEPS = 400;
const FIRST_MOVE = 50;
const LAST_MOVE = 1;
const RATE = 0.1;
/** How much of a line's shortfall from LINE_GAP each descent step makes up (see keepLinesClear). */
const LINE_PUSH = 1;
/** Step 3: how many rounds of moving displays apart near shut-in lines, then how much each spreading stretches the positions. */
const ROOM_ROUNDS = 4;
const SPREAD = 1.1;
/** Step 4: the first and last distance a display is tried at, how many of its moves are routed, and the most paths worked out. */
const FIRST_TRY = 64;
const LAST_TRY = 2;
const ROUTED_MOVES = 3;
const MAX_PATHS = 20000;
/** Step 4: how many spots, evenly spaced, a display is tried at round each display it is linked to. */
const SPOTS = 24;

/** P1 and P2: the target border distance and line length for a weight. */
export function target(weight: number): number {
  return SHORTEST + STEP * (10 - weight);
}

interface Link {
  a: number;
  b: number;
  target: number;
}

/** How far apart two displays are along x and along y, beyond their edges (negative where they overlap on that axis). */
function apart(a: LayoutNode, p: Point, b: LayoutNode, q: Point): [number, number] {
  return [Math.abs(q.x - p.x) - (a.width + b.width) / 2, Math.abs(q.y - p.y) - (a.height + b.height) / 2];
}

/** Whether two displays keep R1's gap between displays. */
function keepsR1(a: LayoutNode, p: Point, b: LayoutNode, q: Point): boolean {
  const [x, y] = apart(a, p, b, q);
  return x >= MIN_GAP - 1e-6 || y >= MIN_GAP - 1e-6;
}

/** Whether display i at `at` keeps R1's gap from every other display. */
function keepsR1At(nodes: LayoutNode[], positions: Point[], i: number, at: Point): boolean {
  return nodes.every((node, j) => j === i || keepsR1(nodes[i], at, node, positions[j]));
}

/** P1's measure: the distance between two displays' borders (0 where they overlap), the length of a straight line between them. */
function borderDistance(a: LayoutNode, p: Point, b: LayoutNode, q: Point): number {
  const [x, y] = apart(a, p, b, q);
  return Math.hypot(Math.max(x, 0), Math.max(y, 0));
}

/** Where display `b` goes, in the direction (ux, uy) from display `a` at `p`, for the two to be `distance` apart at their borders. */
function along(a: LayoutNode, p: Point, b: LayoutNode, ux: number, uy: number, distance: number): Point {
  let [near, far] = [0, distance + a.width + a.height + b.width + b.height];
  for (let k = 0; k < 40; k += 1) {
    const reach = (near + far) / 2;
    if (borderDistance(a, p, b, { x: p.x + ux * reach, y: p.y + uy * reach }) < distance) near = reach;
    else far = reach;
  }
  return { x: p.x + ux * far, y: p.y + uy * far };
}

/** The score (see above) of the links' P1 and P2 errors. */
function score(p1: number[], p2: number[]): number {
  if (p1.length === 0) return 0;
  const mean = p1.reduce((sum, e, k) => sum + e - p2[k], 0) / p1.length;
  return p1.reduce((sum, e, k) => sum + e * e + p2[k] * p2[k] + (e - p2[k] - mean) ** 2, 0);
}

/**
 * Step 1: a position for each display without one. Those linked to displays already placed come first (most such links
 * first), each at its target border distance from the first of them, at the angle round it that best meets its links'
 * targets while keeping R1 (further out if no angle keeps R1); a display linked to none that are placed goes to the right
 * of all those placed.
 */
function seed(nodes: LayoutNode[], links: Link[], given: (Point | undefined)[]): Point[] {
  const at = [...given];
  const placed = () => nodes.flatMap((_, i) => (at[i] ? [i] : []));
  for (;;) {
    const left = nodes.flatMap((_, i) => (at[i] ? [] : [i]));
    if (left.length === 0) break;
    const placedLinks = (i: number) => links.filter((l) => (l.a === i && at[l.b]) || (l.b === i && at[l.a]));
    const i = left.reduce((best, j) => (placedLinks(j).length > placedLinks(best).length ? j : best), left[0]);
    const own = placedLinks(i);
    const others = placed();
    const fits = (p: Point) => others.every((j) => keepsR1(nodes[i], p, nodes[j], at[j]!));
    if (own.length === 0) {
      const right = others.length ? Math.max(...others.map((j) => at[j]!.x + nodes[j].width / 2)) : -nodes[i].width / 2 - MIN_GAP;
      const y = others.length ? others.reduce((sum, j) => sum + at[j]!.y, 0) / others.length : 0;
      at[i] = { x: right + MIN_GAP + nodes[i].width / 2, y };
      continue;
    }
    const first = own[0];
    const hub = first.a === i ? first.b : first.a;
    let best: { p: Point; miss: number } | undefined;
    for (let distance = first.target; !best; distance = distance * 1.25 + MIN_GAP) {
      for (let k = 0; k < 24; k += 1) {
        const p = along(nodes[hub], at[hub]!, nodes[i], Math.cos((k * Math.PI) / 12), Math.sin((k * Math.PI) / 12), distance);
        if (!fits(p)) continue;
        const miss = own.reduce((sum, l) => {
          const j = l.a === i ? l.b : l.a;
          return sum + (borderDistance(nodes[i], p, nodes[j], at[j]!) - l.target) ** 2;
        }, 0);
        if (!best || miss < best.miss) best = { p, miss };
      }
    }
    at[i] = best.p;
  }
  return at as Point[];
}

/**
 * Moves displays closer than their gap (`gap(i, j)`) apart, each pair along the axis that needs the smaller move;
 * false if some are still too close.
 */
function enforceGaps(nodes: LayoutNode[], positions: Point[], gap: (i: number, j: number) => number): boolean {
  for (let round = 0; round < 100; round += 1) {
    let broken = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        // As `apart`, written out: this runs for every pair at every descent step.
        const x = Math.abs(positions[j].x - positions[i].x) - (nodes[i].width + nodes[j].width) / 2;
        const y = Math.abs(positions[j].y - positions[i].y) - (nodes[i].height + nodes[j].height) / 2;
        const g = gap(i, j);
        if (x >= g - 1e-6 || y >= g - 1e-6) continue;
        broken = true;
        const axis = g - x <= g - y ? 'x' : 'y';
        const half = ((axis === 'x' ? g - x : g - y) + 0.01) / 2;
        const side = positions[j][axis] > positions[i][axis] || (positions[j][axis] === positions[i][axis] && j > i) ? 1 : -1;
        positions[i][axis] -= side * half;
        positions[j][axis] += side * half;
      }
    }
    if (!broken) return true;
  }
  return false;
}

/** Moves displays closer than R1's gap between displays apart; false if some are still too close. */
const enforceR1 = (nodes: LayoutNode[], positions: Point[]) => enforceGaps(nodes, positions, () => MIN_GAP);

/**
 * The straight line between two displays' nearest points: across the middle of the span they share, where they face
 * each other along x or y, and otherwise between their nearest corners (as paths.ts draws a clear straight line).
 */
function straightLine(a: LayoutNode, p: Point, b: LayoutNode, q: Point): [Point, Point] {
  const [ax0, ax1, ay0, ay1] = [p.x - a.width / 2, p.x + a.width / 2, p.y - a.height / 2, p.y + a.height / 2];
  const [bx0, bx1, by0, by1] = [q.x - b.width / 2, q.x + b.width / 2, q.y - b.height / 2, q.y + b.height / 2];
  const [x0, x1, y0, y1] = [Math.max(ax0, bx0), Math.min(ax1, bx1), Math.max(ay0, by0), Math.min(ay1, by1)];
  const nearX = (from: number, lo: number, hi: number) => Math.min(Math.max(from, lo), hi);
  if (x0 <= x1) {
    const x = (x0 + x1) / 2;
    return q.y > p.y ? [{ x, y: ay1 }, { x, y: by0 }] : [{ x, y: ay0 }, { x, y: by1 }];
  }
  if (y0 <= y1) {
    const y = (y0 + y1) / 2;
    return q.x > p.x ? [{ x: ax1, y }, { x: bx0, y }] : [{ x: ax0, y }, { x: bx1, y }];
  }
  const from = { x: nearX(q.x, ax0, ax1), y: nearX(q.y, ay0, ay1) };
  return [from, { x: nearX(from.x, bx0, bx1), y: nearX(from.y, by0, by1) }];
}

/**
 * How near the segment from `s` to `t` comes to the display `node` at `c`, measured as the line router measures it
 * (paths.ts grows each display by LINE_GAP into a larger rectangle, square at the corners): the larger of the gaps along
 * x and along y, at the segment's nearest point. With the nearest point of the segment, and the display's point nearest
 * that.
 */
function segmentToDisplay(s: Point, t: Point, node: LayoutNode, c: Point): { onLine: Point; onDisplay: Point; distance: number } {
  const [x0, x1, y0, y1] = [c.x - node.width / 2, c.x + node.width / 2, c.y - node.height / 2, c.y + node.height / 2];
  const at = (k: number) => ({ x: s.x + (t.x - s.x) * k, y: s.y + (t.y - s.y) * k });
  const gap = (p: Point) => Math.max(x0 - p.x, p.x - x1, y0 - p.y, p.y - y1, 0);
  // The gap is convex along the segment, so its least is found by narrowing in on it.
  let [lo, hi] = [0, 1];
  for (let k = 0; k < 40; k += 1) {
    const [m1, m2] = [lo + (hi - lo) / 3, hi - (hi - lo) / 3];
    if (gap(at(m1)) <= gap(at(m2))) hi = m2;
    else lo = m1;
  }
  const onLine = at((lo + hi) / 2);
  return { onLine, onDisplay: { x: Math.min(Math.max(onLine.x, x0), x1), y: Math.min(Math.max(onLine.y, y0), y1) }, distance: gap(onLine) };
}

/**
 * R1 for lines, as far as descent can see them: moves each display that comes within LINE_GAP of another link's
 * straight line away from it (and the line's two displays the other way, half as far each), by part of the shortfall.
 * Repeated every step, this keeps lines' room as the layout settles, rather than leaving step 3 to make it.
 */
function keepLinesClear(nodes: LayoutNode[], links: Link[], positions: Point[]): void {
  for (const l of links) {
    const [s, t] = straightLine(nodes[l.a], positions[l.a], nodes[l.b], positions[l.b]);
    const [bx0, bx1, by0, by1] = [Math.min(s.x, t.x) - LINE_GAP, Math.max(s.x, t.x) + LINE_GAP, Math.min(s.y, t.y) - LINE_GAP, Math.max(s.y, t.y) + LINE_GAP];
    nodes.forEach((node, k) => {
      if (k === l.a || k === l.b) return;
      const c = positions[k];
      if (c.x + node.width / 2 < bx0 || c.x - node.width / 2 > bx1 || c.y + node.height / 2 < by0 || c.y - node.height / 2 > by1) return;
      const { onLine, onDisplay, distance } = segmentToDisplay(s, t, node, c);
      if (distance >= LINE_GAP) return;
      // Away from the line: from its nearest point towards the display's (or, where the line passes through the display,
      // across the line towards the display's centre).
      let [ux, uy] = distance > 1e-6 ? [onDisplay.x - onLine.x, onDisplay.y - onLine.y] : [-(t.y - s.y), t.x - s.x];
      if (distance <= 1e-6 && ux * (c.x - onLine.x) + uy * (c.y - onLine.y) < 0) [ux, uy] = [-ux, -uy];
      const size = Math.hypot(ux, uy) || 1;
      const push = (LINE_GAP - distance) * LINE_PUSH;
      positions[k].x += (ux / size) * push;
      positions[k].y += (uy / size) * push;
      for (const end of [l.a, l.b]) {
        positions[end].x -= (ux / size) * push * 0.5;
        positions[end].y -= (uy / size) * push * 0.5;
      }
    });
  }
}

/**
 * Step 2: descends the score with every line taken as straight, keeping R1 after every step. With straight lines both
 * errors are the border distance less the target, and P3's part is nothing, so the score's slope is that of
 * 2 × (border distance − target)² for each link.
 */
function descend(nodes: LayoutNode[], links: Link[], positions: Point[]): void {
  for (let step = 0; step < DESCENT_STEPS && links.length > 0; step += 1) {
    const slope = positions.map(() => ({ x: 0, y: 0 }));
    for (const l of links) {
      const [p, q] = [positions[l.a], positions[l.b]];
      const [x, y] = apart(nodes[l.a], p, nodes[l.b], q);
      const distance = Math.hypot(Math.max(x, 0), Math.max(y, 0));
      if (distance === 0) continue;
      // How the border distance changes as b moves (a's is the opposite), and how the score changes with it.
      const [dx, dy] = [q.x - p.x, q.y - p.y];
      const [ux, uy] = [(Math.sign(dx) * Math.max(x, 0)) / distance, (Math.sign(dy) * Math.max(y, 0)) / distance];
      const byDistance = 4 * (distance - l.target);
      slope[l.b].x += byDistance * ux;
      slope[l.b].y += byDistance * uy;
      slope[l.a].x -= byDistance * ux;
      slope[l.a].y -= byDistance * uy;
    }
    const most = FIRST_MOVE + (LAST_MOVE - FIRST_MOVE) * (step / (DESCENT_STEPS - 1));
    positions.forEach((p, i) => {
      const [mx, my] = [-slope[i].x * RATE, -slope[i].y * RATE];
      const size = Math.hypot(mx, my);
      const k = size > most ? most / size : 1;
      p.x += mx * k;
      p.y += my * k;
    });
    keepLinesClear(nodes, links, positions);
    enforceR1(nodes, positions);
  }
}

/** The routed paths of the links (by index) at `positions`. */
function route(nodes: LayoutNode[], links: Link[], positions: Point[], which: number[]): LinkPath[] {
  const rects = nodes.map((node, i) => ({ x: positions[i].x - node.width / 2, y: positions[i].y - node.height / 2, width: node.width, height: node.height }));
  const paths = routeLinks(rects, which.map((k) => ({ id: String(k), source: links[k].a, target: links[k].b })));
  return which.map((k) => paths.get(String(k))!);
}

/** A change refine can make: displays moved to new positions (one, as refine makes them now). */
type Change = { i: number; to: Point }[];

/**
 * Step 4: refines with the routed lines. It goes through the displays, those whose links miss their targets most first,
 * and for each tries:
 *
 * - moves by the current distance in eight directions, to where its links' targets put it, and halfway there;
 * - spots round each display it is linked to, at that link's target, in SPOTS directions.
 *
 * Of the changes that keep R1 between displays, it ranks those that lower the score with the moved displays' links
 * taken as straight, and routes the best few: the first that keeps R1 for lines and R2 and lowers the score is kept.
 * Moving a display can change any line that passed near it, so every line whose path came near where a display was, or
 * where it goes (within reach of its path; see touches), is routed again. The distance halves when no display moves;
 * once it is spent, it starts again from FIRST_TRY if anything moved meanwhile. Refining ends when a whole run of the
 * distance moves nothing, or when MAX_PATHS paths have been worked out.
 */
function refine(nodes: LayoutNode[], links: Link[], positions: Point[], paths: LinkPath[]): void {
  const p1 = links.map((l) => borderDistance(nodes[l.a], positions[l.a], nodes[l.b], positions[l.b]) - l.target);
  const p2 = paths.map((path, k) => path.length - links[k].target);
  let current = score(p1, p2);
  const own = nodes.map((_, i) => links.flatMap((l, k) => (l.a === i || l.b === i ? [k] : [])));
  let budget = MAX_PATHS;

  // The box a path's points lie in, for telling which paths a display may touch.
  const reach = (path: LinkPath) => {
    const xs = path.points.map((p) => p.x);
    const ys = path.points.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const reaches = paths.map(reach);
  // Whether display i at `p` comes within reach of line k's path: near enough that the line would have to go round it
  // there, or (where it is now) that the line may be going round it. Only those lines change when it moves.
  const touches = (k: number, i: number, p: Point) => {
    const r = reaches[k];
    const [w, h] = [nodes[i].width / 2 + LINE_GAP, nodes[i].height / 2 + LINE_GAP];
    if (r.x0 > p.x + w || r.x1 < p.x - w || r.y0 > p.y + h || r.y1 < p.y - h) return false;
    const points = paths[k].points;
    for (let s = 1; s < points.length; s += 1) if (segmentToDisplay(points[s - 1], points[s], nodes[i], p).distance < LINE_GAP + 1) return true;
    return false;
  };
  const after = (change: Change) => {
    const next = [...positions];
    for (const { i, to } of change) next[i] = to;
    return next;
  };
  // Whether every moved display keeps R1's gap from every other display.
  const keepsGaps = (change: Change, next: Point[]) => change.every(({ i }) => keepsR1At(nodes, next, i, next[i]));

  let improvedSinceStart = false;
  for (let distance = FIRST_TRY; distance >= LAST_TRY && budget > 0; ) {
    let moved = false;
    const miss = nodes.map((_, i) => own[i].reduce((sum, k) => sum + p1[k] ** 2 + p2[k] ** 2, 0));
    const order = nodes.map((_, i) => i).sort((i, j) => miss[j] - miss[i] || i - j);
    for (const i of order) {
      if (budget <= 0) break;
      const here = positions[i];
      const changes: Change[] = [];
      const targets = own[i].map((k) => {
        const l = links[k];
        const j = l.a === i ? l.b : l.a;
        const d = Math.hypot(here.x - positions[j].x, here.y - positions[j].y) || 1;
        return along(nodes[j], positions[j], nodes[i], (here.x - positions[j].x) / d, (here.y - positions[j].y) / d, l.target);
      });
      if (targets.length) {
        const goal = { x: targets.reduce((s, t) => s + t.x, 0) / targets.length, y: targets.reduce((s, t) => s + t.y, 0) / targets.length };
        changes.push([{ i, to: goal }], [{ i, to: { x: (here.x + goal.x) / 2, y: (here.y + goal.y) / 2 } }]);
      }
      for (let k = 0; k < 8; k += 1) changes.push([{ i, to: { x: here.x + distance * Math.cos((k * Math.PI) / 4), y: here.y + distance * Math.sin((k * Math.PI) / 4) } }]);
      for (const k of own[i]) {
        const l = links[k];
        const j = l.a === i ? l.b : l.a;
        for (let s = 0; s < SPOTS; s += 1) {
          const angle = (2 * Math.PI * s) / SPOTS;
          changes.push([{ i, to: along(nodes[j], positions[j], nodes[i], Math.cos(angle), Math.sin(angle), l.target) }]);
        }
      }

      const ranked = changes
        .filter((change) => change.some(({ i: m, to }) => Math.hypot(to.x - positions[m].x, to.y - positions[m].y) >= 0.5))
        .flatMap((change) => {
          const next = after(change);
          if (!keepsGaps(change, next)) return [];
          const [e1, e2] = [[...p1], [...p2]];
          for (const { i: m } of change) {
            for (const k of own[m]) {
              const l = links[k];
              e1[k] = borderDistance(nodes[l.a], next[l.a], nodes[l.b], next[l.b]) - l.target;
              e2[k] = e1[k];
            }
          }
          const estimate = score(e1, e2);
          return estimate < current - 1e-6 ? [{ change, next, estimate }] : [];
        })
        .sort((m, n) => m.estimate - n.estimate)
        .slice(0, ROUTED_MOVES);

      for (const { change, next } of ranked) {
        const which = links.flatMap((_, k) => (change.some(({ i: m, to }) => own[m].includes(k) || touches(k, m, positions[m]) || touches(k, m, to)) ? [k] : []));
        budget -= which.length;
        const routed = route(nodes, links, next, which);
        if (routed.some((path) => !path.clear)) continue;
        const [e1, e2] = [[...p1], [...p2]];
        which.forEach((k, n) => {
          const l = links[k];
          e1[k] = borderDistance(nodes[l.a], next[l.a], nodes[l.b], next[l.b]) - l.target;
          e2[k] = routed[n].length - l.target;
        });
        const total = score(e1, e2);
        if (total >= current - 1e-6) continue;
        for (const { i: m, to } of change) positions[m] = to;
        which.forEach((k, n) => {
          paths[k] = routed[n];
          reaches[k] = reach(routed[n]);
        });
        p1.splice(0, p1.length, ...e1);
        p2.splice(0, p2.length, ...e2);
        current = total;
        moved = true;
        break;
      }
    }
    if (moved) improvedSinceStart = true;
    if (!moved) distance /= 2;
    // Spent: if anything moved since the distance last started, start it again, as the moves may have opened up others.
    if (distance < LAST_TRY && improvedSinceStart) [distance, improvedSinceStart] = [FIRST_TRY, false];
  }
}

/** Runs the layout for the network, starting from `previous` positions where it has them. */
export function runLayout(nodes: LayoutNode[], links: LayoutLink[], previous: Map<string, Point>): Layout {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const own: Link[] = links.flatMap((link) => {
    const [a, b] = [index.get(link.source), index.get(link.target)];
    return a === undefined || b === undefined || a === b ? [] : [{ a, b, target: target(link.weight) }];
  });
  const positions = seed(nodes, own, nodes.map((node) => previous.get(node.id))).map((p) => ({ ...p }));
  enforceR1(nodes, positions);
  descend(nodes, own, positions);
  const r1 = enforceR1(nodes, positions);
  // 3. Make room for shut-in lines: the displays near each one's two ends (within the larger of the two's sizes) are
  // moved apart to ROOM_FOR_LINES, which always leaves room for lines between them; a few rounds of that, then, if any
  // line is still shut in, spreading (which widens every gap, so it soon leaves room for every line).
  const all = own.map((_, k) => k);
  let paths = route(nodes, own, positions, all);
  const roomy = nodes.map(() => false);
  for (let round = 0; round < ROOM_ROUNDS && paths.some((path) => !path.clear); round += 1) {
    own.forEach(({ a, b }, k) => {
      if (paths[k].clear) return;
      const reach = Math.max(nodes[a].width, nodes[a].height, nodes[b].width, nodes[b].height);
      const [x0, x1] = [Math.min(positions[a].x, positions[b].x) - 2 * reach, Math.max(positions[a].x, positions[b].x) + 2 * reach];
      const [y0, y1] = [Math.min(positions[a].y, positions[b].y) - 2 * reach, Math.max(positions[a].y, positions[b].y) + 2 * reach];
      positions.forEach((p, i) => {
        if (p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1) roomy[i] = true;
      });
    });
    enforceGaps(nodes, positions, (i, j) => (roomy[i] && roomy[j] ? ROOM_FOR_LINES : MIN_GAP));
    paths = route(nodes, own, positions, all);
  }
  for (let k = 0; k < 100 && paths.some((path) => !path.clear); k += 1) {
    const xs = positions.map((p) => p.x);
    const ys = positions.map((p) => p.y);
    const [mx, my] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    for (const p of positions) [p.x, p.y] = [mx + (p.x - mx) * SPREAD, my + (p.y - my) * SPREAD];
    paths = route(nodes, own, positions, all);
  }
  const lines = paths.every((path) => path.clear);
  if (r1 && lines) refine(nodes, own, positions, paths);
  return { positions: new Map(nodes.map((node, i) => [node.id, positions[i]])), satisfied: r1 && lines };
}
