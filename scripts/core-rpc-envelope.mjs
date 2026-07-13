import { randomUUID } from "node:crypto";

export const CORE_RPC_PROTOCOL_VERSION = "m0-jsonrpc-stdio-1";

export function createVersionedCoreRequest(method, params = null) {
  const requestId = randomUUID();
  return {
    protocolVersion: CORE_RPC_PROTOCOL_VERSION,
    requestId,
    id: requestId,
    method,
    params,
    sentAt: new Date().toISOString(),
  };
}
