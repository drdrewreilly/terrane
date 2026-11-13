# Network canvas layout: rules, principles and guidelines

Extracted from the code as it stands on branch `fruchterman-reingold` (2026-11-12). Listed by priority: a higher item is
never given up to meet a lower one.

## Elements responsible

| Element | Role |
| --- | --- |
| `src/renderer/layout.ts` | Positions the node displays (centres at zoom 1): seeding, descent, making room for lines, refinement. |
| `src/renderer/paths.ts` | Routes each link's line between the displays; defines the gap constants. |
| `src/renderer/view.ts` | Shows the laid-out network at a zoom: scales distances, shrinks displays where needed, re-routes lines, sets the zoom-out limit. |
| `src/renderer/Canvas.tsx` | Measures displays, runs/reuses the layout, centres, pans and zooms the network, draws lines and displays. |
| `src/renderer/LinkDisplay.tsx` | Draws a link's line (width, no arrowheads). |
| `src/renderer/handlers/default.tsx`, `image.tsx` | Fix each display's size, the input the layout works with. |
| `src/main/workspace.ts` (`SavedLayout`) | Saves the layout in `workspace.json` so it can be reused. |

## Priority 1 — Hard rules (always met)

1. **R1 between displays.** Every two displays are at least `MIN_GAP` (16 px) apart, measured along x *or* along y
   (being 16 px apart on either axis is enough). (`paths.ts`, `layout.ts`)
2. **R1 for lines.** Every part of a link's line (2 px wide) is at least `MIN_GAP` from every display except its own two,
   so the line's centre keeps `LINE_GAP` (17 px) from them. Distance is measured against each display grown by
   `LINE_GAP` into a larger, square-cornered rectangle. (`paths.ts`)
3. **R2. No line crosses a display.** A line runs from the edge of one of its displays to the edge of the other, never
   enters either, and (by R1) keeps clear of every other display. (`paths.ts`)
4. **Rules hold at every zoom.** When the view is zoomed out, R1 and R2 are re-established for that zoom (displays shrink,
   lines are re-routed) rather than relaxed. (`view.ts`)
5. **Spreading always restores the rules.** Displays at least `ROOM_FOR_LINES` (2 × `LINE_GAP` + 1 = 35 px) apart always
   leave room for a line between them, so moving displays apart — or spreading the whole network about its middle —
   is the guaranteed remedy when a line is shut in. (`paths.ts`, `layout.ts`, `view.ts`)
6. **Failure is flagged, not hidden.** If a line cannot be routed under R1/R2, it is marked not `clear` and drawn straight
   between the displays' centres; the layout reports `satisfied: false`, which is saved with it. Refinement is skipped
   unless both rules hold. (`paths.ts`, `layout.ts`)

## Priority 2 — Line routing (within the rules)

7. **Shortest line.** Each line is the shortest path from one display's edge to the other's that keeps R1 and R2.
8. **Straight segments only.** A single straight segment where one is clear; otherwise a polyline that bends only at the
   (grown) corners of displays in its way (visibility graph + Dijkstra).
9. **Facing displays join across their shared span.** Where two displays overlap along x or y, the line crosses the gap
   perpendicular to it, at the clear position nearest the middle of the shared span.
10. **Non-facing displays join corner to corner.** Otherwise the straight line joins their nearest corners.
11. **Bent lines leave and arrive at nearest points.** A bent line leaves a display at its point nearest the first bend and
    reaches the other at its point nearest the last.
12. **Search near first.** Routing tries only the displays near the two ends (64 px, then 256 px beyond their box) before
    all of them; a path found that way is kept only if it is clear of every display.

## Priority 3 — Layout preferences (met as far as the rules allow)

For each link of weight *w* (1–10), `target(w) = 40 + 30 × (10 − w)` px: a stronger link is shorter (w 10 → 40 px,
w 1 → 310 px).

13. **P1. Border distance on target.** The shortest distance between the two displays' edges equals `target(w)`.
14. **P2. Line length on target.** The routed line is `target(w)` long.
15. **P3. Detours alike.** The variance across links of (P1 error − P2 error) is as small as possible: every line's detour
    beyond the straight way is kept similar, which counts against lines that wind round other displays.
16. **One score.** The preferences are weighed together as Σ(P1 error² + P2 error²) + Σ((P1 error − P2 error) − mean)²,
    made as low as the rules allow. A straight line makes P1 and P2 agree, so straight lines are favoured.

## Priority 4 — Layout procedure (how a run meets the above)

17. **Start from scratch when the network's shape changes.** After a node or link is added or deleted (or on the
    toolbar's "Lay out the network from scratch"), a run starts with no positions and every display is seeded. After
    any other change (a weight, a display's size), and on opening, it starts from the previous run's positions, or the
    workspace's saved ones, and only displays without a position are seeded.
18. **Seeding order and placement.** Unplaced displays with the most links to placed ones go first, each at its first
    link's target distance from that display, at whichever of 24 angles best meets its links' targets while keeping R1
    (moving further out, ×1.25 + 16 px, if no angle fits). A display linked to nothing placed goes 16 px to the right of
    everything placed, at their mean height.
19. **Descent with straight lines.** 400 steps down the score's slope, treating every line as straight; the most a
    display moves per step shrinks from 50 px to 1 px.
20. **Keep lines' room during descent.** After every step, a display within `LINE_GAP` of another link's straight line is
    pushed away from it (the line's two displays move half as far the other way), then R1 between displays is enforced.
21. **Enforce R1 by the smaller move.** Two displays too close are moved apart, equally, along whichever axis needs the
    smaller move.
22. **Make room for shut-in lines.** Route all lines; for each one not clear, displays near its ends are moved apart to
    `ROOM_FOR_LINES` (up to 4 rounds); if any line is still shut in, spread the whole network about its middle by ×1.1
    until every line routes.
23. **Refine with routed lines.** Move one display at a time — worst-missing displays first — trying eight directions at a
    halving step (64 → 2 px), the average of its links' target spots and halfway there, and 24 spots round each linked
    display at that link's target. Rank candidates by estimated score (lines taken as straight), route the best 3, and
    keep the first that keeps R1 and R2 and lowers the true score. Re-route every line the move could affect. Stop when
    a full pass moves nothing or 20 000 paths have been worked out.

## Priority 5 — View, zoom and canvas

24. **Zoom scales distances, not displays.** Zooming changes the distances between centres (about the middle of the box
    round them); displays stay full size unless R1/R2 would break, and then shrink about their centre only as far as
    needed — each too-close pair by the same factor, then each grown back as far as room allows.
25. **Shut-in lines when zoomed out.** Displays near a shut-in line's ends shrink further to keep `ROOM_FOR_LINES`; after 4
    rounds, every display keeps that room.
26. **Lines keep their width** (2 px; 12 px invisible hit area) at every zoom; only their length changes. No arrowheads.
27. **Zoom limits.** Zoom 1 is as far in as it goes. As far out is the first zoom at which the whole network, lines
    included, fits the canvas with a 16 px margin — but never so far that two displays would need to shrink below
    `MIN_SCALE` (0.1) to keep `ROOM_FOR_LINES`.
28. **Centre the network.** The box round displays *and* lines is centred on the canvas; it is centred again each time
    the layout settles, at a zoom no further out than fits. A workspace opens zoomed right out; until the wheel is
    turned, each layout is shown zoomed right out.
29. **Zoom about the pointer; keep the network in reach.** The point under the pointer stays put. Zooming out keeps the
    network wholly inside the canvas along an axis where it is smaller, and covering it where it is larger.
30. **The canvas never scrolls**; dragging the background pans.

## Priority 6 — Inputs, persistence and responsiveness

31. **Layout works with measured display sizes.** Displays are laid out and measured at full size; the default display is
    the smallest golden-mean rectangle (≥ 162 × 100) that holds its content, its height then trimmed to the content. A
    display that resizes (e.g. once fonts load) triggers a new layout.
32. **Re-run on change.** The layout runs whenever nodes, links (including weight), display sizes, or the from-scratch
    request change (from scratch or not, as in 17), and every run is saved to `workspace.json`.
33. **Reuse a matching saved layout.** On opening, a saved layout is used as is (no run) if its key — a hash of the
    algorithm id (`LAYOUT_ALGORITHM`) plus the nodes, their display sizes and the links — matches and it positions every
    node. Changing the algorithm id invalidates older saved layouts.
34. **Ignore degenerate links.** Self-links and links to unknown nodes are not laid out or routed.
35. **Show progress.** While a layout is pending, a spinner shows centred over the canvas; the run waits until it has
    been painted.

## Notes on the code

- P3 has no effect during descent (with straight lines both errors are equal); it only acts in refinement.
- The comment in `Canvas.tsx` that "a curve can bow out beyond the displays" is out of date: lines are straight segments,
  though a bent line can still reach beyond the displays' box.
