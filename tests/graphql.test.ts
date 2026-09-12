import {describe, expect, it} from "vitest";
import {createGraphClient} from "../src/graphql.js";

const URL = "https://example.invalid/subgraph";

function jsonFetch(answers: (() => Response | Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  count: () => number;
} {
  let index = 0;
  return {
    count: () => index,
    fetchImpl: (async () => {
      const answer = answers[Math.min(index, answers.length - 1)]!;
      index += 1;
      return answer();
    }) as unknown as typeof fetch,
  };
}

describe("querying", () => {
  it("returns the data", async () => {
    const {fetchImpl} = jsonFetch([() => Response.json({data: {vaults: []}})]);
    const client = createGraphClient({fetchImpl});
    await expect(client.query(URL, "{ vaults { id } }")).resolves.toEqual({vaults: []});
  });

  /// GraphQL reports failure with HTTP 200 and a data of nulls. Checking only `response.ok` reads
  /// that as success, and an agent would state a number that came from nothing.
  it("treats a GraphQL error as a failure despite the 200", async () => {
    const {fetchImpl} = jsonFetch([
      () => Response.json({data: null, errors: [{message: "Unknown field `vults`"}]}),
    ]);
    const client = createGraphClient({fetchImpl});
    await expect(client.query(URL, "{ vults { id } }")).rejects.toThrow(/Unknown field/);
  });

  it("rejects a non-2xx status", async () => {
    const {fetchImpl} = jsonFetch([() => new Response("gateway", {status: 502})]);
    await expect(createGraphClient({fetchImpl}).query(URL, "{ x }")).rejects.toThrow(/HTTP 502/);
  });

  it("rejects a body that is not JSON", async () => {
    const {fetchImpl} = jsonFetch([() => new Response("<html>maintenance</html>")]);
    await expect(createGraphClient({fetchImpl}).query(URL, "{ x }")).rejects.toThrow(/not JSON/);
  });

  it("rejects an answer with neither data nor errors", async () => {
    const {fetchImpl} = jsonFetch([() => Response.json({})]);
    await expect(createGraphClient({fetchImpl}).query(URL, "{ x }")).rejects.toThrow(
      /no data and no errors/,
    );
  });

  it("rejects when the network is unreachable", async () => {
    const {fetchImpl} = jsonFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(createGraphClient({fetchImpl}).query(URL, "{ x }")).rejects.toThrow(/unreachable/);
  });

  /// A hung indexer would otherwise hold a tool call open until the client gave up on the server
  /// entirely, which looks to a user like the whole thing is broken.
  it("gives up when the subgraph does not answer", async () => {
    const fetchImpl = ((_url: string, init?: {signal?: AbortSignal}) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), {name: "AbortError"})),
        );
      })) as unknown as typeof fetch;

    await expect(createGraphClient({fetchImpl, timeoutMs: 10}).query(URL, "{ x }")).rejects.toThrow(
      /did not answer within 10ms/,
    );
  });

  it("carries the url so an error says which subgraph failed", async () => {
    const {fetchImpl} = jsonFetch([() => new Response("no", {status: 500})]);
    await expect(createGraphClient({fetchImpl}).query(URL, "{ x }")).rejects.toMatchObject({
      name: "SubgraphError",
      url: URL,
    });
  });
});

describe("caching", () => {
  it("reuses an identical query within the window", async () => {
    const {fetchImpl, count} = jsonFetch([() => Response.json({data: {n: 1}})]);
    const client = createGraphClient({fetchImpl, cacheTtlMs: 1000, now: () => 0});

    await client.query(URL, "{ n }");
    await client.query(URL, "{ n }");
    expect(count()).toBe(1);
  });

  it("does not confuse two different queries", async () => {
    const {fetchImpl, count} = jsonFetch([() => Response.json({data: {n: 1}})]);
    const client = createGraphClient({fetchImpl, cacheTtlMs: 1000, now: () => 0});

    await client.query(URL, "{ a }");
    await client.query(URL, "{ b }");
    expect(count()).toBe(2);
  });

  /// The same document against two subgraphs is two questions. Keying on the document alone would
  /// answer about one vault while claiming to describe another.
  it("does not confuse two subgraphs asked the same thing", async () => {
    const {fetchImpl, count} = jsonFetch([() => Response.json({data: {n: 1}})]);
    const client = createGraphClient({fetchImpl, cacheTtlMs: 1000, now: () => 0});

    await client.query("https://a.invalid", "{ n }");
    await client.query("https://b.invalid", "{ n }");
    expect(count()).toBe(2);
  });

  it("distinguishes the same query with different variables", async () => {
    const {fetchImpl, count} = jsonFetch([() => Response.json({data: {n: 1}})]);
    const client = createGraphClient({fetchImpl, cacheTtlMs: 1000, now: () => 0});

    await client.query(URL, "query Q($w: Int!) { n(w: $w) }", {w: 7});
    await client.query(URL, "query Q($w: Int!) { n(w: $w) }", {w: 30});
    expect(count()).toBe(2);
  });

  it("asks again once the entry is stale", async () => {
    const {fetchImpl, count} = jsonFetch([() => Response.json({data: {n: 1}})]);
    let clock = 0;
    const client = createGraphClient({fetchImpl, cacheTtlMs: 1000, now: () => clock});

    await client.query(URL, "{ n }");
    clock = 1001;
    await client.query(URL, "{ n }");
    expect(count()).toBe(2);
  });

  /// Caching a failure would make one blip look like a sustained outage for as long as the entry
  /// lived, and the next call is the cheapest place to find out it recovered.
  it("does not cache a failure", async () => {
    let first = true;
    const fetchImpl = (async () => {
      if (first) {
        first = false;
        return new Response("no", {status: 500});
      }
      return Response.json({data: {n: 1}});
    }) as unknown as typeof fetch;
    const client = createGraphClient({fetchImpl, cacheTtlMs: 1000, now: () => 0});

    await expect(client.query(URL, "{ n }")).rejects.toThrow();
    await expect(client.query(URL, "{ n }")).resolves.toEqual({n: 1});
  });
});
