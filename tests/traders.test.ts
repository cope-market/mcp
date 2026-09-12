import {describe, expect, it} from "vitest";
import type {ClosedPosition} from "../src/traders.js";
import {outcomesForCopiersOf, recordsByAuthor, winRate} from "../src/traders.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const WAD = 10n ** 18n;

function closed(
  tokenId: string,
  author: string,
  pnl: bigint,
  extra: Partial<ClosedPosition> = {},
): ClosedPosition {
  return {
    id: `0x${tokenId.padStart(64, "0")}`,
    tokenId,
    author,
    realizedPnlWad: pnl.toString(),
    closedAt: 1_757_660_400,
    status: "CLOSED",
    copiedFromTokenId: null,
    copiedFromAuthor: null,
    ...extra,
  };
}

describe("grouping by author", () => {
  it("sums P&L and counts wins and losses", () => {
    const records = recordsByAuthor([
      closed("1", ALICE, 3n * WAD),
      closed("2", ALICE, -1n * WAD),
      closed("3", BOB, 5n * WAD),
    ]);

    expect(records.get(ALICE)).toEqual({
      address: ALICE,
      realizedPnlWad: (2n * WAD).toString(),
      closed: 2,
      wins: 1,
      losses: 1,
      liquidated: 0,
    });
    expect(records.get(BOB)?.wins).toBe(1);
  });

  /// Rounding lands exactly on zero often enough that counting it as a win would inflate every win
  /// rate. Strictly positive also keeps wins plus losses equal to the closed count.
  it("counts a flat close as a loss", () => {
    const records = recordsByAuthor([closed("1", ALICE, 0n)]);
    expect(records.get(ALICE)).toMatchObject({wins: 0, losses: 1, closed: 1});
  });

  it("counts a liquidation separately but still as a close", () => {
    const records = recordsByAuthor([closed("1", ALICE, -2n * WAD, {status: "LIQUIDATED"})]);
    expect(records.get(ALICE)).toMatchObject({closed: 1, losses: 1, liquidated: 1});
  });

  /// These are 1e18 figures: a four-figure result is past 2^53. Summed as numbers, the low digits
  /// of every entry would be lost.
  it("sums beyond what a JavaScript number holds", () => {
    const huge = 9_007_199n * WAD;
    const records = recordsByAuthor([closed("1", ALICE, huge), closed("2", ALICE, huge)]);
    expect(records.get(ALICE)?.realizedPnlWad).toBe((huge * 2n).toString());
  });

  it("is empty for no positions", () => {
    expect(recordsByAuthor([]).size).toBe(0);
  });
});

describe("copier outcomes", () => {
  /// The question the copy graph exists to answer, and one no single query returns: it needs
  /// positions grouped by the author of the position they copied, not by their own author.
  it("groups by who was copied, not by who copied", () => {
    const outcomes = outcomesForCopiersOf([
      closed("2", BOB, 1n * WAD, {copiedFromTokenId: "1", copiedFromAuthor: ALICE}),
      closed("3", BOB, -3n * WAD, {copiedFromTokenId: "1", copiedFromAuthor: ALICE}),
    ]);

    expect(outcomes.get(ALICE)).toEqual({
      copies: 2,
      profitable: 1,
      totalPnlWad: (-2n * WAD).toString(),
    });
    // Bob copied; nobody copied Bob.
    expect(outcomes.has(BOB)).toBe(false);
  });

  it("ignores positions that are not copies", () => {
    expect(outcomesForCopiersOf([closed("1", ALICE, 1n * WAD)]).size).toBe(0);
  });

  /// The case the tool exists to surface: an author in profit whose followers are not. A copy
  /// opens at its own entry price, so it enters later and on worse terms.
  it("can report a loss for copiers of a winning author", () => {
    const outcomes = outcomesForCopiersOf([closed("2", BOB, -5n * WAD, {copiedFromAuthor: ALICE})]);
    expect(BigInt(outcomes.get(ALICE)!.totalPnlWad)).toBeLessThan(0n);
    expect(outcomes.get(ALICE)!.profitable).toBe(0);
  });
});

describe("win rate", () => {
  it("is the share of decided positions that won", () => {
    expect(winRate(3, 1)).toBe(0.75);
  });

  /// Null, not zero. Zero is a claim that they lost everything they finished.
  it("is unknown for a trader who has closed nothing", () => {
    expect(winRate(0, 0)).toBeNull();
  });

  it("is one when nothing was lost", () => {
    expect(winRate(4, 0)).toBe(1);
  });
});
