import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import type {Config} from "../src/config.js";
import type {GraphClient} from "../src/graphql.js";
import {createServer} from "../src/server.js";

export const TEST_CONFIG: Config = {
  vaultSubgraphs: [
    {key: "one", label: "Vault subgraph one", network: "arc-testnet", url: "https://one.invalid"},
    {key: "two", label: "Vault subgraph two", network: "base", url: "https://two.invalid"},
  ],
  copeSubgraph: {url: "https://cope.invalid"},
};

export interface Recorded {
  url: string;
  document: string;
  variables: Record<string, unknown>;
}

/// Answers from a per-URL script, so a test can give two subgraphs different answers and assert
/// that a tool merged them rather than reading one twice.
export function fakeGraph(byUrl: Record<string, unknown | (() => unknown)>): {
  client: GraphClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    client: {
      async query<T>(
        url: string,
        document: string,
        variables: Record<string, unknown> = {},
      ): Promise<T> {
        calls.push({url, document, variables});
        const answer = byUrl[url];
        if (answer === undefined) throw new Error(`fakeGraph has no answer for ${url}`);
        return (typeof answer === "function" ? answer() : answer) as T;
      },
    },
  };
}

/// Drives the server the way a real client does — over the protocol, not by calling the handler.
/// A tool that is registered wrong, or whose schema does not match what it reads, fails here and
/// nowhere else.
export async function connect(config: Config, client: GraphClient): Promise<Client> {
  const server = createServer(config, client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({name: "test", version: "0.0.0"});
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  return mcp;
}

export async function callText(
  mcp: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = (await mcp.callTool({name, arguments: args})) as {
    content: {type: string; text?: string}[];
    isError?: boolean;
  };
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export function vaultsResponse(block: number, vaults: Partial<Record<string, unknown>>[]): unknown {
  return {
    _meta: {block: {number: block}, hasIndexingErrors: false},
    vaults: vaults.map((vault) => ({
      id: "0x0ffabc4e80125c5742d5ed04cc1fd1b634bc3c5d",
      name: "Cope Market Liquidity",
      symbol: "COPE-LP",
      decimals: 18,
      totalAssets: "30000000",
      totalShares: "30000000000000000000",
      sharePrice: "1",
      depositCount: 1,
      withdrawCount: 0,
      openPositionCount: 1,
      lastUpdatedBlock: String(block),
      lastUpdatedTimestamp: "1757660400",
      asset: {symbol: "USDC", decimals: 6},
      ...vault,
    })),
  };
}
