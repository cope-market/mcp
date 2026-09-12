import {describe, expect, it} from "vitest";
import {SubgraphError} from "../src/graphql.js";
import {TEST_CONFIG, callText, connect, fakeGraph, vaultsResponse} from "./helpers.js";

const COPE = "0x0ffabc4e80125c5742d5ed04cc1fd1b634bc3c5d";
const MORPHO = "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca";

function snapshot(day: number, sharePrice: string, extra: Record<string, unknown> = {}) {
  return {
    day,
    timestamp: String(day * 86_400),
    sharePrice,
    totalAssets: "30000000",
    dailyDepositedAssets: "0",
    dailyWithdrawnAssets: "0",
    dailyDepositCount: 0,
    dailyWithdrawCount: 0,
    ...extra,
  };
}

/// One source answers both the vault list and the snapshot query, so the fake dispatches on which
/// document arrived rather than on the URL alone.
function source(vaults: unknown, snapshots: unknown[]) {
  let served = 0;
  return () => {
    served += 1;
    // The vault list is asked for first by every tool here.
    return served === 1 ? vaults : {vaultDailySnapshots: snapshots};
  };
}

describe("vault_overview", () => {
  it("finds a vault by symbol rather than demanding an address", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{symbol: "COPE-LP"}]), []),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "vault_overview", {vault: "COPE-LP"})).toContain(
      "Cope Market Liquidity",
    );
  });

  it("finds a vault by address", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), []),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "vault_overview", {vault: COPE})).toContain("Cope Market Liquidity");
  });

  /// Picking one arbitrarily would answer confidently about the wrong vault.
  it("asks which one when a name matches several", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(
        vaultsResponse(100, [
          {id: COPE, name: "Moonwell Flagship USDC", symbol: "mwUSDC"},
          {id: MORPHO, name: "Moonwell Flagship ETH", symbol: "mwETH"},
        ]),
        [],
      ),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "vault_overview", {vault: "Moonwell"});

    expect(output).toContain("matches 2 vaults");
    expect(output).toContain(COPE);
    expect(output).toContain(MORPHO);
  });

  it("says so when nothing matches", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": vaultsResponse(100, []),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "vault_overview", {vault: "nope"})).toContain("No vault matches");
  });

  it("nets the flows over the window", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [
        snapshot(1, "1", {dailyDepositedAssets: "5000000"}),
        snapshot(2, "1", {dailyWithdrawnAssets: "2000000"}),
      ]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "vault_overview", {vault: COPE, days: 30});

    expect(output).toContain("deposited: 5 USDC");
    expect(output).toContain("withdrawn: 2 USDC");
    expect(output).toContain("net: 3 USDC");
  });
});

describe("vault_history", () => {
  it("computes return and drawdown from the snapshots", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [
        snapshot(1, "1"),
        snapshot(2, "1.2"),
        snapshot(3, "0.9"),
        snapshot(31, "1.1"),
      ]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "vault_history", {vault: COPE, days: 30});

    expect(output).toContain("return: +10.00%");
    // A drawdown is a fall and carries no sign: "+25.00%" would read as a gain.
    expect(output).toContain("maximum drawdown: 25.00%");
    expect(output).not.toContain("drawdown: +");
  });

  /// No snapshots means a quiet or a young vault. Reading it as a worthless one would be a
  /// confident wrong answer about somebody's money.
  it("distinguishes no history from no value", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), []),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "vault_history", {vault: COPE});

    expect(output).toContain("No snapshots in this period");
    expect(output).toContain("not a vault worth nothing");
  });

  it("says unknown rather than zero when there is one data point", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [snapshot(1, "1")]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "vault_history", {vault: COPE});

    expect(output).toContain("return: n/a");
    expect(output).toContain("unknown, not zero");
  });

  it("returns the series when asked for it", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [
        snapshot(1, "1"),
        snapshot(2, "1.05"),
      ]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "vault_history", {
      vault: COPE,
      days: 30,
      includeSeries: true,
    });

    expect(output).toContain("## Daily share price");
    expect(output).toContain("1.05");
  });

  it("warns that gaps are quiet days rather than missing data", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [
        snapshot(1, "1"),
        snapshot(9, "1.01"),
      ]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "vault_history", {vault: COPE})).toContain("quiet days");
  });
});

describe("compare_vaults", () => {
  /// The claim the whole workstream rests on: one code path, two chains, two protocols, no
  /// per-protocol anything.
  it("ranks vaults from different subgraphs against each other", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{name: "Cope Market Liquidity"}]), [
        snapshot(1, "1"),
        snapshot(31, "1.02"),
      ]),
      "https://two.invalid": source(
        vaultsResponse(200, [{id: MORPHO, name: "Moonwell Flagship USDC", symbol: "mwUSDC"}]),
        [snapshot(1, "1"), snapshot(31, "1.09")],
      ),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "compare_vaults", {days: 30});

    const morphoRow = output.indexOf("Moonwell Flagship USDC");
    const copeRow = output.indexOf("Cope Market Liquidity");
    expect(morphoRow).toBeGreaterThan(-1);
    expect(copeRow).toBeGreaterThan(-1);
    // The better return ranks first.
    expect(morphoRow).toBeLessThan(copeRow);
    expect(output).toContain("+9.00%");
    expect(output).toContain("+2.00%");
  });

  /// A vault with no measurable return placed mid-table implies a result it does not have.
  it("puts an unmeasurable vault last rather than treating it as flat", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{name: "No history"}]), []),
      "https://two.invalid": source(
        vaultsResponse(200, [{id: MORPHO, name: "Has history", symbol: "mwUSDC"}]),
        [snapshot(1, "1"), snapshot(31, "0.95")],
      ),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "compare_vaults", {days: 30});

    // A 5% loss still ranks above a vault whose return is unknown.
    expect(output.indexOf("Has history")).toBeLessThan(output.indexOf("No history"));
    expect(output).toContain("n/a");
  });

  it("names a source that could not be read instead of dropping it", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [
        snapshot(1, "1"),
        snapshot(31, "1.02"),
      ]),
      "https://two.invalid": () => {
        throw new SubgraphError("connection refused", "https://two.invalid");
      },
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "compare_vaults", {days: 30});

    expect(output).toContain("Cope Market Liquidity");
    expect(output).toContain('Source "two" was unavailable');
  });

  it("states that returns are measured on share price", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": source(vaultsResponse(100, [{}]), [
        snapshot(1, "1"),
        snapshot(31, "1.02"),
      ]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const output = await callText(mcp, "compare_vaults", {days: 30});

    expect(output).toContain("measured on share price");
    expect(output).toContain("standardized ERC-4626 schema");
  });
});
