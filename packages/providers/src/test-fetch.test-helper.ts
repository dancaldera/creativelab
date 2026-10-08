/**
 * Test-only fake transport.
 *
 * Production code takes `fetch` by injection, so the entire provider layer can be exercised
 * without a socket. This helper gives the suites a small request router with per-call
 * scripting (a queue of responses), which is what the retry, `Retry-After`, malformed-body
 * and auth-failure cases need.
 */
import type { HeaderRecord } from "./http.js";

export interface MockResponseSpec {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: HeaderRecord;
  readonly json?: unknown;
  /** Raw body; wins over `json`. Used for malformed payloads and binary responses. */
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

export interface MockRequest {
  readonly url: string;
  readonly method: string;
  /** Header lookup, case-insensitive. */
  readonly header: (name: string) => string | null;
  readonly headers: HeaderRecord;
  readonly body: string | undefined;
  /** Parsed JSON body when the raw body was JSON. */
  readonly json: unknown;
  readonly call: number;
}

export interface MockFetchRoute {
  /** Regular expression matched against the request URL. */
  readonly match: RegExp;
  readonly method?: string;
  /** Responses served in order; the last one repeats once the queue is exhausted. */
  readonly responses: readonly MockResponseSpec[];
  /** Records every request this route served. */
  readonly seen: MockRequest[];
  /** Response index for the next call (0-based). */
  index: number;
}

export interface MockFetch {
  readonly fetch: typeof fetch;
  readonly requests: MockRequest[];
  /** Every route, in match order. */
  readonly routes: MockFetchRoute[];
  addRoute(match: RegExp, responses: readonly MockResponseSpec[], method?: string): MockFetchRoute;
  /** Calls served per route. */
  countFor(pattern: RegExp): number;
  lastRequest(): MockRequest | undefined;
}

export interface CreateMockFetchOptions {
  /** Fallback for any URL that matches no route. */
  readonly fallback?: MockResponseSpec;
}

/** Node-friendly alias: `HeadersInit` is a DOM-only name and this package is ES2023. */
type HeadersInput = Record<string, string> | Headers | readonly (readonly [string, string])[];

/** Node-friendly alias: `RequestInfo` is a DOM-only name. */
type FetchInput = string | URL | Request;

function toHeaders(init: HeadersInput | undefined): Headers {
  return new Headers(init as Record<string, string>);
}

export function createMockFetch(options: CreateMockFetchOptions = {}): MockFetch {
  const routes: MockFetchRoute[] = [];
  const requests: MockRequest[] = [];

  const buildResponse = (spec: MockResponseSpec): Response => {
    const status = spec.status ?? 200;
    const init: ResponseInit = {
      status,
      ...(spec.statusText !== undefined ? { statusText: spec.statusText } : {}),
      headers: spec.headers ?? {},
    };
    if (status === 204 || status === 205 || status === 304) return new Response(null, init);
    if (spec.bytes !== undefined) return new Response(spec.bytes, init);
    if (spec.text !== undefined) return new Response(spec.text, init);
    if (spec.json !== undefined) {
      return new Response(JSON.stringify(spec.json), {
        ...init,
        headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
      });
    }
    return new Response(null, init);
  };

  const fetchImpl = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? (input as Request).method : "GET") ??
      "GET"
    ).toUpperCase();
    const headers =
      init?.headers !== undefined
        ? toHeaders(init.headers as HeadersInput)
        : typeof input === "object" && "headers" in input
          ? (input as Request).headers
          : new Headers();
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    let json: unknown;
    if (bodyText) {
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = undefined;
      }
    }
    const headerRecord: HeaderRecord = {};
    headers.forEach((value: string, key: string) => {
      headerRecord[key.toLowerCase()] = value;
    });
    const record: MockRequest = {
      url,
      method,
      header: (name) => headers.get(name),
      headers: headerRecord,
      body: bodyText,
      json,
      call: requests.length,
    };
    requests.push(record);

    const route = routes.find(
      (candidate) =>
        candidate.match.test(url) && (!candidate.method || candidate.method === method),
    );
    if (!route) {
      if (options.fallback) return buildResponse(options.fallback);
      // An unmatched request is almost always a typo in the test; fail loudly and traceably.
      throw new Error(`MockFetch: no route for ${method} ${url}`);
    }
    route.seen.push(record);
    const spec = route.responses[Math.min(route.index, route.responses.length - 1)] ?? {};
    route.index += 1;
    return buildResponse(spec);
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    requests,
    routes,
    addRoute: (match, responses, method) => {
      const route: MockFetchRoute = {
        match,
        method,
        responses,
        seen: [],
        index: 0,
      } satisfies MockFetchRoute;
      routes.push(route);
      return route;
    },
    countFor: (pattern) => requests.filter((request) => pattern.test(request.url)).length,
    lastRequest: () => requests[requests.length - 1],
  };
}

/** Build a route for any URL, used when an adapter has exactly one endpoint in play. */
export const ANY_URL = /.*/;

/** Shorthand for a retryable failure followed by success. */
export function retryAfterThenOk(retryAfter: string): MockResponseSpec[] {
  return [
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": retryAfter },
      json: { error: "slow down" },
    },
    { status: 200, json: { data: [] } },
  ];
}
