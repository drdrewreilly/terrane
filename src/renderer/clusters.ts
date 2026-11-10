/**
 * Clusters for the layout: groups of nodes more closely tied to each other than to the rest of the network.
 *
 * How closely two linked nodes are tied combines (a) how many nodes they are both linked to (each such node closes a
 * triangle, as when A is linked to B, B to C and C to A) and (b) the weight of the links between them: the tie is the
 * weight times one more than the number of shared neighbours. The clusters are those that best separate strong ties
 * from weak ones (the communities of greatest modularity, found with the Louvain method).
 */

export interface ClusterLink {
  a: number;
  b: number;
  weight: number;
}

export interface Clusters {
  /** The cluster of each node (numbered from 0, largest cluster first). */
  of: number[];
  /** The nodes in each cluster. */
  members: number[][];
  /**
   * How central each node is in its cluster: its number of links to other nodes in the cluster over the most any node in
   * that cluster has (1 for the most linked; 0 for a node alone in its cluster or with no links within it).
   */
  centrality: number[];
  /** The connected part of the network each node is in (numbered from 0). */
  component: number[];
}

type Graph = Map<number, number>[];

/** How closely each pair of linked nodes is tied, as a symmetric weighted graph. */
function ties(n: number, links: ClusterLink[]): Graph {
  const neighbours = Array.from({ length: n }, () => new Set<number>());
  for (const { a, b } of links) {
    neighbours[a].add(b);
    neighbours[b].add(a);
  }
  const graph: Graph = Array.from({ length: n }, () => new Map());
  for (const { a, b, weight } of links) {
    let shared = 0;
    for (const c of neighbours[a]) if (c !== b && neighbours[b].has(c)) shared += 1;
    const tie = Math.max(weight, 0.1) * (1 + shared);
    graph[a].set(b, (graph[a].get(b) ?? 0) + tie);
    graph[b].set(a, (graph[b].get(a) ?? 0) + tie);
  }
  return graph;
}

/**
 * One level of the Louvain method: moves each node to the neighbouring community that most increases modularity until
 * no move does. Returns the community of each node, numbered from 0.
 */
function localMoves(graph: Graph): { community: number[]; moved: boolean } {
  const n = graph.length;
  const degree = graph.map((row) => [...row.values()].reduce((sum, w) => sum + w, 0));
  const total = degree.reduce((sum, d) => sum + d, 0);
  const community = Array.from({ length: n }, (_, i) => i);
  const communityDegree = [...degree];
  let moved = false;
  if (total === 0) return { community, moved };

  for (let pass = 0, changed = true; changed && pass < 100; pass += 1) {
    changed = false;
    for (let i = 0; i < n; i += 1) {
      const own = community[i];
      // The weight of i's ties into each neighbouring community (its tie to itself, in an aggregated graph, aside).
      const into = new Map<number, number>();
      for (const [j, w] of graph[i]) if (j !== i) into.set(community[j], (into.get(community[j]) ?? 0) + w);
      communityDegree[own] -= degree[i];
      const gain = (c: number) => (into.get(c) ?? 0) - (communityDegree[c] * degree[i]) / total;
      let best = own;
      let bestGain = gain(own);
      for (const c of into.keys()) {
        const g = gain(c);
        if (g > bestGain + 1e-12) [best, bestGain] = [c, g];
      }
      communityDegree[best] += degree[i];
      if (best !== own) {
        community[i] = best;
        changed = moved = true;
      }
    }
  }
  const renumber = new Map<number, number>();
  return { community: community.map((c) => renumber.get(c) ?? (renumber.set(c, renumber.size), renumber.size - 1)), moved };
}

/** The clusters of a network of `n` nodes. */
export function findClusters(n: number, links: ClusterLink[]): Clusters {
  // The Louvain method: local moves, then each community becomes one node of a smaller graph, until nothing moves.
  let graph = ties(n, links);
  let of = Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < 20; level += 1) {
    const { community, moved } = localMoves(graph);
    if (!moved) break;
    of = of.map((c) => community[c]);
    const size = Math.max(...community) + 1;
    const next: Graph = Array.from({ length: size }, () => new Map());
    graph.forEach((row, i) => {
      for (const [j, w] of row) next[community[i]].set(community[j], (next[community[i]].get(community[j]) ?? 0) + w);
    });
    graph = next;
  }

  // Number the clusters largest first (ties by their first node, so the numbering is stable).
  const groups = new Map<number, number[]>();
  of.forEach((c, i) => groups.set(c, [...(groups.get(c) ?? []), i]));
  const members = [...groups.values()].sort((p, q) => q.length - p.length || p[0] - q[0]);
  members.forEach((group, c) => group.forEach((i) => (of[i] = c)));

  // Centrality: links to other nodes in the cluster, over the most in that cluster.
  const within = Array.from({ length: n }, () => new Set<number>());
  for (const { a, b } of links) {
    if (of[a] !== of[b]) continue;
    within[a].add(b);
    within[b].add(a);
  }
  const centrality = new Array<number>(n).fill(0);
  for (const group of members) {
    const most = Math.max(...group.map((i) => within[i].size));
    if (most > 0) for (const i of group) centrality[i] = within[i].size / most;
  }

  // Connected parts.
  const component = new Array<number>(n).fill(-1);
  const neighbours = Array.from({ length: n }, () => [] as number[]);
  for (const { a, b } of links) {
    neighbours[a].push(b);
    neighbours[b].push(a);
  }
  let parts = 0;
  for (let start = 0; start < n; start += 1) {
    if (component[start] >= 0) continue;
    const stack = [start];
    component[start] = parts;
    while (stack.length) {
      for (const j of neighbours[stack.pop()!]) {
        if (component[j] < 0) {
          component[j] = parts;
          stack.push(j);
        }
      }
    }
    parts += 1;
  }

  return { of, members, centrality, component };
}
