import path from "node:path";
import { pathToFileURL } from "node:url";

export interface RendererNavigationPolicy {
  readonly useDevRenderer: boolean;
  readonly rendererDevUrl: string;
  readonly rendererFilePath: string;
  readonly rendererFileUrl: string;
  isDevRequest(value: string): boolean;
  isNavigationAllowed(value: string): boolean;
}

interface RendererNavigationPolicyOptions {
  isDev: boolean;
  electronOutputDir: string;
  configuredDevUrl?: string;
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function createRendererNavigationPolicy(
  options: RendererNavigationPolicyOptions,
): RendererNavigationPolicy {
  const configuredDevUrl = options.configuredDevUrl?.trim() ?? "";
  if (configuredDevUrl && !isLoopbackHttpUrl(configuredDevUrl)) {
    throw new Error("CANDOR_V3_RENDERER_URL must use loopback HTTP without credentials.");
  }

  const useDevRenderer = options.isDev && configuredDevUrl.length > 0;
  const rendererDevUrl = configuredDevUrl || "http://127.0.0.1:5173";
  const rendererDevEndpoint = new URL(rendererDevUrl);
  const rendererFilePath = path.join(options.electronOutputDir, "..", "renderer", "index.html");
  const rendererFileUrl = pathToFileURL(rendererFilePath).href;

  return Object.freeze({
    useDevRenderer,
    rendererDevUrl,
    rendererFilePath,
    rendererFileUrl,
    isDevRequest(value: string): boolean {
      if (!useDevRenderer) return false;
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "ws:") &&
          url.hostname === rendererDevEndpoint.hostname &&
          url.port === rendererDevEndpoint.port
        );
      } catch {
        return false;
      }
    },
    isNavigationAllowed(value: string): boolean {
      if (useDevRenderer) {
        try {
          const url = new URL(value);
          return url.protocol === "http:" && url.origin === rendererDevEndpoint.origin;
        } catch {
          return false;
        }
      }
      return value === rendererFileUrl || value.startsWith(`${rendererFileUrl}#`);
    },
  });
}
