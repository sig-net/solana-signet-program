// Midnight node connection config — everything needed to talk to one Midnight
// network. Ported from @midnight-erc20-vault/lib's midnight-node-config.ts, kept
// to the type + a WS-derivation helper: this server supplies explicit endpoints
// from its own ServerConfig/env layer, so the lib's env reader and per-network
// endpoint defaults are intentionally NOT ported here.

import type { NetworkId } from "./network-id";

/**
 * The set of endpoints (+ network id) needed to reach the chain. Plain data,
 * so it can be handed to functions by argument rather than reaching for a
 * global. A seed is intentionally NOT part of this: this config describes a
 * *network*, while a seed identifies a *wallet*.
 */
export interface MidnightNodeConfig {
  readonly indexerUrl: string; // indexer GraphQL over HTTP
  readonly indexerWsUrl: string; // indexer GraphQL over WebSocket (subscriptions / sync)
  readonly nodeUrl: string; // Midnight node RPC (HTTP; converted to ws:// for the facade relay)
  readonly proofServerUrl: string; // proof server (ZK proof generation)
  readonly networkId: NetworkId; // which network these endpoints belong to
}

export type Endpoints = Omit<MidnightNodeConfig, "networkId">;

// The proof server sees private witness data, so it is always run locally
// rather than against a remote host.
export const LOCAL_PROOF_SERVER = "http://127.0.0.1:6300";

// Derive the indexer WebSocket URL from the indexer HTTP URL: swap the scheme
// to ws(s) and append the "/ws" path segment the indexer expects.
export function indexerWsUrlFromIndexerUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}
