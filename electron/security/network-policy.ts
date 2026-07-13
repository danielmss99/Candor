import { session, type CommandLine } from "electron";
import type { JsonValue } from "../core/json.js";

export class NetworkGuard {
  private totalRequests = 0;
  private localAllowedRequests = 0;
  private externalAllowedRequests = 0;
  private blockedRequests = 0;
  private readonly blockedSamples: string[] = [];
  private deniedWindowOpenRequests = 0;
  private deniedNavigationRequests = 0;
  private readonly deniedNavigationSamples: string[] = [];

  recordRequest(value: string, isDevRequest: boolean): boolean {
    this.totalRequests += 1;
    const url = new URL(value);
    const allowed =
      url.protocol === "file:" ||
      url.protocol === "devtools:" ||
      url.protocol === "data:" ||
      isDevRequest;
    if (allowed) {
      if (isDevRequest) this.externalAllowedRequests += 1;
      else this.localAllowedRequests += 1;
    } else {
      this.blockedRequests += 1;
      if (this.blockedSamples.length < 5) {
        this.blockedSamples.push(`${url.protocol}//${url.hostname}`);
      }
    }
    return allowed;
  }

  recordWindowOpen(value: string): void {
    this.deniedWindowOpenRequests += 1;
    if (this.deniedNavigationSamples.length < 5) {
      const category = value.startsWith("file:") ? "local-file" : "external";
      this.deniedNavigationSamples.push(`window-open-denied:${category}`);
    }
  }

  recordNavigation(value: string): void {
    this.deniedNavigationRequests += 1;
    if (this.deniedNavigationSamples.length < 5) {
      const category = value.startsWith("file:") ? "local-file" : "external";
      this.deniedNavigationSamples.push(`navigation-denied:${category}`);
    }
  }

  snapshot(): JsonValue {
    return {
      totalRequests: this.totalRequests,
      localAllowedRequests: this.localAllowedRequests,
      externalAllowedRequests: this.externalAllowedRequests,
      blockedRequests: this.blockedRequests,
      blockedSamples: [...this.blockedSamples],
      deniedWindowOpenRequests: this.deniedWindowOpenRequests,
      deniedNavigationRequests: this.deniedNavigationRequests,
      deniedNavigationSamples: [...this.deniedNavigationSamples],
    };
  }
}

export function applyChromiumNetworkPolicy(commandLine: CommandLine, smokeMode: boolean): void {
  commandLine.appendSwitch("disable-background-networking");
  commandLine.appendSwitch("disable-component-update");
  commandLine.appendSwitch("disable-domain-reliability");
  commandLine.appendSwitch("disable-features", "AutofillServerCommunication,OptimizationHints");
  commandLine.appendSwitch("no-proxy-server");
  commandLine.appendSwitch("disable-sync");
  if (smokeMode) commandLine.appendSwitch("disable-gpu");
}

export function installSessionHardening(
  guard: NetworkGuard,
  isDevRequest: (value: string) => boolean,
): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !guard.recordRequest(details.url, isDevRequest(details.url)) });
  });
}
