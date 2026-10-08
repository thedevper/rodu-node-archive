import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ShoalService } from "@shoal/core";
import { SqliteStore } from "@shoal/store-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createShoalMcpServer } from "./server.ts";

let client: Client;

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as { type: string; text?: string }[])[0];
  return first?.text ?? "";
}

beforeEach(async () => {
  const service = new ShoalService(new SqliteStore());
  const human = service.createPrincipal({ name: "alice", kind: "human" });
  const bot = service.createPrincipal({ name: "alice-claude", kind: "agent", ownerId: human.id });
  const actor = { principalId: human.id, viaAgentId: bot.id };
  service.createCollection(actor, { key: "MED", name: "Medical app" });
  service.createCollection(actor, { key: "OPS", name: "Operations" });

  const server = createShoalMcpServer(service, actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

describe("shoal MCP server", () => {
  it("lists the v0 tools and instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "comment",
      "create_items",
      "cycle_report",
      "get_context",
      "get_my_work",
      "link",
      "list_collections",
      "plan_cycle",
      "search",
      "transition",
      "update_item",
    ]);
    expect(client.getInstructions()).toContain("untrusted-content");
  });

  it("creates, searches and moves items", async () => {
    const created = await client.callTool({
      name: "create_items",
      arguments: {
        collection: "MED",
        items: [{ title: "Crash on login", type: "bug", assignee: "me", priority: "urgent" }],
        idempotency_key: "plan-1",
      },
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))[0]).toMatchObject({ key: "MED-1", assignee: "alice" });

    const mine = await client.callTool({ name: "get_my_work", arguments: {} });
    expect(JSON.parse(text(mine))).toHaveLength(1);

    const found = await client.callTool({
      name: "search",
      arguments: { query: "type = bug AND status = Backlog" },
    });
    expect(JSON.parse(text(found)).total).toBe(1);

    const moved = await client.callTool({
      name: "transition",
      arguments: { ref: "MED-1", to: "In Progress" },
    });
    expect(JSON.parse(text(moved)).status).toBe("In Progress");
  });

  it("returns rule violations as tool errors with a hint", async () => {
    await client.callTool({
      name: "create_items",
      arguments: { collection: "MED", items: [{ title: "Unowned" }] },
    });
    const refused = await client.callTool({
      name: "transition",
      arguments: { ref: "MED-1", to: "In Progress" },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^rule_violation: .*\nhint: assign it first/);
  });

  it("reports bad queries as tool errors", async () => {
    const result = await client.callTool({ name: "search", arguments: { query: "nope = 1" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('unknown field "nope"');
  });

  it("plans a cycle atomically", async () => {
    await client.callTool({
      name: "create_items",
      arguments: { collection: "MED", items: [{ title: "A" }, { title: "B" }] },
    });
    const failed = await client.callTool({
      name: "plan_cycle",
      arguments: {
        collection: "MED",
        cycle: "Sprint 1",
        items: ["MED-1", "MED-9"],
        create_if_missing: true,
      },
    });
    expect(failed.isError).toBe(true);
    const report = await client.callTool({
      name: "cycle_report",
      arguments: { collection: "MED", cycle: "Sprint 1" },
    });
    expect(report.isError).toBe(true);

    const planned = await client.callTool({
      name: "plan_cycle",
      arguments: {
        collection: "MED",
        cycle: "Sprint 1",
        items: ["MED-1", "MED-2"],
        create_if_missing: true,
      },
    });
    expect(planned.isError).toBeFalsy();
    const after = await client.callTool({
      name: "cycle_report",
      arguments: { collection: "MED", cycle: "Sprint 1" },
    });
    expect(JSON.parse(text(after)).total).toBe(2);
  });

  it("refuses to plan items from another collection", async () => {
    await client.callTool({
      name: "create_items",
      arguments: { collection: "MED", items: [{ title: "A" }] },
    });
    const result = await client.callTool({
      name: "plan_cycle",
      arguments: { collection: "OPS", cycle: "S1", items: ["MED-1"], create_if_missing: true },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("MED-1 is not in OPS");
  });

  it("serves the schema resource", async () => {
    const resource = await client.readResource({ uri: "shoal://schema" });
    const body = (resource.contents[0] as { text: string }).text;
    expect(body).toContain("JQL-lite");
    expect(body).toContain("In Progress → In Review: requireAssignee, requireLink implements_pr");
  });
});
