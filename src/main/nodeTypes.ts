import { randomUUID } from 'node:crypto';

/** The id of the default node type: the type of every node not given another (and of every node made before there were types). */
export const DEFAULT_TYPE_ID = 'default';

/** A property's value: text, or true or false. */
export type PropertyValue = string | boolean;

/** A property that the nodes of a type have: a key (its label) and the kind and default value of its value. */
export interface PropertyDefinition {
  id: string;
  /** Unique among the type's properties. */
  key: string;
  kind: 'text' | 'boolean';
  /** The value a node of the type starts with: text for a `text` property, true or false for a `boolean` one. */
  value: PropertyValue;
}

/** An entry of the `nodeTypes` array in `workspace.json`: a kind of node, with the background colour of its displays and the properties its nodes have. */
export interface NodeType {
  id: string;
  /** Unique among the workspace's node types: it identifies the type to the user. */
  name: string;
  /** The background colour of its nodes' displays, as `#rrggbb`. */
  colour: string;
  properties: PropertyDefinition[];
}

/** What the node type dialog sends to create or save a node type. A property without an `id` is new. */
export interface NodeTypeInput {
  name: string;
  colour: string;
  properties: { id?: string; key: string; kind: 'text' | 'boolean'; value: PropertyValue }[];
}

const DEFAULT_COLOUR = '#ffffff';
const COLOUR = /^#[0-9a-f]{6}$/i;

/** The default node type as it is before it is edited: white, with no properties. */
export const defaultNodeType = (): NodeType => ({ id: DEFAULT_TYPE_ID, name: 'Default', colour: DEFAULT_COLOUR, properties: [] });

const isKind = (kind: unknown): kind is 'text' | 'boolean' => kind === 'text' || kind === 'boolean';
const fitsKind = (kind: 'text' | 'boolean', value: unknown): value is PropertyValue => (kind === 'text' ? typeof value === 'string' : typeof value === 'boolean');

/** `value` as a `NodeTypeInput` (name and keys trimmed), or an error if it is not one, or if its name is empty or a key is empty or repeated. */
export function parseNodeTypeInput(value: unknown): NodeTypeInput {
  const input = value as Partial<NodeTypeInput> | null;
  if (typeof input !== 'object' || input === null || typeof input.name !== 'string' || typeof input.colour !== 'string' || !COLOUR.test(input.colour) || !Array.isArray(input.properties)) throw new Error('Invalid node type');
  const properties = input.properties.map((property: unknown) => {
    const p = property as Partial<PropertyDefinition> | null;
    if (typeof p !== 'object' || p === null || typeof p.key !== 'string' || !isKind(p.kind) || !fitsKind(p.kind, p.value) || (p.id !== undefined && typeof p.id !== 'string')) throw new Error('Invalid node type');
    return { ...(p.id === undefined ? {} : { id: p.id }), key: p.key.trim(), kind: p.kind, value: p.value };
  });
  const name = input.name.trim();
  if (name === '') throw new Error('A node type must have a name');
  if (properties.some(({ key }) => key === '')) throw new Error('A property must have a key');
  if (new Set(properties.map(({ key }) => key)).size !== properties.length) throw new Error("A node type's properties must have different keys");
  return { name, colour: input.colour.toLowerCase(), properties };
}

/** A node type made from `input`, with the id `id`; a property keeps its id if `existing` (the type being saved) has one with it, and is given a new one otherwise. */
export function nodeTypeFrom(id: string, input: NodeTypeInput, existing?: NodeType): NodeType {
  const known = new Set(existing?.properties.map((property) => property.id));
  return {
    id,
    name: input.name,
    colour: input.colour,
    properties: input.properties.map(({ id: propertyId, key, kind, value }) => ({ id: propertyId !== undefined && known.has(propertyId) ? propertyId : randomUUID(), key, kind, value })),
  };
}

/**
 * The `nodeTypes` read from `workspace.json`: entries that are not node types are dropped, as are properties that are
 * not valid, and a name taken by an earlier type is dropped with its type. The default type comes first, as it is if the
 * file has it, else as it is before it is edited.
 */
export function loadedNodeTypes(value: unknown): NodeType[] {
  const types: NodeType[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const type = entry as Partial<NodeType> | null;
    if (typeof type !== 'object' || type === null || typeof type.id !== 'string' || typeof type.name !== 'string' || type.name.trim() === '') continue;
    if (types.some((other) => other.id === type.id || other.name === type.name)) continue;
    const properties: PropertyDefinition[] = [];
    for (const property of Array.isArray(type.properties) ? type.properties : []) {
      const p = property as Partial<PropertyDefinition> | null;
      if (typeof p !== 'object' || p === null || typeof p.id !== 'string' || typeof p.key !== 'string' || p.key === '' || !isKind(p.kind) || !fitsKind(p.kind, p.value)) continue;
      if (properties.some((other) => other.id === p.id || other.key === p.key)) continue;
      properties.push({ id: p.id, key: p.key, kind: p.kind, value: p.value });
    }
    types.push({ id: type.id, name: type.name, colour: typeof type.colour === 'string' && COLOUR.test(type.colour) ? type.colour.toLowerCase() : DEFAULT_COLOUR, properties });
  }
  const own = types.find((type) => type.id === DEFAULT_TYPE_ID);
  const rest = types.filter((type) => type !== own);
  if (own) return [own, ...rest];
  const fallback = defaultNodeType();
  // A type that has taken the default's name keeps it; the default is then known by its id alone.
  if (rest.some((type) => type.name === fallback.name)) fallback.name = 'Default type';
  return [fallback, ...rest];
}

/**
 * A node's property values for `type`, by property id: each of the type's properties, with the value in `values` if it
 * is of the property's kind, and otherwise the property's default value. Values for other properties are dropped.
 */
export function propertyValues(type: NodeType, values: unknown): Record<string, PropertyValue> {
  const given = typeof values === 'object' && values !== null && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
  return Object.fromEntries(type.properties.map(({ id, kind, value }) => [id, Object.hasOwn(given, id) && fitsKind(kind, given[id]) ? given[id] : value]));
}
