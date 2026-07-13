import { useCallback, useEffect, useState } from "react";
import { asObject, asString, type JsonObject } from "../../core/contracts";

type LicenseApi = NonNullable<Window["candor"]>["license"];

export function isLicenseActive(status: JsonObject): boolean {
  const state = asString(status.state, "inactive");
  return state === "activated" || state === "trial";
}

export function useLicenseState(licenseApi: LicenseApi | undefined, onLoadError: (message: string) => void) {
  const [status, setStatus] = useState<JsonObject>({});
  const [portalInfo, setPortalInfo] = useState<JsonObject>({});
  const [loaded, setLoaded] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseEmail, setLicenseEmail] = useState("");
  const [licenseKeyTouched, setLicenseKeyTouched] = useState(false);
  const [promptDismissed, setPromptDismissed] = useState(false);

  const reload = useCallback(async () => {
    if (!licenseApi) {
      setLoaded(true);
      return;
    }
    const [nextStatus, nextPortal] = await Promise.all([licenseApi.status(), licenseApi.portalInfo()]);
    setStatus(asObject(nextStatus));
    setPortalInfo(asObject(nextPortal));
    setLoaded(true);
  }, [licenseApi]);

  useEffect(() => {
    void reload().catch((reason) => {
      setLoaded(true);
      onLoadError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [onLoadError, reload]);

  const activate = useCallback(async () => {
    if (!licenseApi) return status;
    setLicenseKeyTouched(true);
    if (!licenseKey.trim()) throw new Error("Enter a license key or start a local trial.");
    const next = asObject(await licenseApi.activate({
      licenseKey: licenseKey.trim(),
      purchaserEmail: licenseEmail.trim() || undefined,
    }));
    setStatus(next);
    await reload();
    return next;
  }, [licenseApi, licenseEmail, licenseKey, reload, status]);

  const startTrial = useCallback(async () => {
    if (!licenseApi) return status;
    const next = asObject(await licenseApi.startTrial());
    setStatus(next);
    await reload();
    return next;
  }, [licenseApi, reload, status]);

  const deactivate = useCallback(async () => {
    if (!licenseApi) return status;
    const next = asObject(await licenseApi.deactivateDevice());
    setStatus(next);
    setPromptDismissed(true);
    await reload();
    return next;
  }, [licenseApi, reload, status]);

  return {
    status,
    portalInfo,
    loaded,
    licenseKey,
    licenseEmail,
    licenseKeyTouched,
    promptDismissed,
    active: isLicenseActive(status),
    state: asString(status.state, "inactive"),
    setLicenseKey,
    setLicenseEmail,
    setLicenseKeyTouched,
    setPromptDismissed,
    reload,
    activate,
    startTrial,
    deactivate,
  };
}
