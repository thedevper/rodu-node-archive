import type { Collection, Comment, Cycle, Item, Link } from "./model.ts";

export interface ContextParts {
  item: Item;
  collection: Collection;
  assignee: string | null;
  parent: Item | null;
  children: Item[];
  cycle: Cycle | null;
  links: { link: Link; targetItem: Item | null }[];
  incoming: { link: Link; fromItem: Item | null }[];
  comments: { comment: Comment; author: string; via: string | null }[];
}

/** One-line summary of an item: `MED-12 [In Progress] (high) Title`. */
export function itemLine(item: Item): string {
  const priority = item.priority === "none" ? "" : ` (${item.priority})`;
  return `${item.key} [${item.status}]${priority} ${item.title}`;
}

/**
 * Wraps text that people wrote, so an agent reading the bundle can tell data from instructions.
 * A closing tag inside the text is escaped, so content cannot break out of its fence.
 */
export function fence(source: string, text: string): string {
  const safe = text.replace(/<\/?untrusted-content/gi, (m) => m.replace("<", "&lt;"));
  return `<untrusted-content source="${source}">\n${safe}\n</untrusted-content>`;
}

const TRUNCATED = "\n\n[context truncated to fit the budget]";

/**
 * Renders an item and its surroundings as Markdown. Sections are added in order of usefulness
 * and the result is cut to `maxChars`; newest comments are kept when comments do not all fit.
 */
export function formatContext(parts: ContextParts, maxChars: number): string {
  const { item } = parts;
  const head = [
    `# ${itemLine(item)}`,
    "",
    `- collection: ${parts.collection.key} (${parts.collection.name})`,
    `- type: ${item.type}; status: ${item.status} (${item.category}); priority: ${item.priority}`,
    `- assignee: ${parts.assignee ?? "unassigned"}`,
    `- estimate: ${item.estimate ?? "none"}; due: ${item.dueAt ?? "none"}`,
    `- cycle: ${parts.cycle ? `${parts.cycle.name} (${parts.cycle.state})` : "none"}`,
    `- version: ${item.version}; updated: ${item.updatedAt}`,
  ];
  if (parts.parent) head.push(`- parent: ${itemLine(parts.parent)}`);

  const sections: string[] = [head.join("\n")];
  if (item.body.trim()) sections.push(`## Description\n\n${fence(`${item.key}:body`, item.body)}`);
  if (parts.children.length > 0) {
    sections.push(`## Children\n\n${parts.children.map((c) => `- ${itemLine(c)}`).join("\n")}`);
  }
  const links = [
    ...parts.links.map(({ link, targetItem }) => {
      const target = targetItem ? itemLine(targetItem) : link.target;
      return `- ${link.kind} → ${target}`;
    }),
    ...parts.incoming.map(({ link, fromItem }) => {
      const from = fromItem ? itemLine(fromItem) : link.fromItemId;
      return `- ${from} ${link.kind} this`;
    }),
  ];
  if (links.length > 0) sections.push(`## Links\n\n${links.join("\n")}`);

  let out = sections.join("\n\n");
  if (out.length > maxChars) return out.slice(0, maxChars - TRUNCATED.length) + TRUNCATED;

  if (parts.comments.length > 0) {
    const rendered = parts.comments.map(({ comment, author, via }) => {
      const who = via ? `${author} via ${via}` : author;
      return `### ${who} — ${comment.createdAt}\n\n${fence(`${item.key}:comment`, comment.body)}`;
    });
    const header = "\n\n## Comments\n\n";
    const kept: string[] = [];
    let used = out.length + header.length + TRUNCATED.length;
    for (let i = rendered.length - 1; i >= 0; i--) {
      const entry = rendered[i] as string;
      if (used + entry.length + 2 > maxChars) break;
      kept.unshift(entry);
      used += entry.length + 2;
    }
    if (kept.length > 0) out += header + kept.join("\n\n");
    if (kept.length < rendered.length) {
      out += `\n\n[${rendered.length - kept.length} older comment(s) omitted]`;
    }
  }
  return out;
}
