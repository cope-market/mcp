import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

/// Drives the built server as a real client would: spawns it, speaks the protocol over stdio, and
/// calls every tool against the live subgraphs. This is the check that the thing a judge installs
/// actually works, which no unit test can tell you.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  env: process.env as Record<string, string>,
});

const client = new Client({name: "smoke", version: "0.0.0"});
await client.connect(transport);

const {tools} = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

for (const tool of tools) {
  const started = Date.now();
  const result = (await client.callTool({name: tool.name, arguments: {}})) as {
    content: {type: string; text?: string}[];
    isError?: boolean;
  };
  const text = result.content.map((part) => part.text ?? "").join("\n");
  console.log(`--- ${tool.name} (${Date.now() - started}ms)${result.isError ? " ERROR" : ""}`);
  console.log(text);
}

await client.close();
