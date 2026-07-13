import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "./json.js";
import { parseCoreHandshake } from "./protocol.js";
import {
  CORE_OPERATIONS,
  privateCoreMethods,
  rendererCoreMethods,
  rendererCoreOperations,
} from "./operation-registry.js";

interface Fixture {
  kind: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  value?: unknown;
  expectedCode?: string;
}

function fixtures(group: "valid" | "invalid"): Fixture[] {
  const directory = path.resolve(process.cwd(), "fixtures", "protocol", group);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as Fixture);
}

describe("core operation registry", () => {
  it("is the complete source for renderer and private allowlists", () => {
    expect(CORE_OPERATIONS.size).toBeGreaterThan(40);
    expect(privateCoreMethods).toEqual(new Set(CORE_OPERATIONS.keys()));
    expect(rendererCoreMethods).toEqual(new Set(rendererCoreOperations.map(({ method }) => method)));
    for (const operation of CORE_OPERATIONS.values()) {
      expect(operation.paramsSchema.name).toBe(`${operation.method}.params`);
      expect(operation.resultSchema.name).toBe(`${operation.method}.result`);
      expect(operation.timeoutMs).toBeGreaterThan(0);
      expect(operation.requiresHandshake).toBe(operation.method !== "core.version");
    }
  });

  it("accepts all shared valid fixtures", () => {
    for (const fixture of fixtures("valid")) {
      if (fixture.kind === "handshake") {
        expect(() => parseCoreHandshake(fixture.value as JsonValue)).not.toThrow();
        continue;
      }
      const operation = fixture.method ? CORE_OPERATIONS.get(fixture.method) : undefined;
      expect(operation, `missing operation ${fixture.method ?? "unknown"}`).toBeDefined();
      expect(() => operation?.paramsSchema.parse(fixture.params)).not.toThrow();
      expect(() => operation?.resultSchema.parse(fixture.result)).not.toThrow();
    }
  });

  it("rejects all shared invalid fixtures with stable error codes", () => {
    for (const fixture of fixtures("invalid")) {
      const operation = fixture.method ? CORE_OPERATIONS.get(fixture.method) : undefined;
      expect(operation, `missing operation ${fixture.method ?? "unknown"}`).toBeDefined();
      const parse = fixture.kind === "operation-params"
        ? () => operation?.paramsSchema.parse(fixture.value)
        : () => operation?.resultSchema.parse(fixture.value);
      expect(parse).toThrow(expect.objectContaining({ code: fixture.expectedCode }));
    }
  });
});
