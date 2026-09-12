#!/usr/bin/env node
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {loadConfig} from "./config.js";
import {createGraphClient} from "./graphql.js";
import {createServer} from "./server.js";

/// stdio, because that is what makes this runnable with no hosting: a judge adds one line to a
/// client config and the server is theirs. Nothing is written to stdout except protocol traffic —
/// a stray console.log on stdout corrupts the stream and the client simply disconnects — so every
/// diagnostic goes to stderr.
async function main(): Promise<void> {
  const config = loadConfig();
  const client = createGraphClient();
  const server = createServer(config, client);

  await server.connect(new StdioServerTransport());

  console.error(
    `erc4626-mcp ready over stdio: ${config.vaultSubgraphs.length} vault subgraph(s)` +
      `${config.copeSubgraph ? " plus the Cope Market copy graph" : ""}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
