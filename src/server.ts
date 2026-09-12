import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {Config} from "./config.js";
import type {GraphClient} from "./graphql.js";
import {registerTraderTools} from "./tools-traders.js";
import {registerVaultTools} from "./tools-vaults.js";
import {formatUnits, readAllSources, trimDecimal} from "./vaults.js";

export const SERVER_NAME = "erc4626-mcp";
export const SERVER_VERSION = "0.1.0";

/// Every tool is read-only, and the server holds no key and can send no transaction. That is a
/// property of what is built here rather than a promise in a document: there is no signer to
/// misuse.
const READ_ONLY = {readOnlyHint: true, destructiveHint: false, openWorldHint: true} as const;

export function createServer(config: Config, client: GraphClient): McpServer {
  const server = new McpServer({name: SERVER_NAME, version: SERVER_VERSION});

  server.registerTool(
    "list_vaults",
    {
      title: "List the ERC-4626 vaults this server can see",
      description:
        "Enumerates every vault across the configured subgraphs, with its asset, decimals, " +
        "current share price and how far each subgraph has indexed. Start here: the addresses " +
        "and source keys it returns are what the other tools take as arguments. Reports a " +
        "subgraph that is unreachable rather than omitting it.",
      annotations: READ_ONLY,
    },
    async () => {
      const results = await readAllSources(client, config);

      const lines: string[] = [];
      for (const result of results) {
        if (result.error !== null) {
          lines.push(`## ${result.source.label} (${result.source.key}) — UNAVAILABLE`);
          lines.push(result.error);
          lines.push("");
          continue;
        }

        lines.push(`## ${result.source.label} (${result.source.key})`);
        lines.push(
          `network ${result.source.network}, indexed to block ${result.indexedToBlock}` +
            (result.hasIndexingErrors ? ", WITH INDEXING ERRORS" : ""),
        );
        if (result.vaults.length === 0) lines.push("No vaults indexed yet.");

        for (const vault of result.vaults) {
          lines.push("");
          lines.push(`### ${vault.name} (${vault.symbol})`);
          lines.push(`- address: ${vault.address}`);
          lines.push(
            `- asset: ${vault.assetSymbol}, ${vault.assetDecimals} decimals; ` +
              `shares ${vault.shareDecimals} decimals`,
          );
          lines.push(
            `- total assets: ${formatUnits(vault.totalAssets, vault.assetDecimals)} ` +
              `${vault.assetSymbol}`,
          );
          lines.push(
            `- share price: ${trimDecimal(vault.sharePrice)} ${vault.assetSymbol} per share`,
          );
          lines.push(`- holders: ${vault.holders}`);
          lines.push(`- deposits: ${vault.depositCount}, withdrawals: ${vault.withdrawCount}`);
          lines.push(
            `- as of block ${vault.asOfBlock} ` +
              `(${new Date(vault.asOfTimestamp * 1000).toISOString()}), NOT chain head`,
          );
        }
        lines.push("");
      }

      lines.push(
        "Note: these figures are as of each vault's last indexed event, not the current block. " +
          "A vault's assets move without emitting anything — yield accrues, and a vault that is " +
          "counterparty to something wins and loses on it — so report them with their block, or " +
          "read the contract for a live number.",
      );

      return {content: [{type: "text" as const, text: lines.join("\n")}]};
    },
  );

  registerVaultTools(server, config, client);
  registerTraderTools(server, config, client);

  return server;
}
