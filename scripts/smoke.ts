import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

/// Drives the built server as a real client would: spawns it, speaks the protocol over stdio, and
/// calls every tool against the live subgraphs.
///
/// Arguments are supplied per tool. Calling everything with an empty object only proved that the
/// schemas reject nothing, which is the one thing they should do.
const ARGS: Record<string, Record<string, unknown>> = {
  list_vaults: {},
  vault_overview: {vault: "COPE-LP", days: 30},
  vault_history: {vault: "mwUSDC", days: 30, includeSeries: false},
  compare_vaults: {days: 30},
  top_traders: {window: "all", limit: 10},
  trader_record: {address: "0xeeb3e0999D01f0d1Ed465513E414725a357F6ae4", window: "all"},
  copy_lineage: {tokenId: "1"},
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  env: process.env as Record<string, string>,
});

const client = new Client({name: "smoke", version: "0.0.0"});
await client.connect(transport);

const {tools} = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

let failed = 0;
for (const tool of tools) {
  const args = ARGS[tool.name];
  if (args === undefined) {
    console.log(`--- ${tool.name}: NO SMOKE ARGUMENTS DEFINED`);
    failed += 1;
    continue;
  }

  const started = Date.now();
  const result = (await client.callTool({name: tool.name, arguments: args})) as {
    content: {type: string; text?: string}[];
    isError?: boolean;
  };
  const text = result.content.map((part) => part.text ?? "").join("\n");
  if (result.isError) failed += 1;
  console.log(`--- ${tool.name} (${Date.now() - started}ms)${result.isError ? " ERROR" : ""}`);
  console.log(text);
  console.log("");
}

await client.close();

if (failed > 0) {
  console.error(`FAILED: ${failed} tool(s)`);
  process.exit(1);
}
console.log("All tools answered against live subgraphs.");
