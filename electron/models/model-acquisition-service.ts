import { createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { request } from "node:https";
import { objectValue, stringField, type JsonValue } from "../core/json.js";
import type { CoreClient } from "../core/core-client.js";
import type { MainWindowProvider } from "../security/validate-sender.js";
import { publicModelEntry, trustedModel, TRUSTED_MODEL_CATALOG, type TrustedModelCatalogEntry } from "./model-catalog.js";

const MAX_REDIRECTS = 5;
const MAX_CHUNK_BYTES = 512 * 1024;
const NETWORK_IDLE_TIMEOUT_MS = 30_000;

export type ModelHttpsRequest = (
  url: URL,
  options: RequestOptions,
  listener: (response: IncomingMessage) => void,
) => ClientRequest;

export interface ModelAcquisitionOptions {
  requestHttps?: ModelHttpsRequest;
  catalog?: readonly TrustedModelCatalogEntry[];
}

const defaultHttpsRequest: ModelHttpsRequest = (url, options, listener) => request(url, options, listener);

type ActiveDownload = {
  modelId: string;
  importId: string | null;
  bytesReceived: number;
  request: ClientRequest | null;
  cancelled: boolean;
};

async function requireResult(core: CoreClient, method: string, params: JsonValue) {
  const response = await core.call(method, params);
  if (!response.ok) throw new Error(response.error?.message ?? `${method} failed`);
  return objectValue(response.result ?? null);
}

function validateDownloadUrl(entry: TrustedModelCatalogEntry, value: string, initial: boolean): URL {
  const url = new URL(value);
  const allowedHosts = entry.download?.allowedHosts ?? [];
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || (url.port !== "" && url.port !== "443")
    || !allowedHosts.includes(url.hostname.toLowerCase())
    || (initial && url.toString() !== entry.download?.url)
  ) throw new Error("The packaged model download location was rejected.");
  return url;
}

function openHttps(url: URL, active: ActiveDownload, requestHttps: ModelHttpsRequest): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const requestHandle = requestHttps(url, {
      method: "GET",
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "Candor-Model-Acquisition/1",
      },
    }, resolve);
    active.request = requestHandle;
    requestHandle.once("error", reject);
    requestHandle.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
      requestHandle.destroy(new Error("Model download timed out."));
    });
    requestHandle.end();
  });
}

async function responseFor(
  entry: TrustedModelCatalogEntry,
  active: ActiveDownload,
  requestHttps: ModelHttpsRequest,
): Promise<IncomingMessage> {
  let url = validateDownloadUrl(entry, entry.download?.url ?? "", true);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await openHttps(url, active, requestHttps);
    if (active.cancelled) {
      response.destroy();
      throw new Error("Model download was canceled.");
    }
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Model download redirect was rejected.");
      url = validateDownloadUrl(entry, new URL(location, url).toString(), false);
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`Model download failed with HTTP ${response.statusCode ?? "unknown"}.`);
    }
    return response;
  }
  throw new Error("Model download exceeded the redirect limit.");
}

export class ModelAcquisitionService {
  private active: ActiveDownload | null = null;

  constructor(
    private readonly core: CoreClient,
    private readonly getMainWindow: MainWindowProvider,
    private readonly options: ModelAcquisitionOptions = {},
  ) {}

  private catalogEntries(): readonly TrustedModelCatalogEntry[] {
    return this.options.catalog ?? TRUSTED_MODEL_CATALOG;
  }

  private entry(modelId: string): TrustedModelCatalogEntry | undefined {
    return this.options.catalog
      ? this.options.catalog.find((candidate) => candidate.modelId === modelId)
      : trustedModel(modelId);
  }

  async catalog(): Promise<JsonValue> {
    const modelStatus: Record<string, JsonValue> = await requireResult(
      this.core,
      "models.status",
      null,
    ).catch(() => ({}));
    const installed = new Map(
      Array.isArray(modelStatus.models)
        ? modelStatus.models.map((candidate: JsonValue) => {
            const value = objectValue(candidate);
            return [stringField(value, "modelId"), value] as const;
          })
        : [],
    );
    const models = this.catalogEntries().map((entry) => {
      const status = objectValue(installed.get(entry.modelId) ?? null);
      return {
        ...publicModelEntry(entry),
        installed: status.installed === true,
        verified: status.verified === true,
      };
    });
    const recommendedDefaultModelId = models.find((model) =>
      model.capability === "speech"
      && model.defaultEligible
      && model.verified)?.modelId ?? null;
    return {
      schemaVersion: 1,
      localOnly: true,
      cloudModels: false,
      remoteCatalog: false,
      explicitDownloadsOnly: true,
      activeDownloadModelId: this.active?.modelId ?? null,
      recommendedDefaultModelId,
      models,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    };
  }

  async download(modelId: string): Promise<JsonValue> {
    const entry = this.entry(modelId);
    if (!entry || entry.releaseState !== "ready" || !entry.download || !entry.expectedSha256 || !entry.bytes) {
      throw new Error("That model has not passed Candor's verified download gate.");
    }
    if (this.active) throw new Error("Another verified model download is already active.");
    if (this.core.captureGuardPhase() !== "idle") {
      throw new Error("Finish the active recording before downloading a model.");
    }

    const active: ActiveDownload = {
      modelId,
      importId: null,
      bytesReceived: 0,
      request: null,
      cancelled: false,
    };
    this.active = active;
    try {
      const started = await requireResult(this.core, "models.importStart", {
        modelId,
        expectedBytes: entry.bytes,
        replace: true,
      });
      active.importId = stringField(started, "importId");
      if (!active.importId) throw new Error("Candor core did not create a model import.");

      const response = await responseFor(entry, active, this.options.requestHttps ?? defaultHttpsRequest);
      const rawContentLength = response.headers["content-length"];
      if (rawContentLength === undefined) {
        response.destroy();
        throw new Error("Model download did not provide a content length.");
      }
      const contentLength = Number(rawContentLength);
      if (!Number.isSafeInteger(contentLength) || contentLength !== entry.bytes) {
        response.destroy();
        throw new Error("Model download size did not match the packaged catalog.");
      }
      const digest = createHash("sha256");
      for await (const incoming of response) {
        if (active.cancelled) throw new Error("Model download was canceled.");
        const bytes = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
        for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, bytes.length));
          active.bytesReceived += chunk.length;
          if (active.bytesReceived > entry.bytes) throw new Error("Model download exceeded its packaged size.");
          digest.update(chunk);
          await requireResult(this.core, "models.importChunk", {
            importId: active.importId,
            dataBase64: chunk.toString("base64"),
          });
          this.publishProgress(entry, active.bytesReceived, "downloading");
        }
      }
      if (active.bytesReceived !== entry.bytes || digest.digest("hex") !== entry.expectedSha256) {
        throw new Error("Model download failed its packaged integrity check.");
      }
      if (active.cancelled) throw new Error("Model download was canceled.");
      this.publishProgress(entry, active.bytesReceived, "verifying");
      const accepted = await requireResult(this.core, "models.importFinish.start", { importId: active.importId });
      this.publishProgress(entry, active.bytesReceived, "verification-queued");
      return {
        ...accepted,
        modelId,
        bytesReceived: active.bytesReceived,
        expectedBytes: entry.bytes,
        integrityVerifiedBeforeInstall: true,
        rawPathExposed: false,
        keyMaterialExposedToRenderer: false,
      };
    } catch (error) {
      if (active.importId) {
        await this.core.call("models.importAbort", { importId: active.importId }).catch(() => undefined);
      }
      this.publishProgress(entry, active.bytesReceived, active.cancelled ? "canceled" : "failed");
      throw error;
    } finally {
      active.request?.destroy();
      if (this.active === active) this.active = null;
    }
  }

  cancel(modelId?: string): JsonValue {
    if (!this.active || (modelId && this.active.modelId !== modelId)) {
      return { canceled: false, activeModelId: this.active?.modelId ?? null, rawPathExposed: false, keyMaterialExposedToRenderer: false };
    }
    this.active.cancelled = true;
    this.active.request?.destroy(new Error("Model download was canceled."));
    return { canceled: true, activeModelId: this.active.modelId, rawPathExposed: false, keyMaterialExposedToRenderer: false };
  }

  cancelForCapture(): void {
    this.cancel();
  }

  private publishProgress(entry: TrustedModelCatalogEntry, bytesReceived: number, state: string): void {
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send("candor-events:model-download-progress", {
      modelId: entry.modelId,
      state,
      bytesReceived,
      totalBytes: entry.bytes,
      rawPathExposed: false,
      keyMaterialExposedToRenderer: false,
    });
  }
}
