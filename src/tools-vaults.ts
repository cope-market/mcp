import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {Config} from "./config.js";
import type {GraphClient} from "./graphql.js";
import {analyse, fetchDaily, sumFlows} from "./history.js";
import type {VaultSummary} from "./vaults.js";
import {formatUnits, readAllSources, trimDecimal} from "./vaults.js";

const READ_ONLY = {readOnlyHint: true, destructiveHint: false, openWorldHint: true} as const;

function text(body: string) {
  return {content: [{type: "text" as const, text: body}]};
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/// A drawdown is always a fall, so it carries no sign. Rendering it through `pct` printed
/// "+25.00%", which reads as a gain of a quarter rather than a loss of one.
function drawdown(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

interface Located {
  vault: VaultSummary;
  url: string;
}

/// Resolves an address, or a symbol, or a name, against every configured source.
///
/// A model will have whatever the user said, which is usually a symbol and occasionally a
/// half-remembered name. Refusing anything but a checksummed address would push that matching onto
/// the model, which is where it gets guessed rather than looked up.
async function locate(
  client: GraphClient,
  config: Config,
  needle: string,
): Promise<{found: Located[]; errors: string[]}> {
  const results = await readAllSources(client, config);
  const errors = results
    .filter((result) => result.error !== null)
    .map((result) => `${result.source.key}: ${result.error}`);

  const wanted = needle.trim().toLowerCase();
  const found: Located[] = [];
  for (const result of results) {
    for (const vault of result.vaults) {
      const matches =
        vault.address.toLowerCase() === wanted ||
        vault.symbol.toLowerCase() === wanted ||
        vault.name.toLowerCase() === wanted ||
        vault.name.toLowerCase().includes(wanted);
      if (matches) found.push({vault, url: result.source.url});
    }
  }
  return {found, errors};
}

function describeAmbiguity(found: Located[]): string {
  return [
    `That matches ${found.length} vaults. Use the address to pick one:`,
    ...found.map((hit) => `- ${hit.vault.name} (${hit.vault.symbol}) ${hit.vault.address}`),
  ].join("\n");
}

export function registerVaultTools(server: McpServer, config: Config, client: GraphClient): void {
  server.registerTool(
    "vault_overview",
    {
      title: "Describe one ERC-4626 vault",
      description:
        "Current size, share price, holders and the flows over a window for a single vault. " +
        "Accepts an address, a symbol such as mwUSDC, or a name. Returns deposits and " +
        "withdrawals over the window and the net of the two, which is the figure that says " +
        "whether a vault is growing.",
      inputSchema: {
        vault: z.string().describe("Vault address, symbol or name"),
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(30)
          .describe("Window for the flow figures, in days"),
      },
      annotations: READ_ONLY,
    },
    async ({vault, days}) => {
      const {found, errors} = await locate(client, config, vault);
      if (found.length === 0) {
        return text(
          `No vault matches "${vault}". Call list_vaults to see what this server can read.` +
            (errors.length > 0 ? `\n\nSome sources were unavailable:\n${errors.join("\n")}` : ""),
        );
      }
      if (found.length > 1) return text(describeAmbiguity(found));

      const hit = found[0]!;
      const points = await fetchDaily(client, hit.url, hit.vault.address, days);
      const flows = sumFlows(points);
      const decimals = hit.vault.assetDecimals;
      const symbol = hit.vault.assetSymbol;

      return text(
        [
          `# ${hit.vault.name} (${hit.vault.symbol})`,
          `${hit.vault.address} on ${hit.vault.network}, via source "${hit.vault.source}"`,
          "",
          `- total assets: ${formatUnits(hit.vault.totalAssets, decimals)} ${symbol}`,
          `- share price: ${trimDecimal(hit.vault.sharePrice)} ${symbol} per share`,
          `- holders: ${hit.vault.holders}`,
          `- lifetime deposits: ${hit.vault.depositCount}, withdrawals: ${hit.vault.withdrawCount}`,
          "",
          `## Flows over the last ${days} days`,
          `- deposited: ${formatUnits(flows.deposited, decimals)} ${symbol}`,
          `- withdrawn: ${formatUnits(flows.withdrawn, decimals)} ${symbol}`,
          `- net: ${formatUnits(flows.net, decimals)} ${symbol}`,
          `- days with activity: ${points.length}`,
          "",
          `Figures are as of block ${hit.vault.asOfBlock} ` +
            `(${new Date(hit.vault.asOfTimestamp * 1000).toISOString()}), not the chain head.`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "vault_history",
    {
      title: "Share price history and performance for one vault",
      description:
        "Return over a period, annualised rate, maximum drawdown and the daily share price " +
        "series. None of these are stored: they are computed by walking the snapshots. Use this " +
        "to answer whether a vault has made money and how bumpy the ride was.",
      inputSchema: {
        vault: z.string().describe("Vault address, symbol or name"),
        days: z.number().int().min(1).max(3650).default(30).describe("Period, in days"),
        includeSeries: z
          .boolean()
          .default(false)
          .describe("Include the day-by-day share price series as well as the summary"),
      },
      annotations: READ_ONLY,
    },
    async ({vault, days, includeSeries}) => {
      const {found} = await locate(client, config, vault);
      if (found.length === 0) return text(`No vault matches "${vault}". Try list_vaults.`);
      if (found.length > 1) return text(describeAmbiguity(found));

      const hit = found[0]!;
      const points = await fetchDaily(client, hit.url, hit.vault.address, days);
      const performance = analyse(points);

      const lines = [
        `# ${hit.vault.name} (${hit.vault.symbol}) over ${days} days`,
        `${hit.vault.address} on ${hit.vault.network}`,
        "",
      ];

      if (performance.snapshots === 0) {
        lines.push(
          "No snapshots in this period. A subgraph writes one only for a day that had activity, " +
            "so this is either a young vault or a quiet one — not a vault worth nothing.",
        );
        return text(lines.join("\n"));
      }

      lines.push(
        `- return: ${pct(performance.returnPct)}`,
        `- annualised: ${pct(performance.annualisedPct)}`,
        `- maximum drawdown: ${drawdown(performance.maxDrawdownPct)}`,
        `- share price: ${trimDecimal(performance.firstPrice ?? "0")} -> ` +
          `${trimDecimal(performance.lastPrice ?? "0")}`,
        `- ${performance.snapshots} snapshots spanning ${performance.daysCovered} days`,
      );

      if (performance.returnPct === null) {
        lines.push(
          "",
          "Only one day has activity, so there is nothing to compare against and no return to " +
            "report. That is unknown, not zero.",
        );
      }

      if (includeSeries) {
        lines.push("", "## Daily share price", "| date | share price | assets |", "|---|---|---|");
        for (const point of points) {
          lines.push(
            `| ${new Date(point.timestamp * 1000).toISOString().slice(0, 10)} ` +
              `| ${trimDecimal(point.sharePrice)} ` +
              `| ${formatUnits(point.totalAssets, hit.vault.assetDecimals)} |`,
          );
        }
      }

      lines.push(
        "",
        "Days with no deposit, withdrawal or transfer produce no snapshot, so gaps in this " +
          "series are quiet days rather than missing data.",
      );

      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "compare_vaults",
    {
      title: "Rank every visible ERC-4626 vault by return",
      description:
        "Compares every vault across every configured subgraph over one period and ranks them " +
        "by return, with drawdown and size alongside. Works across chains and across protocols " +
        "because all of them are indexed by the same standardized ERC-4626 schema — no " +
        "per-protocol code is involved. Use this to answer which vault has done best.",
      inputSchema: {
        days: z.number().int().min(1).max(3650).default(30).describe("Period, in days"),
      },
      annotations: READ_ONLY,
    },
    async ({days}) => {
      const results = await readAllSources(client, config);

      const rows: {
        vault: VaultSummary;
        returnPct: number | null;
        drawdownPct: number | null;
        snapshots: number;
      }[] = [];

      for (const result of results) {
        if (result.error !== null) continue;
        for (const vault of result.vaults) {
          const points = await fetchDaily(client, result.source.url, vault.address, days);
          const performance = analyse(points);
          rows.push({
            vault,
            returnPct: performance.returnPct,
            drawdownPct: performance.maxDrawdownPct,
            snapshots: performance.snapshots,
          });
        }
      }

      // A vault with no measurable return sorts last rather than as zero. Unknown and flat are
      // different, and putting an unmeasurable vault in the middle of a ranking implies a result
      // it does not have.
      rows.sort((a, b) => {
        if (a.returnPct === null && b.returnPct === null) return 0;
        if (a.returnPct === null) return 1;
        if (b.returnPct === null) return -1;
        return b.returnPct - a.returnPct;
      });

      const lines = [
        `# ERC-4626 vaults ranked by return over ${days} days`,
        "",
        "| # | vault | network | return | drawdown | size | days |",
        "|---|---|---|---|---|---|---|",
      ];

      rows.forEach((row, index) => {
        lines.push(
          `| ${index + 1} | ${row.vault.name} (${row.vault.symbol}) | ${row.vault.network} ` +
            `| ${pct(row.returnPct)} | ${drawdown(row.drawdownPct)} ` +
            `| ${formatUnits(row.vault.totalAssets, row.vault.assetDecimals)} ` +
            `${row.vault.assetSymbol} | ${row.snapshots} |`,
        );
      });

      if (rows.length === 0) lines.push("| — | no vaults could be read | | | | | |");

      for (const result of results) {
        if (result.error !== null) {
          lines.push("", `Source "${result.source.key}" was unavailable: ${result.error}`);
        }
      }

      lines.push(
        "",
        "Returns are measured on share price, so they are net of whatever the vault charges and " +
          "are not affected by deposits or withdrawals. Vaults with too little history to compare " +
          "two days show n/a and rank last; that is unknown, not zero.",
        "",
        "Every vault above is read through one standardized ERC-4626 schema. Nothing in this " +
          "comparison knows which protocol built which vault.",
      );

      return text(lines.join("\n"));
    },
  );
}
