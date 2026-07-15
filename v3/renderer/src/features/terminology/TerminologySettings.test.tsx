import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TerminologyDictionaryRow, TerminologyStatus } from "../../core/contracts";
import { TerminologySettings } from "./TerminologySettings";

function dictionary(trustLabel: string | null): TerminologyDictionaryRow {
  return {
    dictionaryId: "pharmaceutics",
    name: "Pharmaceutics",
    enabled: true,
    assignedToRecording: false,
    entryCount: 100,
    packageId: "candor.pharmaceutics",
    packageVersion: "1.0.0",
    publisher: "Example publisher",
    language: "en",
    signatureKeyId: "example-key",
    trustLabel,
    signatureVerified: true,
    scope: "specialist",
    scopeTargetId: null,
    explicitPreference: 0,
    approvedCorrectionCount: 0,
  };
}

function renderStatus(row: TerminologyDictionaryRow): string {
  const status: TerminologyStatus = {
    state: "ready",
    dictionaryCount: 1,
    entryCount: row.entryCount,
    dictionaries: [row],
    encryptedAtRest: true,
    projectScopeAvailable: false,
  };
  return renderToStaticMarkup(
    <TerminologySettings
      status={status}
      proposals={[]}
      selectedRecordingId=""
      busy={false}
      onImport={vi.fn()}
      onSetEnabled={vi.fn()}
      onAssignToMeeting={vi.fn()}
      onReview={vi.fn()}
      onDecide={vi.fn()}
    />,
  );
}

describe("TerminologySettings trust labels", () => {
  it("shows Candor verification only for the exact allowlisted trust value", () => {
    expect(renderStatus(dictionary("verified-candor"))).toContain("Verified by Candor");
  });

  it("downgrades unknown trust values instead of displaying an endorsement", () => {
    const markup = renderStatus(dictionary("super-verified"));
    expect(markup).toContain("Community pack - unverified");
    expect(markup).not.toContain("super-verified");
    expect(markup).not.toContain("Verified by Candor");
  });
});
