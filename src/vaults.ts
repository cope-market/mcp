import type {Config, VaultSubgraph} from "./config.js";
import type {GraphClient} from "./graphql.js";
import {SubgraphError} from "./graphql.js";

/// Reads against the standardized ERC-4626 schema.
///
/// Every query here uses only fields that schema defines, which is what lets one code path serve
/// Cope Market's vault and two MetaMorpho vaults on another chain without knowing anything about
/// either protocol.

export interface VaultSummary {
  source: string;
  network: string;
  address: string;
  name: string;
  symbol: string;
  assetSymbol: string;
  assetDecimals: number;
  shareDecimals: number;
  /// Raw integer in asset units. Formatted separately, because the decimals differ per vault and
  /// losing them is the mistake this whole schema was written to avoid.
  totalAssets: string;
  totalShares: string;
  sharePrice: string;
  depositCount: number;
  withdrawCount: number;
  holders: number;
  /// The block the figures above describe, which is not the chain head. A vault accrues without
  /// emitting, so a caller that reports these as current is reporting a stale number as live.
  asOfBlock: number;
  asOfTimestamp: number;
}

const VAULTS_QUERY = `
  {
    _meta { block { number } hasIndexingErrors }
    vaults(first: 100) {
      id
      name
      symbol
      decimals
      totalAssets
      totalShares
      sharePrice
      depositCount
      withdrawCount
      openPositionCount
      lastUpdatedBlock
      lastUpdatedTimestamp
      asset { symbol decimals }
    }
  }
`;

interface VaultsResponse {
  _meta: {block: {number: number}; hasIndexingErrors: boolean};
  vaults: {
    id: string;
    name: string;
    symbol: string;
    decimals: number;
    totalAssets: string;
    totalShares: string;
    sharePrice: string;
    depositCount: number;
    withdrawCount: number;
    openPositionCount: number;
    lastUpdatedBlock: string;
    lastUpdatedTimestamp: string;
    asset: {symbol: string; decimals: number};
  }[];
}

export interface SourceResult {
  source: VaultSubgraph;
  vaults: VaultSummary[];
  indexedToBlock: number;
  hasIndexingErrors: boolean;
  /// Set when this source could not be read. One unreachable subgraph must not blank the others:
  /// a comparison across four vaults is still worth having when three answered, so long as the
  /// fourth says so rather than silently vanishing.
  error: string | null;
}

export async function readSource(
  client: GraphClient,
  source: VaultSubgraph,
): Promise<SourceResult> {
  try {
    const data = await client.query<VaultsResponse>(source.url, VAULTS_QUERY);
    return {
      source,
      indexedToBlock: data._meta.block.number,
      hasIndexingErrors: data._meta.hasIndexingErrors,
      error: null,
      vaults: data.vaults.map((vault) => ({
        source: source.key,
        network: source.network,
        address: vault.id,
        name: vault.name,
        symbol: vault.symbol,
        assetSymbol: vault.asset.symbol,
        assetDecimals: vault.asset.decimals,
        shareDecimals: vault.decimals,
        totalAssets: vault.totalAssets,
        totalShares: vault.totalShares,
        sharePrice: vault.sharePrice,
        depositCount: vault.depositCount,
        withdrawCount: vault.withdrawCount,
        holders: vault.openPositionCount,
        asOfBlock: Number(vault.lastUpdatedBlock),
        asOfTimestamp: Number(vault.lastUpdatedTimestamp),
      })),
    };
  } catch (error) {
    if (!(error instanceof SubgraphError)) throw error;
    return {
      source,
      vaults: [],
      indexedToBlock: 0,
      hasIndexingErrors: false,
      error: error.message,
    };
  }
}

export async function readAllSources(client: GraphClient, config: Config): Promise<SourceResult[]> {
  return Promise.all(config.vaultSubgraphs.map((source) => readSource(client, source)));
}

/// Formats a raw integer amount at a given number of decimals.
///
/// Done as string arithmetic rather than through a float. A vault with eighteen decimals and any
/// real balance is past what a double represents exactly, and a tool whose job is to report
/// balances should not be the thing that rounds them.
export function formatUnits(amount: string, decimals: number): string {
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/// Rounds a decimal string to `places`, half-up, without going through a float.
///
/// The subgraph stores BigDecimal at 34 significant digits, so a share price arrives as
/// 1.032384712707604812799746690089656. Handing that to a model invites it to quote the whole
/// thing, which reads as false precision on a figure whose last twenty digits are noise.
export function trimDecimal(value: string, places = 6): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = body.split(".");
  if (fraction.length <= places) return value;

  const keep = fraction.slice(0, places);
  const roundUp = Number(fraction[places]) >= 5;

  let digits = BigInt(whole + keep);
  if (roundUp) digits += 1n;

  const padded = digits.toString().padStart(places + 1, "0");
  const newWhole = padded.slice(0, padded.length - places);
  const newFraction = places === 0 ? "" : padded.slice(padded.length - places).replace(/0+$/, "");
  // A small negative rounded to nothing must not come back as "-0". That reads as a signed zero,
  // which is not a quantity anyone means.
  const sign = negative && digits !== 0n ? "-" : "";
  return newFraction === "" ? `${sign}${newWhole}` : `${sign}${newWhole}.${newFraction}`;
}

/// True for any spelling of zero: "0", "-0", "0.00", "-0.000".
export function isZero(value: string): boolean {
  return /^-?0(\.0*)?$/.test(value);
}
