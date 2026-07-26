// The fakenet's public responses API: a helper surface so clients can fetch
// the raw EVM output of their remote execution without their own
// debug_traceTransaction access. The server caches the top call frame's
// return data (exactly as traced, before any respond serialisation) per
// request id, and GET /responses/{requestId} serves it back.
//
// The API is a CONVENIENCE, never an authority: the output it returns is
// unauthenticated, and a client must recompute the attestation digest from
// it and verify the MPC's posted signature in-circuit before trusting it.

import http from 'node:http';

/** One cached remote-execution result, keyed by its request id. */
export interface CachedResponse {
  /** The request id, lowercase hex, no 0x prefix. */
  requestId: string;
  /** Whether the remote execution succeeded. */
  success: boolean;
  /**
   * The raw EVM return data of the mined call as 0x-prefixed hex, exactly
   * as debug_traceTransaction's top call frame reports it (0x for a plain
   * transfer). null for a failed execution, which has no attested output:
   * the MPC posts the fixed failure output instead.
   */
  output: string | null;
  /** The remote transaction's hash. */
  txHash: string;
  /** When the execution result was observed (ISO 8601). */
  observedAt: string;
}

/** Normalise a request id to the cache's key form: lowercase hex, no 0x. */
function normaliseRequestId(requestId: string): string {
  const hex = requestId.startsWith('0x') ? requestId.slice(2) : requestId;
  return hex.toLowerCase();
}

/**
 * In-memory store of observed execution results by request id. Entries are
 * written by the transaction monitor when an execution confirms (or fails)
 * and read by the HTTP API. Unbounded by design: one entry per request is
 * small, and the fakenet is a dev tool with process-lifetime scope.
 */
export class ResponseCache {
  private responses = new Map<string, CachedResponse>();

  set(
    requestId: string,
    entry: Omit<CachedResponse, 'requestId' | 'observedAt'>
  ): void {
    const id = normaliseRequestId(requestId);
    this.responses.set(id, {
      requestId: id,
      observedAt: new Date().toISOString(),
      ...entry,
    });
  }

  get(requestId: string): CachedResponse | undefined {
    return this.responses.get(normaliseRequestId(requestId));
  }

  get size(): number {
    return this.responses.size;
  }
}

const REQUEST_ID_PATH = /^\/responses\/(0x)?([0-9a-fA-F]{64})$/;

/**
 * Start the HTTP server exposing GET /responses/{requestId} over the given
 * cache. The request id is accepted with or without a 0x prefix, any case.
 * Responds 200 with the JSON {@link CachedResponse}, 404 when the id has no
 * cached result (yet), and 400 for a malformed path.
 *
 * @param cache - The cache the transaction monitor writes into.
 * @param port - TCP port to listen on.
 * @returns The listening server (close it on shutdown).
 */
export function startResponsesApi(
  cache: ResponseCache,
  port: number
): http.Server {
  const server = http.createServer((req, res) => {
    const respond = (status: number, body: object) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        // Dev tool: callers are local test suites and browser consoles.
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'GET') {
      respond(405, { error: 'only GET is supported' });
      return;
    }
    const match = REQUEST_ID_PATH.exec(req.url ?? '');
    const requestId = match?.[2];
    if (!requestId) {
      respond(400, {
        error: 'expected /responses/{requestId} with a 64-hex-char request id',
      });
      return;
    }
    const entry = cache.get(requestId);
    if (!entry) {
      respond(404, { error: 'no response observed for this request id yet' });
      return;
    }
    respond(200, entry);
  });

  server.listen(port, () => {
    console.log(
      `ResponsesApi: serving GET /responses/{requestId} on port ${port}`
    );
  });
  return server;
}
