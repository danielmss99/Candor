import { useCallback, useState } from "react";
import { asBool, asObject, asString, type JsonObject } from "../../core/contracts";
import type { RunOperation } from "../jobs/useOperationRunner";

type ShellApi = NonNullable<Window["candor"]>["shell"];

interface UseDiagnosticExportOptions {
  api: ShellApi | undefined;
  run: RunOperation;
  setNotice(message: string): void;
}

export function useDiagnosticExport({ api, run, setNotice }: UseDiagnosticExportOptions) {
  const [preview, setPreview] = useState<JsonObject | null>(null);

  const prepare = useCallback(async () => {
    if (!api) return;
    await run("diagnostics", async () => {
      setPreview(asObject(await api.diagnosticsPreview()));
      setNotice("Diagnostic preview prepared without meeting content");
    }, "diagnostics-preview");
  }, [api, run, setNotice]);

  const save = useCallback(async () => {
    if (!api) return;
    await run("diagnostics", async () => {
      const result = asObject(await api.diagnosticsSaveLocal());
      if (asBool(result.canceled)) {
        setNotice("Diagnostic export canceled");
        return;
      }
      setNotice(`Saved ${asString(result.fileName, "diagnostic report")} without meeting content`);
    }, "diagnostics-save");
  }, [api, run, setNotice]);

  return { preview, prepare, save };
}
