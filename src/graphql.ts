/// A GraphQL client with a timeout, a real error check and a short cache.
///
/// GraphQL reports failure with HTTP 200: the body carries an `errors` array and a `data` full of
/// nulls. A client that checks only `response.ok` reads a failed query as a successful one, which
/// here would mean an agent stating a confident number that came from nothing.

export class SubgraphError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "SubgraphError";
  }
}

export interface GraphClient {
  query<T>(url: string, document: string, variables?: Record<string, unknown>): Promise<T>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: {message: string}[];
}

export interface GraphClientOptions {
  timeoutMs?: number;
  /// How long an identical query is reused. Tools fan out across several subgraphs and several
  /// windows, and a conversation asks near-identical questions in a row; a few seconds removes the
  /// repeat traffic without anyone ever seeing a figure older than an indexed block or two.
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createGraphClient(options: GraphClientOptions = {}): GraphClient {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 5_000;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const cache = new Map<string, {at: number; value: unknown}>();

  return {
    async query<T>(
      url: string,
      document: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> {
      const key = `${url} ${document} ${JSON.stringify(variables)}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheTtlMs) return hit.value as T;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({query: document, variables}),
          signal: controller.signal,
        });
      } catch (error) {
        const reason =
          error instanceof Error && error.name === "AbortError"
            ? `did not answer within ${timeoutMs}ms`
            : `is unreachable: ${error instanceof Error ? error.message : String(error)}`;
        throw new SubgraphError(`The subgraph ${reason}.`, url);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new SubgraphError(`The subgraph answered HTTP ${response.status}.`, url);
      }

      let body: GraphQLResponse<T>;
      try {
        body = (await response.json()) as GraphQLResponse<T>;
      } catch {
        throw new SubgraphError("The subgraph answered with something that is not JSON.", url);
      }

      if (body.errors && body.errors.length > 0) {
        throw new SubgraphError(
          `The subgraph rejected the query: ${body.errors.map((e) => e.message).join("; ")}`,
          url,
        );
      }

      if (body.data === undefined || body.data === null) {
        throw new SubgraphError("The subgraph answered with no data and no errors.", url);
      }

      cache.set(key, {at: now(), value: body.data});
      return body.data;
    },
  };
}
