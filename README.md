# erc4626-mcp

An MCP server that reasons over ERC-4626 vault subgraphs and the Cope Market copy graph, reading
live data from The Graph.

Point it at any subgraph following the [standardized ERC-4626
schema](https://github.com/cope-market/subgraphs) and it will describe, chart and rank the vaults
there — across chains and across protocols, with no per-protocol code.

## Install

```bash
npx @cope-market/erc4626-mcp
```

In a client that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "erc4626": {
      "command": "npx",
      "args": ["-y", "@cope-market/erc4626-mcp"]
    }
  }
}
```

No API key, no account, nothing to configure. The shipped default reads three live deployments
across two chains, which is enough to try every tool.

## The tools

| Tool             | Answers                                                        |
| ---------------- | -------------------------------------------------------------- |
| `list_vaults`    | What vaults are visible, with assets, decimals and share price |
| `vault_overview` | One vault's size, holders, and whether it is growing           |
| `vault_history`  | Return, annualised rate, maximum drawdown, daily share price   |
| `compare_vaults` | Every visible vault ranked by return                           |
| `top_traders`    | Traders ranked by realised P&L over a window                   |
| `trader_record`  | One trader's results, and separately how their copiers did     |
| `copy_lineage`   | One position's copy tree, and whether copying it paid          |

The trader tools appear only when a Cope Market subgraph is configured.

### There is deliberately no `run_query` tool

The Graph's own brief rules out "simply querying one Subgraph". An MCP server that exposes a raw
GraphQL passthrough is that, relabelled as tooling: it moves the querying to the model and computes
nothing itself. So every tool here computes something no single query returns — a drawdown is the
whole series walked, a windowed ranking is individual positions aggregated, a copier outcome is
positions grouped by the author of the position they copied rather than by their own author.

A test asserts no tool name ever looks like a query passthrough.

## Configuration

```bash
ERC4626_MCP_CONFIG=/path/to/config.json npx @cope-market/erc4626-mcp
```

```json
{
  "vaultSubgraphs": [
    {
      "key": "my-vaults",
      "label": "My vaults",
      "network": "mainnet",
      "url": "https://api.studio.thegraph.com/query/.../my-erc4626/v0.1.0"
    }
  ],
  "copeSubgraph": null
}
```

One subgraph can index many vaults; the tools enumerate across all of them. A malformed config file
fails at startup rather than falling back to the default — falling back would answer about our
vaults while you believed it was answering about yours.

## Safety

Read-only by construction. There is no signer in the process, no write path, and nothing that
takes a private key. Every tool is annotated `readOnlyHint: true` and a test enforces it. An agent
pointed at this can be wrong; it cannot be dangerous.

## Design notes

**Unknown is never rounded to zero.** A vault with one snapshot has no return — reporting zero
would read as "flat", which is a claim about performance rather than an admission of ignorance.
Those vaults rank last in a comparison rather than mid-table. The same holds for an address with no
history and for an empty window.

**Balances never pass through a float.** An eighteen-decimal balance is past what a double holds
exactly, so amounts are formatted digit by digit and sums are `BigInt`. Share prices are ratios
near one and do go through a double, which is safe and is stated where it happens.

**Annualising is refused below a day.** Compounding a rounding difference over a few hundred
periods is how a vault that moved 0.01% in an hour gets advertised at 8000% APY.

**Every figure carries its block.** A vault's assets move without emitting anything, so a subgraph
figure is as of the last indexed event and not the chain head. Handed a bare number, a model will
state it as current.

## Development

```bash
npm install
npm run check    # format, typecheck, test, build
npm run build && npx tsx scripts/smoke.ts   # every tool against the live subgraphs
```

`scripts/smoke.ts` spawns the built server and speaks the protocol to it over stdio, which is the
only check that the thing a user installs actually works.

## Licence

MIT.
