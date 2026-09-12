import {describe, expect, it} from "vitest";
import {SubgraphError} from "../src/graphql.js";
import {formatUnits, trimDecimal} from "../src/vaults.js";
import {TEST_CONFIG, callText, connect, fakeGraph, vaultsResponse} from "./helpers.js";

describe("the tool surface", () => {
  it("advertises its tools over the protocol", async () => {
    const {client} = fakeGraph({});
    const mcp = await connect(TEST_CONFIG, client);
    const {tools} = await mcp.listTools();

    expect(tools.map((tool) => tool.name)).toContain("list_vaults");
  });

  /// The one thing the brief names as insufficient. Exposing a raw query tool would move the
  /// querying to the model and leave this server computing nothing, so its absence is asserted
  /// rather than merely intended.
  it("exposes no raw query passthrough", async () => {
    const {client} = fakeGraph({});
    const mcp = await connect(TEST_CONFIG, client);
    const {tools} = await mcp.listTools();

    for (const tool of tools) {
      expect(tool.name).not.toMatch(/query|graphql|raw|sql|exec/i);
    }
  });

  /// No tool may write. There is no signer in this process, and a tool that claimed otherwise
  /// would be inviting an agent to try.
  it("marks every tool read-only", async () => {
    const {client} = fakeGraph({});
    const mcp = await connect(TEST_CONFIG, client);
    const {tools} = await mcp.listTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });
});

describe("list_vaults", () => {
  it("reads every configured subgraph, not just the first", async () => {
    const {client, calls} = fakeGraph({
      "https://one.invalid": vaultsResponse(100, [{}]),
      "https://two.invalid": vaultsResponse(200, [{name: "Moonwell Flagship ETH"}]),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const text = await callText(mcp, "list_vaults");

    expect(calls.map((call) => call.url).sort()).toEqual([
      "https://one.invalid",
      "https://two.invalid",
    ]);
    expect(text).toContain("Cope Market Liquidity");
    expect(text).toContain("Moonwell Flagship ETH");
  });

  /// Decimals are the whole reason the standardized schema exists. A vault holding six-decimal
  /// USDC under eighteen-decimal shares must not report thirty million units of anything.
  it("formats amounts at the asset's decimals, not the share's", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": vaultsResponse(100, [{}]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const text = await callText(mcp, "list_vaults");

    expect(text).toContain("total assets: 30 USDC");
  });

  /// A model handed a number with no time attached will state it as current, and it is not.
  it("says which block the figures describe", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": vaultsResponse(4242, [{}]),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);
    const text = await callText(mcp, "list_vaults");

    expect(text).toContain("as of block 4242");
    expect(text).toContain("NOT chain head");
  });

  /// One dead subgraph must not blank the others. A comparison across four vaults is still worth
  /// having when three answered, provided the fourth says so instead of vanishing.
  it("reports an unreachable subgraph and still answers about the rest", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": vaultsResponse(100, [{}]),
      "https://two.invalid": () => {
        throw new SubgraphError("connection refused", "https://two.invalid");
      },
    });
    const mcp = await connect(TEST_CONFIG, client);
    const text = await callText(mcp, "list_vaults");

    expect(text).toContain("Cope Market Liquidity");
    expect(text).toContain("UNAVAILABLE");
    expect(text).toContain("connection refused");
  });

  it("surfaces indexing errors rather than answering from a broken index", async () => {
    const broken = vaultsResponse(100, [{}]) as {_meta: {hasIndexingErrors: boolean}};
    broken._meta.hasIndexingErrors = true;
    const {client} = fakeGraph({
      "https://one.invalid": broken,
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "list_vaults")).toContain("WITH INDEXING ERRORS");
  });

  it("says so when a subgraph has indexed no vaults", async () => {
    const {client} = fakeGraph({
      "https://one.invalid": vaultsResponse(100, []),
      "https://two.invalid": vaultsResponse(100, []),
    });
    const mcp = await connect(TEST_CONFIG, client);

    expect(await callText(mcp, "list_vaults")).toContain("No vaults indexed yet");
  });
});

describe("formatUnits", () => {
  it("places the point at the token's decimals", () => {
    expect(formatUnits("30000000", 6)).toBe("30");
    expect(formatUnits("30016928", 6)).toBe("30.016928");
  });

  it("pads a value smaller than one whole unit", () => {
    expect(formatUnits("1", 6)).toBe("0.000001");
    expect(formatUnits("0", 6)).toBe("0");
  });

  it("handles a negative amount", () => {
    expect(formatUnits("-1495554512560313", 18)).toBe("-0.001495554512560313");
  });

  it("handles zero decimals", () => {
    expect(formatUnits("42", 0)).toBe("42");
  });

  /// A vault with any real eighteen-decimal balance is past what a double holds exactly. A tool
  /// whose job is reporting balances must not be the thing that rounds them.
  it("keeps every digit of a value past 2^53", () => {
    expect(formatUnits("4244174386474554881097832", 18)).toBe("4244174.386474554881097832");
    expect(formatUnits("1640060354038959741139", 18)).toBe("1640.060354038959741139");
  });
});

describe("trimDecimal", () => {
  /// The subgraph stores BigDecimal at 34 significant digits. Quoting all of them reads as
  /// precision on a figure whose tail is noise.
  it("cuts a share price down to something quotable", () => {
    expect(trimDecimal("1.032384712707604812799746690089656")).toBe("1.032385");
    expect(trimDecimal("1.087653871222050951712034223980491")).toBe("1.087654");
  });

  it("leaves a short value alone", () => {
    expect(trimDecimal("1")).toBe("1");
    expect(trimDecimal("1.25")).toBe("1.25");
  });

  it("rounds half up rather than truncating", () => {
    expect(trimDecimal("0.9999995")).toBe("1");
    expect(trimDecimal("0.9999994")).toBe("0.999999");
  });

  /// Rounding that carried into the whole part through a float would land on 1.0000000000000002.
  it("carries into the whole part exactly", () => {
    expect(trimDecimal("1.9999999")).toBe("2");
  });

  it("keeps the sign", () => {
    expect(trimDecimal("-1.0323847127076048")).toBe("-1.032385");
  });
});
