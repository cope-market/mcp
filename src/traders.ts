import type {GraphClient} from "./graphql.js";

/// The Cope Market copy graph: who traded, how it went, and whether copying them paid.
///
/// Realised P&L is WAD — 1e18, signed. Collateral, payouts and author fees are USDC at 6 decimals.
/// Both appear in the same answers, so nothing here adds one to the other.

export const WAD_DECIMALS = 18;
export const USDC_DECIMALS = 6;

export interface ClosedPosition {
  id: string;
  tokenId: string;
  author: string;
  realizedPnlWad: string;
  closedAt: number;
  status: string;
  copiedFromTokenId: string | null;
  copiedFromAuthor: string | null;
}

const CLOSED_QUERY = `
  query Closed($since: BigInt!, $after: ID!, $first: Int!) {
    positions(
      where: {status_not: OPEN, closedAt_gte: $since, id_gt: $after}
      orderBy: id
      orderDirection: asc
      first: $first
    ) {
      id
      tokenId
      status
      closedAt
      realizedPnlWad
      author { id }
      copiedFrom { tokenId author { id } }
    }
  }
`;

interface ClosedResponse {
  positions: {
    id: string;
    tokenId: string;
    status: string;
    closedAt: string | null;
    realizedPnlWad: string | null;
    author: {id: string};
    copiedFrom: {tokenId: string; author: {id: string}} | null;
  }[];
}

const PAGE_SIZE = 1000;
/// A stop rather than a limit anyone should reach. Without it, a cursor bug becomes an endless
/// loop against a live indexer instead of a wrong answer.
const MAX_PAGES = 50;

export async function fetchClosedPositions(
  client: GraphClient,
  url: string,
  sinceUnixSeconds: number,
): Promise<ClosedPosition[]> {
  const all: ClosedPosition[] = [];
  // Cursor on id, not skip: graph-node caps skip at 5000, and a ranking that silently stopped
  // counting past that point would look right and rank wrong.
  let after = "0x";

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await client.query<ClosedResponse>(url, CLOSED_QUERY, {
      since: String(sinceUnixSeconds),
      after,
      first: PAGE_SIZE,
    });

    for (const position of data.positions) {
      all.push({
        id: position.id,
        tokenId: position.tokenId,
        author: position.author.id.toLowerCase(),
        // A closed position always carries a P&L. Reading a malformed row as zero keeps it out of
        // the win column rather than letting it invent a ranking.
        realizedPnlWad: position.realizedPnlWad ?? "0",
        closedAt: Number(position.closedAt ?? "0"),
        status: position.status,
        copiedFromTokenId: position.copiedFrom?.tokenId ?? null,
        copiedFromAuthor: position.copiedFrom?.author.id.toLowerCase() ?? null,
      });
    }

    if (data.positions.length < PAGE_SIZE) break;
    after = data.positions[data.positions.length - 1]!.id;
  }

  return all;
}

export interface TraderRecord {
  address: string;
  realizedPnlWad: string;
  closed: number;
  wins: number;
  losses: number;
  liquidated: number;
}

/// Groups closed positions by the author who opened them.
///
/// Credit follows the author, never the current holder. A position NFT is transferable, so ranking
/// the holder would let anyone buy a place on the board from whoever earned it.
export function recordsByAuthor(positions: ClosedPosition[]): Map<string, TraderRecord> {
  const records = new Map<string, TraderRecord>();

  for (const position of positions) {
    const record = records.get(position.author) ?? {
      address: position.author,
      realizedPnlWad: "0",
      closed: 0,
      wins: 0,
      losses: 0,
      liquidated: 0,
    };

    const pnl = BigInt(position.realizedPnlWad);
    record.realizedPnlWad = (BigInt(record.realizedPnlWad) + pnl).toString();
    record.closed += 1;
    // Strictly positive, so wins plus losses always equals closed and a flat close never flatters
    // a win rate. Rounding lands exactly on zero often enough for that to matter.
    if (pnl > 0n) record.wins += 1;
    else record.losses += 1;
    if (position.status === "LIQUIDATED") record.liquidated += 1;

    records.set(position.author, record);
  }

  return records;
}

export function winRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  // A trader who has closed nothing has no win rate. Null rather than zero, because zero is a
  // claim that they lost everything they finished.
  return decided === 0 ? null : wins / decided;
}

export interface CopyOutcome {
  copies: number;
  profitable: number;
  totalPnlWad: string;
}

/// What happened to everyone who copied a given author.
///
/// This is the question the copy graph exists to answer and the one no single query returns: it
/// needs positions grouped by the author of the position they copied, not by their own author.
export function outcomesForCopiersOf(positions: ClosedPosition[]): Map<string, CopyOutcome> {
  const outcomes = new Map<string, CopyOutcome>();

  for (const position of positions) {
    if (position.copiedFromAuthor === null) continue;

    const outcome = outcomes.get(position.copiedFromAuthor) ?? {
      copies: 0,
      profitable: 0,
      totalPnlWad: "0",
    };
    const pnl = BigInt(position.realizedPnlWad);
    outcome.copies += 1;
    if (pnl > 0n) outcome.profitable += 1;
    outcome.totalPnlWad = (BigInt(outcome.totalPnlWad) + pnl).toString();

    outcomes.set(position.copiedFromAuthor, outcome);
  }

  return outcomes;
}

export interface TraderTotals {
  id: string;
  positionsOpened: number;
  positionsClosed: number;
  positionsLiquidated: number;
  liquidationsPerformed: number;
  liquidationRewardsEarned: string;
  realizedPnlWad: string;
  wins: number;
  losses: number;
  copiesMade: number;
  copiesReceived: number;
  authorFeesEarned: string;
}

const TRADER_QUERY = `
  query Trader($id: ID!) {
    trader(id: $id) {
      id
      positionsOpened
      positionsClosed
      positionsLiquidated
      liquidationsPerformed
      liquidationRewardsEarned
      realizedPnlWad
      wins
      losses
      copiesMade
      copiesReceived
      authorFeesEarned
    }
  }
`;

export async function fetchTrader(
  client: GraphClient,
  url: string,
  address: string,
): Promise<TraderTotals | null> {
  const data = await client.query<{trader: TraderTotals | null}>(url, TRADER_QUERY, {
    id: address.toLowerCase(),
  });
  return data.trader;
}

export interface PositionDetail {
  tokenId: string;
  author: string;
  owner: string;
  feedId: string;
  isLong: boolean;
  collateral: string;
  entryPrice: string;
  exitPrice: string | null;
  status: string;
  realizedPnlWad: string | null;
  payout: string | null;
  authorFeePaid: string | null;
  copyCount: number;
  copiedFromTokenId: string | null;
  copies: {tokenId: string; author: string; status: string; realizedPnlWad: string | null}[];
}

const POSITION_QUERY = `
  query Position($tokenId: BigInt!) {
    positions(where: {tokenId: $tokenId}, first: 1) {
      tokenId
      isLong
      collateral
      entryPrice
      exitPrice
      status
      realizedPnlWad
      payout
      authorFeePaid
      copyCount
      author { id }
      owner { id }
      asset { id }
      copiedFrom { tokenId }
      copies(first: 1000) {
        tokenId
        status
        realizedPnlWad
        author { id }
      }
    }
  }
`;

interface PositionResponse {
  positions: {
    tokenId: string;
    isLong: boolean;
    collateral: string;
    entryPrice: string;
    exitPrice: string | null;
    status: string;
    realizedPnlWad: string | null;
    payout: string | null;
    authorFeePaid: string | null;
    copyCount: number;
    author: {id: string};
    owner: {id: string};
    asset: {id: string};
    copiedFrom: {tokenId: string} | null;
    copies: {
      tokenId: string;
      status: string;
      realizedPnlWad: string | null;
      author: {id: string};
    }[];
  }[];
}

export async function fetchPosition(
  client: GraphClient,
  url: string,
  tokenId: string,
): Promise<PositionDetail | null> {
  const data = await client.query<PositionResponse>(url, POSITION_QUERY, {tokenId});
  const position = data.positions[0];
  if (!position) return null;

  return {
    tokenId: position.tokenId,
    author: position.author.id.toLowerCase(),
    owner: position.owner.id.toLowerCase(),
    feedId: position.asset.id,
    isLong: position.isLong,
    collateral: position.collateral,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    status: position.status,
    realizedPnlWad: position.realizedPnlWad,
    payout: position.payout,
    authorFeePaid: position.authorFeePaid,
    copyCount: position.copyCount,
    copiedFromTokenId: position.copiedFrom?.tokenId ?? null,
    copies: position.copies.map((copy) => ({
      tokenId: copy.tokenId,
      author: copy.author.id.toLowerCase(),
      status: copy.status,
      realizedPnlWad: copy.realizedPnlWad,
    })),
  };
}
