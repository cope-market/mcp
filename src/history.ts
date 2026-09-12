import type {GraphClient} from "./graphql.js";

/// Share-price history and what can be derived from it.
///
/// Everything here is arithmetic the subgraph does not store: a return is two snapshots compared, a
/// drawdown is the whole series walked. Those are the numbers someone actually asks for, and no
/// single query answers either.

export interface DailyPoint {
  day: number;
  timestamp: number;
  sharePrice: string;
  totalAssets: string;
  depositedAssets: string;
  withdrawnAssets: string;
  deposits: number;
  withdrawals: number;
}

const DAILY_QUERY = `
  query Daily($vault: String!, $sinceDay: Int!, $first: Int!) {
    vaultDailySnapshots(
      where: {vault: $vault, day_gte: $sinceDay}
      orderBy: day
      orderDirection: asc
      first: $first
    ) {
      day
      timestamp
      sharePrice
      totalAssets
      dailyDepositedAssets
      dailyWithdrawnAssets
      dailyDepositCount
      dailyWithdrawCount
    }
  }
`;

interface DailyResponse {
  vaultDailySnapshots: {
    day: number;
    timestamp: string;
    sharePrice: string;
    totalAssets: string;
    dailyDepositedAssets: string;
    dailyWithdrawnAssets: string;
    dailyDepositCount: number;
    dailyWithdrawCount: number;
  }[];
}

/// Kept separate from the tool so the arithmetic below can be tested on fixtures with no network
/// anywhere near it.
export async function fetchDaily(
  client: GraphClient,
  url: string,
  vault: string,
  days: number,
  today = Math.floor(Date.now() / 86_400_000),
): Promise<DailyPoint[]> {
  const data = await client.query<DailyResponse>(url, DAILY_QUERY, {
    vault: vault.toLowerCase(),
    sinceDay: days <= 0 ? 0 : today - days,
    first: 1000,
  });

  return data.vaultDailySnapshots.map((snapshot) => ({
    day: snapshot.day,
    timestamp: Number(snapshot.timestamp),
    sharePrice: snapshot.sharePrice,
    totalAssets: snapshot.totalAssets,
    depositedAssets: snapshot.dailyDepositedAssets,
    withdrawnAssets: snapshot.dailyWithdrawnAssets,
    deposits: snapshot.dailyDepositCount,
    withdrawals: snapshot.dailyWithdrawCount,
  }));
}

export interface Performance {
  /// Null when there is not enough history to compare two points. A vault with one snapshot has no
  /// return, and reporting zero would read as "flat" rather than as "unknown".
  returnPct: number | null;
  annualisedPct: number | null;
  maxDrawdownPct: number | null;
  firstPrice: string | null;
  lastPrice: string | null;
  /// Days actually covered by the data, which is not what was asked for. A subgraph writes a
  /// snapshot only for a day that had activity, so a quiet vault has gaps and a young one has no
  /// history at all.
  daysCovered: number;
  snapshots: number;
}

/// Share prices are ratios of two same-scale quantities and sit near one, so the arithmetic below
/// runs in double precision. Balances do not: those stay strings and are formatted digit by digit,
/// because an eighteen-decimal balance is past what a double holds exactly.
function toNumber(price: string): number {
  return Number(price);
}

export function analyse(points: DailyPoint[]): Performance {
  if (points.length === 0) {
    return {
      returnPct: null,
      annualisedPct: null,
      maxDrawdownPct: null,
      firstPrice: null,
      lastPrice: null,
      daysCovered: 0,
      snapshots: 0,
    };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const daysCovered = last.day - first.day;

  let peak = toNumber(first.sharePrice);
  let maxDrawdown = 0;
  for (const point of points) {
    const price = toNumber(point.sharePrice);
    if (price > peak) peak = price;
    // Guarding the divide rather than trusting the data. A vault that has taken every asset out
    // can price at zero, and an Infinity here would propagate into every figure downstream.
    if (peak > 0) {
      const drawdown = (peak - price) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }

  if (points.length < 2) {
    return {
      returnPct: null,
      annualisedPct: null,
      maxDrawdownPct: maxDrawdown * 100,
      firstPrice: first.sharePrice,
      lastPrice: last.sharePrice,
      daysCovered,
      snapshots: points.length,
    };
  }

  const start = toNumber(first.sharePrice);
  const end = toNumber(last.sharePrice);
  const returnPct = start > 0 ? ((end - start) / start) * 100 : null;

  // Annualising a window shorter than a day would multiply a rounding difference by several
  // hundred and present the result as a yield. Below a day there is no rate to annualise.
  const annualisedPct =
    returnPct !== null && daysCovered >= 1 && start > 0
      ? ((end / start) ** (365 / daysCovered) - 1) * 100
      : null;

  return {
    returnPct,
    annualisedPct,
    maxDrawdownPct: maxDrawdown * 100,
    firstPrice: first.sharePrice,
    lastPrice: last.sharePrice,
    daysCovered,
    snapshots: points.length,
  };
}

export function sumFlows(points: DailyPoint[]): {
  deposited: string;
  withdrawn: string;
  net: string;
} {
  let deposited = 0n;
  let withdrawn = 0n;
  for (const point of points) {
    deposited += BigInt(point.depositedAssets);
    withdrawn += BigInt(point.withdrawnAssets);
  }
  return {
    deposited: deposited.toString(),
    withdrawn: withdrawn.toString(),
    net: (deposited - withdrawn).toString(),
  };
}
