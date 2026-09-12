import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {Config} from "./config.js";
import type {GraphClient} from "./graphql.js";
import {
  USDC_DECIMALS,
  WAD_DECIMALS,
  fetchClosedPositions,
  fetchPosition,
  fetchTrader,
  outcomesForCopiersOf,
  recordsByAuthor,
  winRate,
} from "./traders.js";
import {formatUnits, isZero, trimDecimal} from "./vaults.js";

const READ_ONLY = {readOnlyHint: true, destructiveHint: false, openWorldHint: true} as const;

function text(body: string) {
  return {content: [{type: "text" as const, text: body}]};
}

/// P&L is WAD. Formatted at 18 decimals and then trimmed, so it reads as dollars rather than as a
/// twenty-digit integer, without ever passing through a float.
///
/// Two cents of precision is right for a result and wrong for a testnet one. A loss of
/// 0.0014955 USD rounded to two places is "0.00", and printing that as a loss reads as a rounding
/// artefact rather than a real if tiny one — so anything that would vanish is shown finer instead.
function usd(wad: string): string {
  const exact = formatUnits(wad, WAD_DECIMALS);
  if (isZero(exact)) return "0.00 USD";

  let shown = trimDecimal(exact, 2);
  if (isZero(shown)) shown = trimDecimal(exact, 8);
  else shown = withCents(shown);

  return `${shown.startsWith("-") ? "" : "+"}${shown} USD`;
}

/// `trimDecimal` strips trailing zeros, which is right for a share price and wrong for money: it
/// turned nine dollars into "+9 USD" while eight dollars fifty stayed "+8.50 USD", so a column of
/// results did not line up and did not read as currency.
function withCents(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return fraction.length >= 2 ? value : `${whole}.${fraction.padEnd(2, "0")}`;
}

function rate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

/// "all" reads wrong inside a sentence — "closed within all" — so it gets its own phrasing.
function describeWindow(window: string): string {
  return window === "all" ? "ever" : `the last ${window}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

const WINDOWS: Record<string, number> = {
  "7d": 7 * 86_400,
  "30d": 30 * 86_400,
  "90d": 90 * 86_400,
  all: 0,
};

export function registerTraderTools(server: McpServer, config: Config, client: GraphClient): void {
  const cope = config.copeSubgraph;
  // Registered only when there is a copy graph to read. Someone who pointed this at their own
  // ERC-4626 vault has no Cope Market deployment, and advertising tools that cannot work would
  // send a model down a path that ends in an error every time.
  if (cope === null) return;

  server.registerTool(
    "top_traders",
    {
      title: "Rank traders by realised profit",
      description:
        "Ranks traders by realised P&L over a window, with win rate and how many of their " +
        "positions were liquidated. Aggregated from individual closed positions, which is the " +
        "only way to get a windowed figure: the subgraph stores lifetime totals. Credit goes to " +
        "whoever opened a position, not whoever held it at the end.",
      inputSchema: {
        window: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
        limit: z.number().int().min(1).max(100).default(10),
      },
      annotations: READ_ONLY,
    },
    async ({window, limit}) => {
      const seconds = WINDOWS[window] ?? 0;
      const since = seconds === 0 ? 0 : Math.floor(Date.now() / 1000) - seconds;
      const positions = await fetchClosedPositions(client, cope.url, since);
      const records = [...recordsByAuthor(positions).values()];

      if (records.length === 0) {
        return text(
          `No positions were closed ${describeWindow(window)}, so there is nothing to rank. That ` +
            `is an empty window, not a set of traders who all broke even.`,
        );
      }

      // Compared as BigInt. A four-figure result in WAD is past 2^53, so sorting these as numbers
      // would order the top of the board by rounding error.
      records.sort((a, b) => {
        const left = BigInt(a.realizedPnlWad);
        const right = BigInt(b.realizedPnlWad);
        if (left === right) return b.closed - a.closed;
        return right > left ? 1 : -1;
      });

      const lines = [
        `# Traders by realised P&L, ${describeWindow(window)}`,
        "",
        "| # | trader | realised P&L | closed | win rate | liquidated |",
        "|---|---|---|---|---|---|",
      ];

      records.slice(0, limit).forEach((record, index) => {
        lines.push(
          `| ${index + 1} | ${record.address} | ${usd(record.realizedPnlWad)} | ${record.closed} ` +
            `| ${rate(winRate(record.wins, record.losses))} | ${record.liquidated} |`,
        );
      });

      lines.push(
        "",
        `${records.length} ${plural(records.length, "trader", "traders")} closed at least one ` +
          `position in this window. A flat close counts as a loss, so wins and losses always sum ` +
          `to the closed count.`,
        "",
        "Open positions are excluded. Their P&L is a mark that moves with the oracle, not a " +
          "result, and mixing the two would rank an unrealised swing alongside a banked one.",
      );

      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "trader_record",
    {
      title: "One trader's record, including how their copiers did",
      description:
        "A trader's lifetime results and, separately, what happened to everyone who copied them. " +
        "The second figure is the one that matters for deciding whether to follow somebody: a " +
        "trader can be profitable while the people copying them are not.",
      inputSchema: {
        address: z.string().describe("The trader's wallet address"),
        window: z
          .enum(["7d", "30d", "90d", "all"])
          .default("all")
          .describe("Window used for the copier outcomes"),
      },
      annotations: READ_ONLY,
    },
    async ({address, window}) => {
      const wanted = address.trim().toLowerCase();
      const totals = await fetchTrader(client, cope.url, wanted);

      if (totals === null) {
        return text(
          `${address} has never opened, held or authored a position on Cope Market. That is an ` +
            `address with no history here, not a trader with a record of zero.`,
        );
      }

      const seconds = WINDOWS[window] ?? 0;
      const since = seconds === 0 ? 0 : Math.floor(Date.now() / 1000) - seconds;
      const positions = await fetchClosedPositions(client, cope.url, since);
      const copiers = outcomesForCopiersOf(positions).get(wanted) ?? null;

      const lines = [
        `# ${totals.id}`,
        "",
        "## Their own trading",
        `- realised P&L: ${usd(totals.realizedPnlWad)}`,
        `- positions: ${totals.positionsOpened} opened, ${totals.positionsClosed} closed, ` +
          `${totals.positionsOpened - totals.positionsClosed} still open`,
        `- win rate: ${rate(winRate(totals.wins, totals.losses))} ` +
          `(${totals.wins} won, ${totals.losses} lost)`,
        `- liquidated: ${totals.positionsLiquidated}`,
        "",
        "## As someone worth copying",
        `- copied ${totals.copiesReceived} times`,
        `- author fees earned: ${formatUnits(totals.authorFeesEarned, USDC_DECIMALS)} USDC`,
        `- positions they themselves copied from others: ${totals.copiesMade}`,
      ];

      if (copiers === null) {
        lines.push(
          "",
          `No copy of this trader's positions has closed ${describeWindow(window)}, so there is ` +
            `no evidence either way about whether copying them pays.`,
        );
      } else {
        lines.push(
          "",
          `## How their copiers did (${describeWindow(window)})`,
          `- copies closed: ${copiers.copies}`,
          `- profitable for the copier: ${copiers.profitable}`,
          `- total copier P&L: ${usd(copiers.totalPnlWad)}`,
        );
        if (BigInt(copiers.totalPnlWad) <= 0n && BigInt(totals.realizedPnlWad) > 0n) {
          lines.push(
            "",
            "Note: this trader is in profit while the people copying them are not. A copy opens " +
              "at its own entry price, so a copier enters later and on worse terms than the " +
              "position they followed.",
          );
        }
      }

      if (totals.liquidationsPerformed > 0) {
        lines.push(
          "",
          `Separately, this address liquidated ${totals.liquidationsPerformed} of other people's ` +
            `positions and earned ${formatUnits(totals.liquidationRewardsEarned, USDC_DECIMALS)} ` +
            `USDC in rewards. That is not trading P&L: no position was taken and no risk carried.`,
        );
      }

      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "copy_lineage",
    {
      title: "Trace a position's copy tree and whether copying it paid",
      description:
        "For one position, shows what it did, what every copy of it did, and the total outcome " +
        "for the copiers. Answers whether following this specific call made anyone money, which " +
        "is a different question from whether the call itself was right.",
      inputSchema: {
        tokenId: z.string().describe("The position's ERC-721 token id, as a decimal number"),
      },
      annotations: READ_ONLY,
    },
    async ({tokenId}) => {
      const position = await fetchPosition(client, cope.url, tokenId.trim());
      if (position === null) {
        return text(`No position with token id ${tokenId} has been indexed.`);
      }

      const lines = [
        `# Position ${position.tokenId}`,
        "",
        `- ${position.isLong ? "long" : "short"} on feed ${position.feedId}`,
        `- author: ${position.author}`,
        `- current holder: ${position.owner}` +
          (position.owner === position.author ? "" : " (sold; credit stays with the author)"),
        `- collateral: ${formatUnits(position.collateral, USDC_DECIMALS)} USDC, net of the open fee`,
        `- entry price: ${trimDecimal(formatUnits(position.entryPrice, WAD_DECIMALS), 4)}`,
        `- status: ${position.status}`,
      ];

      if (position.status !== "OPEN") {
        lines.push(
          `- exit price: ${trimDecimal(formatUnits(position.exitPrice ?? "0", WAD_DECIMALS), 4)}`,
          `- realised: ${usd(position.realizedPnlWad ?? "0")}`,
          `- payout: ${formatUnits(position.payout ?? "0", USDC_DECIMALS)} USDC`,
        );
        if (position.authorFeePaid !== null) {
          lines.push(
            `- author fee paid: ${formatUnits(position.authorFeePaid, USDC_DECIMALS)} USDC`,
          );
        }
      } else {
        lines.push(
          "- realised: n/a while open. An open position's P&L is a mark that moves with the " +
            "oracle, not a result.",
        );
      }

      if (position.copiedFromTokenId !== null) {
        lines.push("", `This position is itself a copy of position ${position.copiedFromTokenId}.`);
      }

      if (position.copies.length === 0) {
        lines.push("", "Nobody has copied this position.");
        return text(lines.join("\n"));
      }

      let total = 0n;
      let closed = 0;
      let profitable = 0;

      lines.push(
        "",
        `## ${position.copies.length} copies`,
        "| token | copier | status | realised |",
        "|---|---|---|---|",
      );

      for (const copy of position.copies) {
        const settled = copy.status !== "OPEN";
        if (settled) {
          const pnl = BigInt(copy.realizedPnlWad ?? "0");
          total += pnl;
          closed += 1;
          if (pnl > 0n) profitable += 1;
        }
        lines.push(
          `| ${copy.tokenId} | ${copy.author} | ${copy.status} ` +
            `| ${settled ? usd(copy.realizedPnlWad ?? "0") : "still open"} |`,
        );
      }

      lines.push("");
      if (closed === 0) {
        lines.push(
          "Every copy is still open, so there is no outcome yet. Nothing here says whether " +
            "copying this position paid.",
        );
      } else {
        lines.push(
          `Across the ${closed} copies that have closed, copiers realised ${usd(total.toString())} ` +
            `in total and ${profitable} of them finished in profit.`,
          "",
          "A copy opens at its own entry price rather than the original's, so copiers and the " +
            "author can finish on opposite sides of the same call.",
        );
      }

      return text(lines.join("\n"));
    },
  );
}
