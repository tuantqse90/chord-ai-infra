// ask2049: the subset of Chord's testkit/helpers.ts the copied Chord tests use. resetRedis clears the in-memory Redis
// stand-in (utils/redis) instead of Chord's FakeRedis; mockFetch is Chord's, unchanged.
import { _resetRedis } from "../utils/redis";

export function resetRedis() {
  _resetRedis();
}

type Responder =
  | Response
  | object
  | string
  | number
  | ((url: string, init?: RequestInit) => Response | object | string | Promise<Response | object | string>);

export interface MockFetchHandle {
  calls: { url: string; init?: RequestInit }[];
  restore: () => void;
}

/**
 * Stub globalThis.fetch, routing by URL substring match (first matching key wins, declaration
 * order). Unmatched URLs throw — the offline guarantee. Responder can be a Response, a JSON-able
 * value, or a function (sync/async). ALWAYS call handle.restore() in afterEach/afterAll.
 */
export function mockFetch(routes: Record<string, Responder>): MockFetchHandle {
  const prev = globalThis.fetch;
  const calls: MockFetchHandle["calls"] = [];

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string })?.url ?? String(input));
    calls.push({ url, init });

    for (const [needle, responder] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      const v = typeof responder === "function" ? await (responder as (u: string, i?: RequestInit) => unknown)(url, init) : responder;
      if (v instanceof Response) return v;
      return Response.json(v as object);
    }
    throw new Error(`mockFetch: unmocked URL ${url} — add it to the routes map or fix the code under test.`);
  }) as unknown as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = prev) };
}
