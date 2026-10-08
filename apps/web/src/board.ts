import type { ItemView, State } from "./api.ts";

/** Cards per workflow state, keeping the rank order the API returned. */
export function groupByState(states: State[], items: ItemView[]): Map<string, ItemView[]> {
  const columns = new Map<string, ItemView[]>(states.map((s) => [s.name, []]));
  const byLower = new Map(states.map((s) => [s.name.toLowerCase(), s.name]));
  for (const item of items) {
    const name = byLower.get(item.status.toLowerCase());
    if (name) columns.get(name)?.push(item);
  }
  return columns;
}

export interface DropTarget {
  after: string | null;
  before: string | null;
}

/**
 * Neighbours for dropping `key` at `index` of `column` (index counted without the dragged card).
 * Returns null when the card would land where it already is, or the column is otherwise empty.
 */
export function dropNeighbours(column: ItemView[], key: string, index: number): DropTarget | null {
  const others = column.filter((i) => i.key !== key);
  const at = Math.max(0, Math.min(index, others.length));
  const after = others[at - 1]?.key ?? null;
  const before = others[at]?.key ?? null;
  if (!after && !before) return null;
  const current = column.findIndex((i) => i.key === key);
  if (current !== -1 && current === at) return null;
  return { after, before };
}

/** Insertion index from the pointer's Y position over the cards' vertical midpoints. */
export function insertionIndex(midpoints: number[], y: number): number {
  const index = midpoints.findIndex((mid) => y < mid);
  return index === -1 ? midpoints.length : index;
}
