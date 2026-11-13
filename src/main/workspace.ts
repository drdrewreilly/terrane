import { acquireLock, FORMAT_VERSION, type WorkspaceLock } from './lock';
import { randomUUID } from 'node:crypto';
import { access, constants, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { DEFAULT_TYPE_ID, loadedNodeTypes, nodeTypeFrom, propertyValues, type NodeType, type NodeTypeInput, type PropertyValue } from './nodeTypes';

/** The text fields of a node, in the order they are shown. */
export const DISPLAY_FIELDS = ['title', 'description', 'body'] as const;
export type DisplayField = (typeof DISPLAY_FIELDS)[number];

/** An entry of the `nodes` array in `workspace.json`. Every node is one of these; a node with a file is a `FileNode`. */
export interface TerraneNode {
  id: string;
  addedAt: string;
  /** Required, and unique among the workspace's nodes: a node can be identified by its title. */
  title: string;
  description: string | null;
  body: string | null;
  /** The fields shown in the node's display (at least one, each with text), in the order title, description, body. */
  display: DisplayField[];
  /** The `id` of the node's type (see main/nodeTypes.ts); a node written before there were types is of the default type. */
  type: string;
  /** The node's value for each of its type's properties, by property id. */
  properties: Record<string, PropertyValue>;
}

/** A node with a file. */
export interface FileNode extends TerraneNode {
  /** The file's name. */
  filename: string;
  /** Where the file is: relative to the workspace folder if it was copied into the workspace, otherwise the absolute path of the original. */
  path: string;
}

/** Either kind of entry in `nodes`. */
export type NodeRecord = TerraneNode | FileNode;

export function isFileNode(node: NodeRecord): node is FileNode {
  return 'path' in node;
}

/** What the node dialog sends to create or save a node. Empty strings are stored as `null`. */
export interface NodeInput {
  title: string;
  description: string;
  body: string;
  display: DisplayField[];
  /** The `id` of the node's type. */
  type: string;
  /** Values for the type's properties, by property id; one missing (or of the wrong kind) takes the property's default value. */
  properties: Record<string, PropertyValue>;
  /** The node's file, if it has one. `source` is a newly chosen file (absent: the node keeps its current one); `copy` is whether the file is (to be) copied into the workspace. */
  file?: { source?: string; copy: boolean };
  /** When saving replaces a file that was copied into the workspace: whether that copy is kept in the workspace folder. */
  keepOldCopy?: boolean;
}

/** `value` as a `NodeInput`, or an error if it is not one. */
export function parseNodeInput(value: unknown): NodeInput {
  const input = value as Partial<NodeInput> | null;
  const valid =
    typeof input === 'object' &&
    input !== null &&
    typeof input.title === 'string' &&
    typeof input.description === 'string' &&
    typeof input.body === 'string' &&
    Array.isArray(input.display) &&
    input.display.every((field) => DISPLAY_FIELDS.includes(field)) &&
    (input.file === undefined || (typeof input.file === 'object' && input.file !== null && typeof input.file.copy === 'boolean' && (input.file.source === undefined || typeof input.file.source === 'string'))) &&
    typeof input.type === 'string' &&
    typeof input.properties === 'object' &&
    input.properties !== null &&
    !Array.isArray(input.properties) &&
    Object.values(input.properties).every((property) => typeof property === 'string' || typeof property === 'boolean') &&
    (input.keepOldCopy === undefined || typeof input.keepOldCopy === 'boolean');
  if (!valid) throw new Error('Invalid node');
  return { title: input.title!, description: input.description!, body: input.body!, display: input.display!, type: input.type!, properties: { ...input.properties! }, file: input.file && { source: input.file.source, copy: input.file.copy }, keepOldCopy: input.keepOldCopy };
}

/** An entry of the `links` array in `workspace.json`: a connection from a source node to a target node. */
export interface WorkspaceLink {
  id: string;
  /** The `id` of the source node. */
  source: string;
  /** The `id` of the target node. */
  target: string;
  /** 1 to 10. */
  weight: number;
  /** Text about the link; `null` if it has none. */
  description: string | null;
}

/** What the link dialog sends to save a link. An empty description is stored as `null`. */
export interface LinkInput {
  weight: number;
  description: string;
}

/** `value` as a `LinkInput`, or an error if it is not one. */
export function parseLinkInput(value: unknown): LinkInput {
  const input = value as Partial<LinkInput> | null;
  if (typeof input !== 'object' || input === null || typeof input.weight !== 'number' || typeof input.description !== 'string') throw new Error('Invalid link');
  return { weight: input.weight, description: input.description };
}

/** The top-level keys of a JSON file to import: of the array of nodes, and of the array of links. */
export interface ImportKeys {
  nodesKey: string;
  linksKey: string;
}

/** `value` as `ImportKeys`, or an error if it is not one. */
export function parseImportKeys(value: unknown): ImportKeys {
  const keys = value as Partial<ImportKeys> | null;
  if (typeof keys !== 'object' || keys === null || typeof keys.nodesKey !== 'string' || typeof keys.linksKey !== 'string' || keys.nodesKey === '' || keys.linksKey === '') throw new Error('Invalid import keys');
  return { nodesKey: keys.nodesKey, linksKey: keys.linksKey };
}

/**
 * The layout last worked out for the network (see renderer/layout.ts), kept in `workspace.json` so that it need not be
 * worked out again when the workspace is opened. `network` identifies the network it was worked out for (its nodes'
 * display sizes and its links); the renderer uses it as it is only while that still matches.
 */
export interface SavedLayout {
  network: string;
  /** The centre of each node's display, by node id, in pixels at zoom 1. */
  positions: Record<string, { x: number; y: number }>;
  /** Whether the layout met its rules. */
  satisfied: boolean;
}

/** `value` as a saved layout, its positions cut down to the nodes in `nodeIds`; refused if it is not one. */
export function parseSavedLayout(value: unknown, nodeIds: Set<string>): SavedLayout {
  const layout = value as Partial<SavedLayout> | null;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (typeof layout !== 'object' || layout === null || typeof layout.network !== 'string' || typeof layout.satisfied !== 'boolean') throw new Error('Invalid layout');
  if (typeof layout.positions !== 'object' || layout.positions === null || Array.isArray(layout.positions)) throw new Error('Invalid layout');
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, at] of Object.entries(layout.positions)) {
    if (!finite(at?.x) || !finite(at?.y)) throw new Error('Invalid layout');
    if (nodeIds.has(id)) positions[id] = { x: at.x, y: at.y };
  }
  return { network: layout.network, positions, satisfied: layout.satisfied };
}

export interface WorkspaceState {
  open: boolean;
  /** The folder's name; the renderer never sees the path. */
  name?: string;
  nodes: NodeRecord[];
  links: WorkspaceLink[];
  /** The workspace's node types, the default type first. */
  nodeTypes: NodeType[];
  /** The layout saved in `workspace.json`, if any. */
  layout?: SavedLayout;
}

export interface OpenResult {
  status: 'opened' | 'cancelled' | 'failed';
  message?: string;
  workspace: WorkspaceState;
}

export interface WorkspaceOptions {
  appId: string;
  createdBy: string;
  onOpened?: (root: string) => void | Promise<void>;
  onClosed?: () => void | Promise<void>;
  onHookError?: (error: unknown) => void;
}

const WORKSPACE_FILE = 'workspace.json';
/** The weight of a new link. */
const NEW_LINK_WEIGHT = 5;

/** How many characters of a node's text make the title of a node that has none. */
const TITLE_LENGTH = 25;
/** The title of a node that has no title and no text to make one from. */
const DEFAULT_TITLE = 'Node';

/** A title made from the first of `texts` with text: its first 25 characters, runs of whitespace as single spaces; "Node" if none has text. */
export function titleFrom(texts: (string | null | undefined)[]): string {
  for (const text of texts) {
    const line = text?.replace(/\s+/g, ' ').trim();
    if (line) return Array.from(line).slice(0, TITLE_LENGTH).join('').trim();
  }
  return DEFAULT_TITLE;
}

/** `title` if `taken` does not hold it, else `title` with the first free integer from 2 added to its end ("Node2", "Node3", …). */
export function uniqueTitle(title: string, taken: Set<string>): string {
  if (!taken.has(title)) return title;
  let n = 2;
  while (taken.has(`${title}${n}`)) n += 1;
  return `${title}${n}`;
}

/**
 * Unique titles for a list of nodes, none of them in `taken` (which is extended with them). Each node has the title it was
 * `given` (trimmed; empty for none) or else its `fallback`. Given titles are kept first, in order; a title given again,
 * and every fallback, has an integer added to its end if it is taken (see `uniqueTitle`).
 */
function uniqueTitles(wanted: { given: string; fallback: () => string }[], taken: Set<string>): string[] {
  const kept = wanted.map(({ given }) => {
    if (given === '' || taken.has(given)) return undefined;
    taken.add(given);
    return given;
  });
  return kept.map((title, index) => {
    if (title !== undefined) return title;
    const { given, fallback } = wanted[index];
    const unique = uniqueTitle(given || fallback(), taken);
    taken.add(unique);
    return unique;
  });
}

/** A node's own title, trimmed; empty if it has none (as a node written before titles were required may not). */
const ownTitle = (node: { title?: unknown }) => (typeof node.title === 'string' ? node.title.trim() : '');

/** `nodes`, each with a unique title: one it lacks is made from its description, body or filename (see `titleFrom`). */
function titledNodes(nodes: NodeRecord[]): NodeRecord[] {
  const titles = uniqueTitles(
    nodes.map((node) => ({ given: ownTitle(node), fallback: () => titleFrom([node.description, node.body, isFileNode(node) ? node.filename : null]) })),
    new Set(),
  );
  return nodes.map((node, index) => (node.title === titles[index] ? node : { ...node, title: titles[index] }));
}

/**
 * `nodes`, each of one of `types` (a node of none, as one written before there were types, is of the default type) and
 * with a value for each of its type's properties (see `propertyValues`). A node that already is so is kept as it is.
 */
function typedNodes(nodes: NodeRecord[], types: NodeType[]): NodeRecord[] {
  return nodes.map((node) => {
    const type = types.find((candidate) => candidate.id === node.type) ?? types.find((candidate) => candidate.id === DEFAULT_TYPE_ID)!;
    const properties = propertyValues(type, node.properties);
    if (node.type === type.id && JSON.stringify(node.properties) === JSON.stringify(properties)) return node;
    return { ...node, type: type.id, properties };
  });
}

/** The text fields of `input` (the title trimmed; empty strings as `null`) and the fields it shows: those ticked that have text, in display order. Refused without a title, or if none is shown. */
function textFields(input: NodeInput): Pick<TerraneNode, 'title' | 'description' | 'body' | 'display'> {
  const title = input.title.trim();
  if (title === '') throw new Error('A node must have a title');
  const fields = { title, description: input.description || null, body: input.body || null };
  const display = DISPLAY_FIELDS.filter((field) => input.display.includes(field) && fields[field] !== null);
  if (display.length === 0) throw new Error('A node must show at least one field with text');
  return { ...fields, display };
}

/** The `filename` and `path` of a file left where it is (not copied into the workspace); it must exist and have an absolute path. */
async function outsideFile(source: string): Promise<Pick<FileNode, 'filename' | 'path'>> {
  if (!isAbsolute(source)) throw new Error(`Not an absolute path: ${source}`);
  await access(source);
  return { filename: basename(source), path: source };
}

/** An imported field's value as node text: a string (empty as `null`), a number or a boolean as text; anything else is no text. */
function importedText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** An imported node's `id`, or a link's `source` or `target`, as a key: a string or a number (as text); anything else is none. */
function importedKey(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The workspace: the folder that the framework's workspace manager has created or opened (see `main/index.ts`). It holds a
 * `workspace.json` (written if the folder has none) and a `.lock` while open, so that two instances of the app cannot open
 * it at once.
 */
export class Workspace {
  private root: string | undefined;
  private nodes: NodeRecord[] = [];
  private links: WorkspaceLink[] = [];
  private layout: SavedLayout | undefined;
  private nodeTypes: NodeType[] = [];
  private lock: WorkspaceLock | undefined;

  constructor(private readonly options: WorkspaceOptions) {}

  state(): WorkspaceState {
    if (!this.root) return { open: false, nodes: [], links: [], nodeTypes: [] };
    return { open: true, name: basename(this.root), nodes: this.nodes, links: this.links, nodeTypes: this.nodeTypes, ...(this.layout ? { layout: this.layout } : {}) };
  }

  /** The type and property values of a node made from `input`: its type must be one of the workspace's (see `propertyValues` for the values). */
  private typeFields(input: NodeInput): Pick<TerraneNode, 'type' | 'properties'> {
    const type = this.nodeTypes.find((candidate) => candidate.id === input.type);
    if (!type) throw new Error('No such node type in the workspace');
    return { type: type.id, properties: propertyValues(type, input.properties) };
  }

  /** A node type's name must be one no other type has. */
  private checkTypeName(name: string, id?: string): void {
    if (this.nodeTypes.some((type) => type.name === name && type.id !== id)) throw new Error(`Another node type is called ${name}`);
  }

  /** Records a node type made from `input` in the `nodeTypes` of `workspace.json`; refused if another type has its name. */
  async createNodeType(input: NodeTypeInput): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      this.checkTypeName(input.name);
      const nodeTypes = [...this.nodeTypes, nodeTypeFrom(randomUUID(), input)];
      await this.writeEntries(root, { nodeTypes });
      this.nodeTypes = nodeTypes;
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /**
   * Replaces the node type `id` with one made from `input` (refused if another type has its name). Its nodes keep their
   * values for the properties it still has (of the same kind); a property that is new, or whose kind changed, takes its
   * default value, and values for properties it no longer has are dropped.
   */
  async updateNodeType(id: string, input: NodeTypeInput): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      const current = this.nodeTypes.find((type) => type.id === id);
      if (!current) throw new Error('No such node type in the workspace');
      this.checkTypeName(input.name, id);
      const type = nodeTypeFrom(id, input, current);
      const nodeTypes = this.nodeTypes.map((candidate) => (candidate.id === id ? type : candidate));
      const nodes = typedNodes(this.nodes, nodeTypes);
      await this.writeEntries(root, { nodeTypes, nodes });
      [this.nodeTypes, this.nodes] = [nodeTypes, nodes];
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /** Deletes the node type `id` (the default type cannot be deleted); its nodes become nodes of the default type. */
  async deleteNodeType(id: string): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      if (id === DEFAULT_TYPE_ID) throw new Error('The default node type cannot be deleted');
      if (!this.nodeTypes.some((type) => type.id === id)) throw new Error('No such node type in the workspace');
      const nodeTypes = this.nodeTypes.filter((type) => type.id !== id);
      const nodes = typedNodes(this.nodes, nodeTypes);
      await this.writeEntries(root, { nodeTypes, nodes });
      [this.nodeTypes, this.nodes] = [nodeTypes, nodes];
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /** The open workspace's folder. */
  get path(): string | undefined {
    return this.root;
  }

  /**
   * Records a node made from `input` in the `nodes` of `workspace.json`, copying its file into the workspace folder if
   * `input.file.copy` is set. A title another node has is given an integer at its end (see `uniqueTitle`).
   */
  async createNode(input: NodeInput): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      const texts = textFields(input);
      texts.title = uniqueTitle(texts.title, new Set(this.nodes.map((other) => other.title)));
      let node: NodeRecord = { id: randomUUID(), addedAt: new Date().toISOString(), ...texts, ...this.typeFields(input) };
      let copied: string | undefined;
      if (input.file) {
        const { source, copy } = input.file;
        if (!source) throw new Error('No file was chosen');
        if (copy) {
          copied = await this.copyIn(root, source);
          node = { ...node, filename: copied, path: copied };
        } else {
          node = { ...node, ...(await outsideFile(source)) };
        }
      }
      await this.saveNodes(root, [...this.nodes, node], copied);
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /**
   * Imports the JSON file `file` (an object): a node for each object in the array under its top-level key `nodesKey`,
   * and a link for each object in the array under `linksKey`. A key the file does not have, or that does not hold an
   * array, is skipped. Nodes and links are written to `workspace.json` together.
   *
   * A node takes its `title`, `description` and `body`, and shows the first of them with text (its title if it has none);
   * it is of the default type.
   * A node without a title is given one made from the first 25 characters of its `description`, `body`, `filename`,
   * `path` (its last part), `name` or `label`, whichever is first to have text, or else "Node"; a title already taken (by a
   * node in the workspace or one imported before it) is given an integer at its end ("Node2", "Node3", …).
   *
   * A link joins its `source` and `target`, each identifying a node by id or by title: the `id` of a node in the file, the
   * title it has in the file, the id of a node already in the workspace, or the title of any node in the workspace
   * (imported or not), tried in that order. It takes its `weight` (1 to 10, else that of a new link) and `description`. A
   * link is skipped if either end is not found, if both ends are the same node, or if the two nodes are already linked.
   */
  async importFile(file: string, { nodesKey, linksKey }: ImportKeys): Promise<OpenResult & { nodes?: number; links?: number }> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      let data: unknown;
      try {
        data = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        throw new Error(`${basename(file)} is not valid JSON`);
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${basename(file)} is not a JSON object`);
      const source = data as Record<string, unknown>;
      /** The objects in the array under `key`; none if the file has no such array. */
      const objects = (key: string) => {
        const value = Object.hasOwn(source, key) ? source[key] : undefined;
        return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) : [];
      };

      const addedAt = new Date().toISOString();
      const entries = objects(nodesKey).map((entry) => {
        const path = importedText(entry.path);
        const [description, body] = [importedText(entry.description), importedText(entry.body)];
        const fallback = () => titleFrom([description, body, importedText(entry.filename), path?.split(/[\\/]/).pop(), importedText(entry.name), importedText(entry.label)]);
        return { entry, given: importedText(entry.title)?.trim() ?? '', description, body, fallback };
      });
      const titles = uniqueTitles(entries, new Set(this.nodes.map((node) => node.title)));
      const defaultType = this.nodeTypes.find((type) => type.id === DEFAULT_TYPE_ID)!;
      const nodes: NodeRecord[] = [];
      /** The workspace id of each imported node, by its `id` in the file, and by the title it has in the file. */
      const imported = new Map<string, string>();
      const importedTitles = new Map<string, string>();
      entries.forEach(({ entry, given, description, body }, index) => {
        const shown: DisplayField = given !== '' ? 'title' : description !== null ? 'description' : body !== null ? 'body' : 'title';
        const node: NodeRecord = { id: randomUUID(), addedAt, title: titles[index], description, body, display: [shown], type: defaultType.id, properties: propertyValues(defaultType, {}) };
        nodes.push(node);
        const key = importedKey(entry.id);
        if (key !== null && !imported.has(key)) imported.set(key, node.id);
        if (given !== '' && !importedTitles.has(given)) importedTitles.set(given, node.id);
      });

      const existing = new Set(this.nodes.map((node) => node.id));
      /** Every node's id by its title, whether it was already in the workspace or imported. */
      const byTitle = new Map([...this.nodes, ...nodes].map((node) => [node.title, node.id]));
      /** The workspace id of a link's end (see above for the order in which ids and titles are tried). */
      const end = (value: unknown) => {
        const key = importedKey(value);
        if (key === null) return undefined;
        return imported.get(key) ?? importedTitles.get(key.trim()) ?? (existing.has(key) ? key : undefined) ?? byTitle.get(key.trim());
      };
      const links = [...this.links];
      let linked = 0;
      for (const entry of objects(linksKey)) {
        const [from, to] = [end(entry.source), end(entry.target)];
        if (!from || !to || from === to) continue;
        if (links.some((link) => (link.source === from && link.target === to) || (link.source === to && link.target === from))) continue;
        const weight = typeof entry.weight === 'number' && Number.isFinite(entry.weight) && entry.weight >= 1 && entry.weight <= 10 ? entry.weight : NEW_LINK_WEIGHT;
        links.push({ id: randomUUID(), source: from, target: to, weight, description: importedText(entry.description) });
        linked += 1;
      }

      if (nodes.length > 0 || linked > 0) {
        const allNodes = [...this.nodes, ...nodes];
        await this.writeEntries(root, { nodes: allNodes, links });
        this.nodes = allNodes;
        this.links = links;
      }
      return { status: 'opened', workspace: this.state(), nodes: nodes.length, links: linked };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /**
   * Replaces the node `id` with one made from `input` in the `nodes` of `workspace.json`; a title another node has is given
   * an integer at its end (see `uniqueTitle`). A node with a file keeps one. Its
   * file is copied into the workspace folder if `input.file.copy` is newly set; a file already copied in stays copied
   * unless another file is chosen, and then the old copy is removed from the folder unless `input.keepOldCopy` is set.
   */
  async updateNode(id: string, input: NodeInput): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      const current = this.nodes.find((node) => node.id === id);
      if (!current) throw new Error('No such node in the workspace');
      const texts = textFields(input);
      texts.title = uniqueTitle(texts.title, new Set(this.nodes.filter((other) => other.id !== id).map((other) => other.title)));
      let node: NodeRecord = { id, addedAt: current.addedAt, ...texts, ...this.typeFields(input) };
      const currentFile = isFileNode(current) ? current : undefined;
      const wasCopied = currentFile !== undefined && !isAbsolute(currentFile.path);
      let copied: string | undefined;
      let discard: string | undefined;
      if (input.file) {
        const { source, copy } = input.file;
        if (source) {
          if (copy) {
            copied = await this.copyIn(root, source);
            node = { ...node, filename: copied, path: copied };
          } else {
            node = { ...node, ...(await outsideFile(source)) };
          }
          if (wasCopied && !input.keepOldCopy) discard = currentFile.path;
        } else {
          if (!currentFile) throw new Error('No file was chosen');
          if (wasCopied && !copy) throw new Error('A file copied into the workspace stays there until another file is chosen');
          if (!wasCopied && copy) {
            copied = await this.copyIn(root, currentFile.path);
            node = { ...node, filename: copied, path: copied };
          } else {
            node = { ...node, filename: currentFile.filename, path: currentFile.path };
          }
        }
      } else if (currentFile) {
        throw new Error('A node with a file keeps a file');
      }
      await this.saveNodes(root, this.nodes.map((candidate) => (candidate.id === id ? node : candidate)), copied);
      if (discard && basename(discard) === discard) await rm(join(root, discard), { force: true });
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /**
   * Records a link from the node `source` to the node `target`, with the weight of a new link, in the `links` of
   * `workspace.json`; if the two nodes are already linked (either way), nothing changes.
   */
  async createLink(source: string, target: string): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      if (source === target || ![source, target].every((id) => this.nodes.some((node) => node.id === id))) throw new Error('Not a valid link');
      // Only one link between two nodes, whichever way it points: a duplicate changes nothing, and is no error.
      if (this.links.some((link) => (link.source === source && link.target === target) || (link.source === target && link.target === source))) return { status: 'opened', workspace: this.state() };
      const links = [...this.links, { id: randomUUID(), source, target, weight: NEW_LINK_WEIGHT, description: null }];
      await this.writeLinks(root, links);
      this.links = links;
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /** Sets the weight (a number from 1 to 10) and the description (empty as `null`) of the link `id` in `workspace.json`. */
  async updateLink(id: string, { weight, description }: LinkInput): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      if (!Number.isFinite(weight) || weight < 1 || weight > 10) throw new Error(`Not a valid weight: ${weight}`);
      if (!this.links.some((link) => link.id === id)) throw new Error('No such link in the workspace');
      const links = this.links.map((link) => (link.id === id ? { ...link, weight, description: description || null } : link));
      await this.writeLinks(root, links);
      this.links = links;
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /**
   * Deletes the node `id` from `workspace.json`, with every link to or from it and its position in the saved layout. If
   * its file was copied into the workspace (and no other node has it), the copy is removed from the folder unless
   * `keepCopy` is set.
   */
  async deleteNode(id: string, keepCopy = false): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      const node = this.nodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error('No such node in the workspace');
      const nodes = this.nodes.filter((candidate) => candidate.id !== id);
      const links = this.links.filter((link) => link.source !== id && link.target !== id);
      const layout = this.layout && { ...this.layout, positions: Object.fromEntries(Object.entries(this.layout.positions).filter(([placed]) => placed !== id)) };
      await this.writeEntries(root, { nodes, links, ...(layout ? { layout } : {}) });
      [this.nodes, this.links, this.layout] = [nodes, links, layout];
      const copy = isFileNode(node) && !isAbsolute(node.path) ? node.path : undefined;
      const shared = nodes.some((other) => isFileNode(other) && other.path === copy);
      if (copy && !keepCopy && !shared && basename(copy) === copy) await rm(join(root, copy), { force: true });
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /** Deletes the link `id` from `workspace.json`. */
  async deleteLink(id: string): Promise<OpenResult> {
    try {
      const root = this.root;
      if (!root) throw new Error('No workspace is open');
      if (!this.links.some((link) => link.id === id)) throw new Error('No such link in the workspace');
      const links = this.links.filter((link) => link.id !== id);
      await this.writeLinks(root, links);
      this.links = links;
      return { status: 'opened', workspace: this.state() };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error), workspace: this.state() };
    }
  }

  /** Records `layout` (see SavedLayout) as the `layout` of `workspace.json`, replacing any there. */
  async saveLayout(layout: unknown): Promise<void> {
    const root = this.root;
    if (!root) throw new Error('No workspace is open');
    const parsed = parseSavedLayout(layout, new Set(this.nodes.map((node) => node.id)));
    await this.writeEntries(root, { layout: parsed });
    this.layout = parsed;
  }

  /** Copies the file at `source` into the workspace folder, under a free name; resolves with that name. */
  private async copyIn(root: string, source: string): Promise<string> {
    const filename = await this.freeName(root, basename(source));
    await copyFile(source, join(root, filename), constants.COPYFILE_EXCL);
    return filename;
  }

  /** Writes `nodes` to `workspace.json` and keeps them; if that fails, the file `copied` (just copied into the workspace folder) is removed again. */
  private async saveNodes(root: string, nodes: NodeRecord[], copied?: string): Promise<void> {
    try {
      await this.writeNodes(root, nodes);
      this.nodes = nodes;
    } catch (error) {
      if (copied) await rm(join(root, copied), { force: true });
      throw error;
    }
  }

  /** The contents of the file behind one node, base64-encoded. Only the files of nodes of the open workspace can be read. */
  async readNode(id: string): Promise<string> {
    const node = this.nodes.find((candidate) => candidate.id === id);
    if (!this.root || !node || !isFileNode(node)) throw new Error('No such file in the workspace');
    if (isAbsolute(node.path)) return (await readFile(node.path)).toString('base64');
    if (basename(node.path) !== node.path) throw new Error('No such file in the workspace');
    return (await readFile(join(this.root, node.path))).toString('base64');
  }

  async close(): Promise<void> {
    const lock = this.lock;
    this.lock = undefined;
    this.root = undefined;
    this.nodes = [];
    this.links = [];
    this.layout = undefined;
    this.nodeTypes = [];
    if (!lock) return;
    await lock.release();
    await this.runHook(() => this.options.onClosed?.());
  }

  /** Opens `folder` as the workspace: writes its `workspace.json` if it has none, takes the lock and loads the nodes and links. Fails, leaving the current workspace open, if another instance holds the lock. */
  async openFolder(folder: string): Promise<void> {
    if (folder === this.root) return;
    await this.ensureWorkspaceFile(folder);
    // Take the new lock before letting go of the current workspace, so a failed switch leaves it open.
    const lock = await acquireLock(folder);
    let nodes: NodeRecord[];
    let links: WorkspaceLink[];
    let layout: SavedLayout | undefined;
    let nodeTypes: NodeType[];
    try {
      // The default type is always there, but is written to the file only once the types change.
      nodeTypes = loadedNodeTypes((await this.readInfo(folder)).nodeTypes);
      nodes = await this.loadNodes(folder, nodeTypes);
      links = await this.loadLinks(folder);
      layout = await this.loadLayout(folder, nodes);
    } catch (error) {
      await lock.release();
      throw error;
    }
    await this.close();
    this.root = folder;
    this.lock = lock;
    this.nodes = nodes;
    this.links = links;
    this.layout = layout;
    this.nodeTypes = nodeTypes;
    await this.runHook(() => this.options.onOpened?.(folder));
  }

  /** Writes `workspace.json` if the folder has none; whatever else the folder holds is left alone. */
  private async ensureWorkspaceFile(folder: string): Promise<void> {
    const file = join(folder, WORKSPACE_FILE);
    if (await exists(file)) return;
    const info = { formatVersion: FORMAT_VERSION, workspaceId: randomUUID(), appId: this.options.appId, createdAt: new Date().toISOString(), createdBy: this.options.createdBy, nodes: [], links: [] };
    await mkdir(folder, { recursive: true });
    await writeFile(file, JSON.stringify(info, null, 2) + '\n', { flag: 'wx' });
  }

  /**
   * Reads the `nodes` of `workspace.json`, adding an empty `nodes` array to a file that has none. A node without a title,
   * or with one an earlier node has, is given a unique one (see `titledNodes`); a node of no type in `types` is of the
   * default type, and each node has a value for each of its type's properties (see `typedNodes`). If any node changed,
   * the nodes are written back.
   */
  private async loadNodes(folder: string, types: NodeType[]): Promise<NodeRecord[]> {
    const info = await this.readInfo(folder);
    if (Array.isArray(info.nodes)) {
      const nodes = info.nodes as NodeRecord[];
      const loaded = typedNodes(titledNodes(nodes), types);
      if (loaded.some((node, index) => node !== nodes[index])) await this.writeNodes(folder, loaded);
      return loaded;
    }
    await this.writeNodes(folder, []);
    return [];
  }

  /**
   * Reads the `links` of `workspace.json`; a file without them has no links (they are written with the first link). A
   * link written before links had descriptions has none (`null`); it is written with one the next time the links are.
   */
  private async loadLinks(folder: string): Promise<WorkspaceLink[]> {
    const info = await this.readInfo(folder);
    if (!Array.isArray(info.links)) return [];
    return (info.links as Partial<WorkspaceLink>[]).map((link) => ({ ...link, description: typeof link.description === 'string' && link.description !== '' ? link.description : null }) as WorkspaceLink);
  }

  /** Reads the `layout` of `workspace.json`; one that is missing or not valid is no layout (it is worked out afresh). */
  private async loadLayout(folder: string, nodes: NodeRecord[]): Promise<SavedLayout | undefined> {
    const info = await this.readInfo(folder);
    if (info.layout === undefined) return undefined;
    try {
      return parseSavedLayout(info.layout, new Set(nodes.map((node) => node.id)));
    } catch {
      return undefined;
    }
  }

  private async readInfo(folder: string): Promise<Record<string, unknown>> {
    let info: unknown;
    try {
      info = JSON.parse(await readFile(join(folder, WORKSPACE_FILE), 'utf8'));
    } catch {
      throw new Error(`${WORKSPACE_FILE} is not valid JSON: ${folder}`);
    }
    if (typeof info !== 'object' || info === null || Array.isArray(info)) throw new Error(`${WORKSPACE_FILE} is not a JSON object: ${folder}`);
    return info as Record<string, unknown>;
  }

  /** Replaces `nodes` in `workspace.json`, leaving its other entries as they are. */
  private async writeNodes(folder: string, nodes: NodeRecord[]): Promise<void> {
    await this.writeEntries(folder, { nodes });
  }

  /** Replaces `links` in `workspace.json`, leaving its other entries as they are. */
  private async writeLinks(folder: string, links: WorkspaceLink[]): Promise<void> {
    await this.writeEntries(folder, { links });
  }

  /** Replaces the given entries of `workspace.json`, leaving its others as they are. The file is swapped in whole. */
  private async writeEntries(folder: string, entries: { nodes?: NodeRecord[]; links?: WorkspaceLink[]; layout?: SavedLayout; nodeTypes?: NodeType[] }): Promise<void> {
    const info = { ...(await this.readInfo(folder)), ...entries };
    const file = join(folder, WORKSPACE_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(info, null, 2) + '\n');
    await rename(temp, file);
  }

  /** `name`, or `name (1)`, `name (2)`, … (before the extension) if the folder already has such a file. */
  private async freeName(folder: string, name: string): Promise<string> {
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let candidate = name;
    for (let n = 1; await exists(join(folder, candidate)); n += 1) candidate = `${stem} (${n})${extension}`;
    return candidate;
  }

  private async runHook(hook: () => void | Promise<void>): Promise<void> {
    try {
      await hook();
    } catch (error) {
      this.options.onHookError?.(error);
    }
  }
}
