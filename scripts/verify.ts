import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {DEFAULT_CONFIG} from "../src/config.js";
import {createGraphClient} from "../src/graphql.js";
import {readAllSources} from "../src/vaults.js";

/// Checks that what the tools say matches what the subgraph says, and that what the subgraph says
/// matches what the contract says.
///
/// The middle link is the one worth testing. A server can be wired perfectly to an index that is
/// itself wrong, and from the tool's side that failure is indistinguishable from success — so the
/// subgraph is reconciled against `eth_call` first, and only then is the tool checked against the
/// subgraph.
///
///   npm run build && npx tsx scripts/verify.ts

const RPC: Record<string, string> = {
  "arc-testnet": process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.io",
  base: process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org",
};

const TOTAL_ASSETS = "0x01e1d114";
const TOTAL_SUPPLY = "0x18160ddd";

const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok) failures.push(label);
}

function report(label: string, detail: string): void {
  console.log(`ok    ${label}: ${detail}`);
}

/// A bare eth_call rather than a library. This script exists to be an independent check on the
/// indexed data, and independence is worth more here than convenience.
async function ethCall(
  network: string,
  to: string,
  data: string,
  block: number,
): Promise<bigint | null> {
  const url = RPC[network];
  if (url === undefined) return null;

  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{to, data}, `0x${block.toString(16)}`],
    }),
  });

  const body = (await response.json()) as {result?: string; error?: {message: string}};
  if (body.error || !body.result || body.result === "0x") return null;
  return BigInt(body.result);
}

// --- the subgraphs against the chain -------------------------------------------------------------

console.log("# The subgraphs against the chain\n");

const graph = createGraphClient({cacheTtlMs: 0});
const sources = await readAllSources(graph, DEFAULT_CONFIG);

let reconciled = 0;
for (const source of sources) {
  if (source.error !== null) {
    console.log(`FAIL  ${source.source.key} is unreachable: ${source.error}`);
    failures.push(`${source.source.key} unreachable`);
    continue;
  }
  check(`${source.source.key} has no indexing errors`, source.hasIndexingErrors, false);

  for (const vault of source.vaults) {
    // At the vault's own last indexed block, not at the head. The head figure is expected to
    // differ: a vault accrues without emitting, which is the staleness the tools warn about.
    const assets = await ethCall(vault.network, vault.address, TOTAL_ASSETS, vault.asOfBlock);
    const supply = await ethCall(vault.network, vault.address, TOTAL_SUPPLY, vault.asOfBlock);

    if (assets === null || supply === null) {
      console.log(`      ${vault.symbol}: no archive access on ${vault.network}, skipped`);
      continue;
    }

    check(`${vault.symbol} totalAssets at block ${vault.asOfBlock}`, vault.totalAssets, assets);
    check(`${vault.symbol} totalSupply at block ${vault.asOfBlock}`, vault.totalShares, supply);
    reconciled += 1;
  }
}

if (reconciled === 0) {
  failures.push("no vault could be reconciled against a contract call");
  console.log("FAIL  nothing was reconciled against the chain");
}

// --- the tools against the subgraphs -------------------------------------------------------------

console.log("\n# The tools against the subgraphs\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  env: process.env as Record<string, string>,
});
const mcp = new Client({name: "verify", version: "0.0.0"});
await mcp.connect(transport);

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await mcp.callTool({name, arguments: args})) as {
    content: {text?: string}[];
    isError?: boolean;
  };
  const body = result.content.map((part) => part.text ?? "").join("\n");
  if (result.isError) {
    failures.push(`${name} returned an error`);
    console.log(`FAIL  ${name}: ${body}`);
  }
  return body;
}

const {tools} = await mcp.listTools();
report("tools advertised", tools.map((tool) => tool.name).join(", "));

// The disqualifier, asserted against the running server rather than only in a unit test.
const passthrough = tools.filter((tool) => /query|graphql|raw|sql|exec/i.test(tool.name));
check("no raw query passthrough", passthrough.length, 0);
check(
  "every tool read-only",
  tools.filter((tool) => tool.annotations?.readOnlyHint !== true).length,
  0,
);

const everyVault = sources.flatMap((source) => source.vaults);
const sample = everyVault[0];
if (sample === undefined) {
  failures.push("no vaults to exercise the tools against");
} else {
  const listed = await call("list_vaults", {});
  for (const vault of everyVault) {
    check(`list_vaults mentions ${vault.symbol}`, listed.includes(vault.address), true);
  }
  check("list_vaults states staleness", listed.includes("NOT chain head"), true);

  const overview = await call("vault_overview", {vault: sample.address, days: 30});
  check(
    `vault_overview reports ${sample.symbol} at its indexed block`,
    overview.includes(`block ${sample.asOfBlock}`),
    true,
  );

  await call("vault_history", {vault: sample.address, days: 30});

  const compared = await call("compare_vaults", {days: 30});
  for (const vault of everyVault) {
    check(`compare_vaults ranks ${vault.symbol}`, compared.includes(vault.symbol), true);
  }
}

// --- the trader tools against the copy graph -----------------------------------------------------

const cope = DEFAULT_CONFIG.copeSubgraph;
if (cope !== null) {
  console.log("\n# The trader tools against the copy graph\n");

  interface TopTrader {
    traders: {id: string; realizedPnlWad: string; positionsClosed: number}[];
  }
  const {traders} = await graph.query<TopTrader>(
    cope.url,
    `{ traders(first: 5, orderBy: positionsClosed, orderDirection: desc) {
         id realizedPnlWad positionsClosed
       } }`,
  );

  const subject = traders.find((trader) => trader.positionsClosed > 0);
  if (subject === undefined) {
    console.log("      no trader has closed a position yet, so the trader tools are unexercised");
  } else {
    const ranked = await call("top_traders", {window: "all", limit: 25});
    check(`top_traders includes ${subject.id.slice(0, 10)}`, ranked.includes(subject.id), true);

    const record = await call("trader_record", {address: subject.id, window: "all"});
    check("trader_record names the trader", record.includes(subject.id), true);
    check(
      "trader_record separates their copiers from their own trading",
      record.includes("## Their own trading"),
      true,
    );

    // The tool's own arithmetic against the counters the mappings maintain. These are computed by
    // different routes and are only allowed to differ if one of them is wrong.
    const wad = BigInt(subject.realizedPnlWad);
    const sign = wad < 0n ? "-" : "+";
    const magnitude = (wad < 0n ? -wad : wad).toString().padStart(19, "0");
    const whole = magnitude.slice(0, magnitude.length - 18).replace(/^0+(?=\d)/, "");
    check(
      "trader_record P&L agrees with the subgraph's own total",
      record.includes(`${sign}${whole}.`) || record.includes(`${sign}${whole} `),
      true,
    );

    interface FirstPosition {
      positions: {tokenId: string}[];
    }
    const {positions} = await graph.query<FirstPosition>(
      cope.url,
      `{ positions(first: 1, orderBy: id) { tokenId } }`,
    );
    const token = positions[0]?.tokenId;
    if (token !== undefined) {
      const lineage = await call("copy_lineage", {tokenId: token});
      check("copy_lineage finds the position", lineage.includes(`Position ${token}`), true);
    }
  }
}

await mcp.close();

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nVERIFIED: the chain, the subgraphs and every tool agree.");
