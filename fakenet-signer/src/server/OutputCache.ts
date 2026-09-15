// The fakenet's simulation of the MPC's output cache (sig-net/mpc,
// chain-midnight/src/output_storage.rs): the exact serialised output bytes
// the responder attests for a Midnight bidirectional request, held as one
// object per request id and served over HTTP under the MPC's bucket layout
//   /<prefix>/<networkId>/<signetContractAddress>/<requestId>.bin
// so a client's MpcOutputCacheReader (@sig-net/midnight) reads the fakenet
// and a real MPC's bucket the same way. An object is written BEFORE the
// attestation is posted on chain, as the MPC does, and holds UNTRUSTED data:
// a client verifies the posted signature over the bytes it downloads.

import http from 'node:http';

/** TCP port the cache is served on when OUTPUT_CACHE_PORT is unset. */
export const DEFAULT_OUTPUT_CACHE_PORT = 3040;

/** Object prefix when OUTPUT_CACHE_PREFIX is unset: the MPC's `publisher.output_storage.prefix` twin. */
export const DEFAULT_OUTPUT_CACHE_PREFIX = 'v1/fakenet';

/** The namespace an object lives under: the MPC keys its cache by network and signet singleton. */
export interface OutputCacheNamespace {
  networkId: string;
  /** The signet singleton the responder posts through, 64 hex chars. */
  signetContractAddress: string;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

/**
 * In-memory object store keyed by object name. Unbounded by design: one
 * small object per request, and the fakenet is a dev tool with
 * process-lifetime scope.
 */
export class OutputCacheStore {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly prefix: string;

  /**
   * @param prefix - The object prefix every name starts with, slashes at
   *   either end ignored.
   */
  constructor(prefix: string) {
    this.prefix = prefix.replace(/^\/+|\/+$/g, '');
    if (this.prefix.length === 0) {
      throw new Error('OutputCache: OUTPUT_CACHE_PREFIX must not be empty');
    }
  }

  /** The object name of `requestId`'s attested output under `namespace`. */
  objectName(namespace: OutputCacheNamespace, requestId: Uint8Array): string {
    const requestIdHex = Buffer.from(requestId).toString('hex');
    return `${this.prefix}/${namespace.networkId}/${namespace.signetContractAddress}/${requestIdHex}.bin`;
  }

  /**
   * Store the attested bytes of a request before its attestation is posted.
   * Mirrors the MPC's precondition: an object that already exists must hold
   * the same bytes, since only identical bytes satisfy the attestation a
   * client verifies, so any other content withholds the on-chain response.
   */
  ensureOutput(
    namespace: OutputCacheNamespace,
    requestId: Uint8Array,
    output: Uint8Array
  ): void {
    const name = this.objectName(namespace, requestId);
    const existing = this.objects.get(name);
    if (existing === undefined) {
      this.objects.set(name, Uint8Array.from(output));
      console.log(`OutputCache: stored ${output.length} byte(s) at ${name}`);
      return;
    }
    if (!bytesEqual(existing, output)) {
      throw new Error(
        `OutputCache: the stored output at ${name} differs from the attested bytes`
      );
    }
  }

  /** The object stored under `name`, if any. */
  get(name: string): Uint8Array | undefined {
    return this.objects.get(name);
  }

  get size(): number {
    return this.objects.size;
  }
}

/**
 * Start the HTTP server serving the store's objects: GET /<object name>
 * answers 200 with the raw bytes (application/octet-stream), 404 for a
 * name the store does not hold (yet), and 405 for any other method, the
 * same answers a public bucket gives a client reading by URL.
 *
 * @param store - The store the Midnight monitor writes into.
 * @param port - TCP port to listen on.
 * @returns The listening server (close it on shutdown).
 */
export function startOutputCacheApi(
  store: OutputCacheStore,
  port: number
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('only GET is supported');
      return;
    }
    const name = decodeURIComponent(
      (req.url ?? '').split('?')[0]?.replace(/^\/+/, '') ?? ''
    );
    const object = store.get(name);
    if (object === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`NoSuchKey: ${name}`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': object.length,
      // Dev tool: callers are local test suites and browser consoles.
      'access-control-allow-origin': '*',
    });
    res.end(Buffer.from(object));
  });

  // Without this handler a listen failure (most commonly a port conflict)
  // surfaces as an unhandled 'error' event and an opaque crash. Log what went
  // wrong, name the knob that fixes it, and shut down cleanly.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `OutputCache: port ${port} is already in use. Set OUTPUT_CACHE_PORT ` +
          `to a free port (or stop the process holding port ${port}) and restart.`
      );
    } else {
      console.error(
        `OutputCache: server error on port ${port} (OUTPUT_CACHE_PORT):`,
        error
      );
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(
      `OutputCache: serving GET /<prefix>/<networkId>/<signetContractAddress>/<requestId>.bin on port ${port}`
    );
  });
  return server;
}
