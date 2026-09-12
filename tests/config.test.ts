import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {DEFAULT_CONFIG, loadConfig} from "../src/config.js";

function configFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "erc4626-mcp-")), "config.json");
  writeFileSync(path, contents);
  return path;
}

describe("loading configuration", () => {
  /// Someone who runs this with no setup still gets three live vaults across two chains and two
  /// protocols, which is the thing being demonstrated.
  it("falls back to the shipped deployments", () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.vaultSubgraphs.length).toBeGreaterThan(1);
  });

  it("reads a file when one is named", () => {
    const path = configFile(
      JSON.stringify({
        vaultSubgraphs: [
          {key: "mine", label: "My vault", network: "mainnet", url: "https://example.com/sg"},
        ],
      }),
    );
    const config = loadConfig({ERC4626_MCP_CONFIG: path});

    expect(config.vaultSubgraphs[0]?.key).toBe("mine");
    // The trader tools need it; someone pointing this at their own vault has no copy graph and
    // should not have to invent one.
    expect(config.copeSubgraph).toBeNull();
  });

  /// Falling back here would answer about our vaults while the operator believed it was answering
  /// about theirs, which is the worst available outcome.
  it("fails rather than falling back when the file is unreadable", () => {
    expect(() => loadConfig({ERC4626_MCP_CONFIG: "/nonexistent/config.json"})).toThrow(
      /could not be read/,
    );
  });

  it("fails on a file that is not JSON", () => {
    expect(() => loadConfig({ERC4626_MCP_CONFIG: configFile("not json")})).toThrow(
      /could not be read/,
    );
  });

  it("names the field that is wrong", () => {
    const path = configFile(JSON.stringify({vaultSubgraphs: [{key: "a", label: "A"}]}));
    expect(() => loadConfig({ERC4626_MCP_CONFIG: path})).toThrow(/vaultSubgraphs\.0\./);
  });

  it("rejects a url that is not one", () => {
    const path = configFile(
      JSON.stringify({
        vaultSubgraphs: [{key: "a", label: "A", network: "mainnet", url: "not-a-url"}],
      }),
    );
    expect(() => loadConfig({ERC4626_MCP_CONFIG: path})).toThrow(/url/);
  });

  it("rejects an empty list, which would leave every tool with nothing to read", () => {
    const path = configFile(JSON.stringify({vaultSubgraphs: []}));
    expect(() => loadConfig({ERC4626_MCP_CONFIG: path})).toThrow();
  });

  /// Keys identify a source in tool arguments and in output. Two sources sharing one would make
  /// every answer ambiguous about where it came from.
  it("rejects a duplicate key", () => {
    const path = configFile(
      JSON.stringify({
        vaultSubgraphs: [
          {key: "same", label: "A", network: "mainnet", url: "https://a.example"},
          {key: "same", label: "B", network: "base", url: "https://b.example"},
        ],
      }),
    );
    expect(() => loadConfig({ERC4626_MCP_CONFIG: path})).toThrow(/"same" twice/);
  });

  it("rejects a key that would not read as an identifier", () => {
    const path = configFile(
      JSON.stringify({
        vaultSubgraphs: [
          {key: "Not A Key", label: "A", network: "mainnet", url: "https://a.example"},
        ],
      }),
    );
    expect(() => loadConfig({ERC4626_MCP_CONFIG: path})).toThrow(/lower-case/);
  });
});
