import { z } from "zod";

export const CATEGORIES = ["backlog", "active", "review", "done"] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ["none", "urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ITEM_TYPES = ["epic", "story", "task", "bug", "subtask"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const LINK_KINDS = ["blocks", "relates", "duplicates", "implements_pr"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const CYCLE_STATES = ["planned", "active", "closed"] as const;
export type CycleState = (typeof CYCLE_STATES)[number];

export const StateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.enum(CATEGORIES),
});
export type State = z.infer<typeof StateSchema>;

export const RuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("requireAssignee") }),
  z.object({ kind: z.literal("requireEstimate") }),
  z.object({ kind: z.literal("requireLink"), link: z.enum(LINK_KINDS) }),
]);
export type Rule = z.infer<typeof RuleSchema>;

export const TransitionSchema = z.object({
  /** State name, or "*" for any state. */
  from: z.string().min(1),
  to: z.string().min(1),
  rules: z.array(RuleSchema).default([]),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const WorkflowSchema = z.object({
  states: z.array(StateSchema).min(1),
  initial: z.string().min(1),
  transitions: z.array(TransitionSchema),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const COLLECTION_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

export interface Principal {
  id: string;
  kind: "human" | "agent";
  name: string;
  /** Agents are always owned by a human principal. */
  ownerId: string | null;
}

/** Who performs a command: the principal, and the agent acting for them, if any. */
export interface Actor {
  principalId: string;
  viaAgentId: string | null;
}

export interface Collection {
  id: string;
  key: string;
  name: string;
  preset: "dev";
  workflow: Workflow;
  createdAt: string;
}

export interface Cycle {
  id: string;
  collectionId: string;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  state: CycleState;
}

export interface Item {
  id: string;
  collectionId: string;
  number: number;
  /** Human-readable short id, e.g. MED-12. */
  key: string;
  type: ItemType;
  title: string;
  /** Markdown body. */
  body: string;
  status: string;
  category: Category;
  priority: Priority;
  assigneeId: string | null;
  parentId: string | null;
  cycleId: string | null;
  estimate: number | null;
  rank: string;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Comment {
  id: string;
  itemId: string;
  authorId: string;
  viaAgentId: string | null;
  body: string;
  createdAt: string;
}

export interface Link {
  id: string;
  fromItemId: string;
  kind: LinkKind;
  /** An item id, or a URL for implements_pr. */
  target: string;
  createdAt: string;
}

export interface ShoalEvent {
  id: string;
  requestId: string;
  actorId: string;
  viaAgentId: string | null;
  action: string;
  targetId: string;
  before: unknown;
  after: unknown;
  at: string;
}

/** A calendar date, YYYY-MM-DD, that actually exists. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const date = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(s);
  }, "not a real date");
const isoDate = IsoDateSchema;

/**
 * One line of text people wrote: no control characters, Unicode line/paragraph separators or
 * invisible format characters (bidi marks and overrides, zero-width space, U+061C), any of
 * which could forge structure when the text is rendered for an agent. ZWNJ/ZWJ and emoji tag
 * characters (subdivision flags) stay allowed because emoji and some scripts need them.
 */
export const SINGLE_LINE =
  /^(?:[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\u200C|\u200D|[\u{E0020}-\u{E007F}])*$/u;
const title = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(SINGLE_LINE, "must be one line without control characters");

export const NewItemSchema = z.object({
  title,
  type: z.enum(ITEM_TYPES).default("task"),
  body: z.string().max(100_000).default(""),
  priority: z.enum(PRIORITIES).default("none"),
  /** Principal name, id or "me". */
  assignee: z.string().min(1).optional(),
  /** Parent item key (MED-3) or id. */
  parent: z.string().min(1).optional(),
  estimate: z.number().nonnegative().max(1000).optional(),
  dueAt: isoDate.optional(),
  /** Cycle name in the same collection. */
  cycle: z.string().min(1).optional(),
});
export type NewItem = z.input<typeof NewItemSchema>;

export const ItemPatchSchema = z
  .object({
    title,
    type: z.enum(ITEM_TYPES),
    body: z.string().max(100_000),
    priority: z.enum(PRIORITIES),
    assignee: z.string().min(1).nullable(),
    parent: z.string().min(1).nullable(),
    estimate: z.number().nonnegative().max(1000).nullable(),
    dueAt: isoDate.nullable(),
    cycle: z.string().min(1).nullable(),
  })
  .partial()
  .strict();
export type ItemPatch = z.input<typeof ItemPatchSchema>;
