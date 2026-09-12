import {describe, expect, it} from "vitest";
import {TEST_CONFIG, callText, connect, fakeGraph} from "./helpers.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const WAD = 10n ** 18n;

function position(tokenId: string, author: string, pnl: bigint, copiedFromAuthor?: string) {
  return {
    id: `0x${tokenId.padStart(64, "0")}`,
    tokenId,
    status: "CLOSED",
    closedAt: "1757660400",
    realizedPnlWad: pnl.toString(),
    author: {id: author},
    copiedFrom: copiedFromAuthor ? {tokenId: "1", author: {id: copiedFromAuthor}} : null,
  };
}

function trader(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    positionsOpened: 5,
    positionsClosed: 2,
    positionsLiquidated: 0,
    liquidationsPerformed: 0,
    liquidationRewardsEarned: "0",
    realizedPnlWad: (2n * WAD).toString(),
    wins: 1,
    losses: 1,
    copiesMade: 0,
    copiesReceived: 3,
    authorFeesEarned: "100000",
    ...overrides,
  };
}

/// The Cope subgraph answers several different documents. The fake dispatches on which one
/// arrived rather than on call order, so a test never silently depends on the sequence of queries.
function cope(responses: {positions?: unknown[]; trader?: unknown; detail?: unknown[]}) {
  const calls: {document: string; variables: Record<string, unknown>}[] = [];
  return {
    calls,
    client: {
      async query<T>(
        _url: string,
        document: string,
        variables: Record<string, unknown> = {},
      ): Promise<T> {
        calls.push({document, variables});
        if (document.includes("query Trader")) return {trader: responses.trader ?? null} as T;
        if (document.includes("query Position")) {
          return {positions: responses.detail ?? []} as T;
        }
        if (document.includes("query Closed")) {
          return {positions: responses.positions ?? []} as T;
        }
        throw new Error(`unexpected document: ${document.slice(0, 40)}`);
      },
    },
  };
}

describe("tool availability", () => {
  /// Someone who points this at their own ERC-4626 vault has no Cope Market deployment. Offering
  /// tools that cannot work would send a model down a path that ends in an error every time.
  it("hides the trader tools when no copy graph is configured", async () => {
    const {client} = fakeGraph({});
    const mcp = await connect({...TEST_CONFIG, copeSubgraph: null}, client);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("list_vaults");
    expect(names).not.toContain("top_traders");
    expect(names).not.toContain("trader_record");
    expect(names).not.toContain("copy_lineage");
  });

  it("offers them when one is", async () => {
    const {client} = fakeGraph({});
    const names = (await (await connect(TEST_CONFIG, client)).listTools()).tools.map((t) => t.name);
    expect(names).toContain("top_traders");
  });
});

describe("top_traders", () => {
  it("ranks by realised P&L", async () => {
    const {client} = cope({
      positions: [
        position("1", ALICE, 1n * WAD),
        position("2", BOB, 9n * WAD),
        position("3", ALICE, -3n * WAD),
      ],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "top_traders", {window: "all"});

    expect(output.indexOf(BOB)).toBeLessThan(output.indexOf(ALICE));
    expect(output).toContain("+9.00 USD");
    expect(output).toContain("-2.00 USD");
  });

  /// An empty window is not a set of traders who all broke even, and a table of zeros would say
  /// exactly that.
  it("says the window is empty rather than showing nothing", async () => {
    const {client} = cope({positions: []});
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "top_traders", {window: "7d"})).toContain("nothing to rank");
  });

  it("passes a cutoff for a window and none for all time", async () => {
    const withWindow = cope({positions: []});
    await callText(await connect(TEST_CONFIG, withWindow.client), "top_traders", {window: "7d"});
    expect(Number(withWindow.calls[0]!.variables.since)).toBeGreaterThan(
      Math.floor(Date.now() / 1000) - 8 * 86_400,
    );

    const allTime = cope({positions: []});
    await callText(await connect(TEST_CONFIG, allTime.client), "top_traders", {window: "all"});
    expect(allTime.calls[0]!.variables.since).toBe("0");
  });

  it("honours the limit", async () => {
    const {client} = cope({
      positions: [position("1", ALICE, 1n * WAD), position("2", BOB, 2n * WAD)],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "top_traders", {window: "all", limit: 1});

    expect(output).toContain(BOB);
    expect(output).not.toContain(ALICE);
  });

  /// A sub-cent result rounded to two places printed as "-0", which reads as a signed zero rather
  /// than as the small loss it is.
  it("shows a result too small for two decimal places rather than rounding it away", async () => {
    const {client} = cope({positions: [position("1", ALICE, -1_495_554_512_560_313n)]});
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "top_traders", {window: "all"});

    expect(output).toContain("-0.00149555 USD");
    expect(output).not.toContain("-0 USD");
  });
});

describe("trader_record", () => {
  it("reports their own trading and their copiers separately", async () => {
    const {client} = cope({
      trader: trader(ALICE),
      positions: [position("2", BOB, 4n * WAD, ALICE)],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "trader_record", {address: ALICE, window: "all"});

    expect(output).toContain("## Their own trading");
    expect(output).toContain("+2.00 USD");
    expect(output).toContain("## How their copiers did");
    expect(output).toContain("+4.00 USD");
  });

  /// The finding the tool exists for. A copy opens at its own entry price, so an author and their
  /// followers can finish on opposite sides of the same call.
  it("flags an author in profit whose copiers are not", async () => {
    const {client} = cope({
      trader: trader(ALICE, {realizedPnlWad: (10n * WAD).toString()}),
      positions: [position("2", BOB, -4n * WAD, ALICE)],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "trader_record", {address: ALICE, window: "all"});

    expect(output).toContain("in profit while the people copying them are not");
  });

  it("does not flag that when the copiers made money too", async () => {
    const {client} = cope({
      trader: trader(ALICE, {realizedPnlWad: (10n * WAD).toString()}),
      positions: [position("2", BOB, 4n * WAD, ALICE)],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "trader_record", {address: ALICE, window: "all"});

    expect(output).not.toContain("in profit while the people copying them are not");
  });

  /// No history is a different thing from a record of zero, and an agent asked "is this trader any
  /// good" must not be handed the second when the first is true.
  it("distinguishes an unknown address from a trader with nothing to show", async () => {
    const {client} = cope({trader: null});
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "trader_record", {address: ALICE});

    expect(output).toContain("never opened, held or authored");
    expect(output).toContain("not a trader with a record of zero");
  });

  it("says there is no evidence when nobody's copy has closed", async () => {
    const {client} = cope({trader: trader(ALICE), positions: []});
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "trader_record", {address: ALICE, window: "all"});

    expect(output).toContain("no evidence either way");
    // "closed within all" is not a sentence.
    expect(output).toContain("closed ever");
  });

  /// A liquidator's reward is income but it is not trading P&L: no position was taken and no risk
  /// carried. Folding it in would let someone farm a leaderboard place by running a keeper.
  it("keeps liquidation rewards out of trading P&L", async () => {
    const {client} = cope({
      trader: trader(ALICE, {liquidationsPerformed: 3, liquidationRewardsEarned: "500000"}),
      positions: [],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "trader_record", {address: ALICE});

    expect(output).toContain("liquidated 3 of other people's positions");
    expect(output).toContain("0.5 USDC");
    expect(output).toContain("not trading P&L");
  });

  it("matches a checksummed address against the lower-case index", async () => {
    const {client, calls} = cope({trader: trader(ALICE), positions: []});
    const mcp = await connect(TEST_CONFIG, client);
    await callText(mcp, "trader_record", {address: "0x1111111111111111111111111111111111111111"});

    expect(calls[0]!.variables.id).toBe(ALICE);
  });
});

describe("copy_lineage", () => {
  function detail(overrides: Record<string, unknown> = {}) {
    return {
      tokenId: "1",
      isLong: true,
      collateral: "1998000",
      entryPrice: (77_325n * WAD).toString(),
      exitPrice: (78_000n * WAD).toString(),
      status: "CLOSED",
      realizedPnlWad: (1n * WAD).toString(),
      payout: "2900000",
      authorFeePaid: null,
      copyCount: 0,
      author: {id: ALICE},
      owner: {id: ALICE},
      asset: {id: "0xfeed"},
      copiedFrom: null,
      copies: [],
      ...overrides,
    };
  }

  it("totals what the copiers realised", async () => {
    const {client} = cope({
      detail: [
        detail({
          copyCount: 2,
          copies: [
            {
              tokenId: "2",
              status: "CLOSED",
              realizedPnlWad: (3n * WAD).toString(),
              author: {id: BOB},
            },
            {
              tokenId: "3",
              status: "CLOSED",
              realizedPnlWad: (-1n * WAD).toString(),
              author: {id: BOB},
            },
          ],
        }),
      ],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "copy_lineage", {tokenId: "1"});

    expect(output).toContain("2 copies");
    expect(output).toContain("copiers realised +2.00 USD");
    expect(output).toContain("1 of them finished in profit");
  });

  /// An open copy has no outcome. Counting it as zero would report a break-even that has not
  /// happened.
  it("excludes copies that are still open and says so", async () => {
    const {client} = cope({
      detail: [
        detail({
          copies: [{tokenId: "2", status: "OPEN", realizedPnlWad: null, author: {id: BOB}}],
        }),
      ],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "copy_lineage", {tokenId: "1"});

    expect(output).toContain("still open");
    expect(output).toContain("no outcome yet");
  });

  it("says when nobody copied it", async () => {
    const {client} = cope({detail: [detail()]});
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "copy_lineage", {tokenId: "1"})).toContain("Nobody has copied");
  });

  /// Selling the NFT moves the payout, not the credit. An answer that showed only the holder would
  /// attribute the call to whoever bought it.
  it("shows the author and the holder separately when they differ", async () => {
    const {client} = cope({detail: [detail({owner: {id: BOB}})]});
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "copy_lineage", {tokenId: "1"});

    expect(output).toContain(`author: ${ALICE}`);
    expect(output).toContain("sold; credit stays with the author");
  });

  it("refuses to report a realised figure for an open position", async () => {
    const {client} = cope({
      detail: [detail({status: "OPEN", realizedPnlWad: null, exitPrice: null, payout: null})],
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "copy_lineage", {tokenId: "1"});

    expect(output).toContain("n/a while open");
  });

  it("says when the position is not indexed", async () => {
    const {client} = cope({detail: []});
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "copy_lineage", {tokenId: "999"})).toContain("No position with");
  });
});
