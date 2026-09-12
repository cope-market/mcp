---
name: erc4626-vaults
description: Use when asked about an ERC-4626 tokenized vault's size, share price, return, drawdown or flows; when comparing vaults across protocols or chains; or when asked about Cope Market traders, their realised P&L, or whether copying someone has paid. Reads live subgraph data through The Graph.
---

# ERC-4626 vaults and the Cope Market copy graph

This server answers questions about tokenized vaults and about the people trading against one of
them. It reads live subgraphs through The Graph. It is read-only: there is no key in the process
and no tool that can move anything.

## Start here

Call `list_vaults` first. It returns the vaults this server can see, with their addresses, source
keys, assets and decimals. Every other vault tool takes a vault identifier, and `list_vaults` is
where the valid ones come from.

## Which tool answers which question

| The question                                        | The tool         |
| --------------------------------------------------- | ---------------- |
| "What vaults can you see?"                          | `list_vaults`    |
| "How big is X? Is it growing?"                      | `vault_overview` |
| "How has X performed? What was the worst drawdown?" | `vault_history`  |
| "Which vault has done best?"                        | `compare_vaults` |
| "Who are the best traders?"                         | `top_traders`    |
| "Is this trader any good? Should I copy them?"      | `trader_record`  |
| "Did copying this call make anyone money?"          | `copy_lineage`   |

Vault identifiers can be an address, a symbol such as `mwUSDC`, or a name. If a name matches several
vaults the tool lists them and asks you to pick by address — do that rather than guessing.

The trader tools only exist when a Cope Market subgraph is configured. If you cannot see
`top_traders`, this deployment is pointed at vaults only, and questions about traders have no answer
here.

## Things to get right when reporting these answers

**Vault figures are as of the last indexed event, not the current block.** Every answer states the
block and the timestamp. A vault's assets move without emitting anything — yield accrues — so
saying "currently" about a figure from three hours ago is wrong. Say what it was and when, or
suggest reading the contract for a live number.

**Unknown is not zero, and the tools are careful to distinguish them.** A vault with one snapshot
has no return, shown as `n/a`. An address with no history is not a trader with a record of zero.
An empty window is not a set of traders who all broke even. Carry that distinction into your
answer rather than flattening it back to zero.

**Snapshots exist only for days with activity.** A gap in a history series is a quiet day, not
missing data and not a day the vault was worth nothing.

**A trader's own P&L and their copiers' P&L are different numbers.** Someone can be profitable
while everyone following them loses, because a copy opens at its own entry price and therefore
enters later and on worse terms. When asked whether to copy someone, the copier figure is the one
that answers the question.

**Realised P&L excludes open positions.** An open position's P&L is a mark that moves with the
oracle, not a result.

**Credit belongs to the author, not the holder.** Position NFTs are transferable. The tools report
both when they differ; attribute the call to the author.

**A drawdown is a fall.** It is reported as a positive percentage, so 25.00% means the vault lost a
quarter from its peak.

## Units

Two scales appear, sometimes in the same answer, and they are never added to each other.

- Realised P&L is USD.
- Collateral, payouts, author fees and liquidation rewards are USDC.
- Vault balances are in that vault's own asset, at that asset's decimals, which differ per vault.

## What this cannot do

It cannot trade, sign, deposit or withdraw. It cannot tell you a vault's balance at the current
block — only at the last block it indexed. It has no price feed, so it cannot convert between
assets or value a WETH vault in dollars. It knows nothing about vaults outside its configuration.

Do not present any of these figures as financial advice.
