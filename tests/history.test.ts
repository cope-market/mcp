import {describe, expect, it} from "vitest";
import type {DailyPoint} from "../src/history.js";
import {analyse, sumFlows} from "../src/history.js";

function point(day: number, sharePrice: string, overrides: Partial<DailyPoint> = {}): DailyPoint {
  return {
    day,
    timestamp: day * 86_400,
    sharePrice,
    totalAssets: "1000000",
    depositedAssets: "0",
    withdrawnAssets: "0",
    deposits: 0,
    withdrawals: 0,
    ...overrides,
  };
}

describe("performance", () => {
  it("measures the return between the first and last snapshot", () => {
    const result = analyse([point(1, "1"), point(31, "1.1")]);
    expect(result.returnPct).toBeCloseTo(10, 6);
  });

  it("reports a loss as a negative return", () => {
    const result = analyse([point(1, "1"), point(31, "0.9")]);
    expect(result.returnPct).toBeCloseTo(-10, 6);
  });

  /// Annualising compounds, so a naive multiply would report roughly 121% for this.
  it("annualises by compounding rather than scaling", () => {
    const result = analyse([point(0, "1"), point(30, "1.1")]);
    expect(result.annualisedPct).toBeCloseTo((1.1 ** (365 / 30) - 1) * 100, 6);
    expect(result.annualisedPct).toBeGreaterThan(200);
  });

  /// Multiplying a rounding difference by several hundred and calling the product a yield is how
  /// a vault that moved 0.01% in an hour ends up advertised at 8000% APY.
  it("refuses to annualise a window shorter than a day", () => {
    const result = analyse([point(7, "1"), point(7, "1.0001")]);
    expect(result.returnPct).not.toBeNull();
    expect(result.annualisedPct).toBeNull();
  });

  it("finds the deepest peak-to-trough fall, not the last one", () => {
    const result = analyse([
      point(1, "1"),
      point(2, "1.2"),
      point(3, "0.9"),
      point(4, "1.1"),
      point(5, "1.05"),
    ]);
    // Peak 1.2 down to 0.9 is 25%; the later dip from 1.1 to 1.05 is under 5%.
    expect(result.maxDrawdownPct).toBeCloseTo(25, 6);
  });

  it("reports no drawdown for a series that only rises", () => {
    expect(analyse([point(1, "1"), point(2, "1.1"), point(3, "1.2")]).maxDrawdownPct).toBe(0);
  });

  /// A vault with one snapshot has no return. Reporting zero would read as "flat", which is a
  /// claim about performance rather than an admission of ignorance.
  it("reports an unmeasurable return as null, not zero", () => {
    const result = analyse([point(1, "1")]);
    expect(result.returnPct).toBeNull();
    expect(result.annualisedPct).toBeNull();
    expect(result.snapshots).toBe(1);
  });

  it("handles an empty series without inventing anything", () => {
    const result = analyse([]);
    expect(result.returnPct).toBeNull();
    expect(result.maxDrawdownPct).toBeNull();
    expect(result.firstPrice).toBeNull();
    expect(result.snapshots).toBe(0);
  });

  /// A vault that has had everything withdrawn can price at zero. Dividing by it would send an
  /// Infinity into every figure downstream.
  it("survives a starting price of zero", () => {
    const result = analyse([point(1, "0"), point(2, "1")]);
    expect(result.returnPct).toBeNull();
    expect(Number.isFinite(result.maxDrawdownPct ?? 0)).toBe(true);
  });

  it("survives a price falling to zero", () => {
    const result = analyse([point(1, "1"), point(2, "0")]);
    expect(result.returnPct).toBeCloseTo(-100, 6);
    expect(result.maxDrawdownPct).toBeCloseTo(100, 6);
  });

  /// Snapshots exist only for days with activity, so the period asked for and the period covered
  /// are different things and the annualised figure depends on the second.
  it("counts the days actually covered, not the days requested", () => {
    const result = analyse([point(100, "1"), point(107, "1.01")]);
    expect(result.daysCovered).toBe(7);
    expect(result.snapshots).toBe(2);
  });
});

describe("flows", () => {
  it("sums deposits and withdrawals and nets them", () => {
    const flows = sumFlows([
      point(1, "1", {depositedAssets: "1000000", withdrawnAssets: "0"}),
      point(2, "1", {depositedAssets: "500000", withdrawnAssets: "200000"}),
    ]);
    expect(flows.deposited).toBe("1500000");
    expect(flows.withdrawn).toBe("200000");
    expect(flows.net).toBe("1300000");
  });

  /// A vault that shrank has a negative net, and saying so is the whole point of the figure.
  it("reports a negative net when more left than arrived", () => {
    const flows = sumFlows([point(1, "1", {depositedAssets: "1", withdrawnAssets: "1000000"})]);
    expect(flows.net).toBe("-999999");
  });

  /// These are raw token amounts, not ratios. An eighteen-decimal vault's daily flow is past 2^53
  /// and adding them as numbers would lose the low digits of every day.
  it("sums amounts larger than a JavaScript number can hold", () => {
    const big = "9007199254740993000000000";
    const flows = sumFlows([
      point(1, "1", {depositedAssets: big}),
      point(2, "1", {depositedAssets: big}),
    ]);
    expect(flows.deposited).toBe((BigInt(big) * 2n).toString());
  });

  it("is zero over an empty series", () => {
    expect(sumFlows([])).toEqual({deposited: "0", withdrawn: "0", net: "0"});
  });
});
