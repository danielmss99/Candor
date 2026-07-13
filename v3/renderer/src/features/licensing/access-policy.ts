export interface LicenseAccessContext {
  licenseAvailable: boolean;
  licenseActive: boolean;
  promptDismissed: boolean;
  existingRecordingCount: number;
}

export function shouldShowActivationPrompt(context: LicenseAccessContext): boolean {
  return context.licenseAvailable
    && !context.licenseActive
    && !context.promptDismissed
    && context.existingRecordingCount === 0;
}

export function canAccessExistingData(_licenseActive: boolean): true {
  return true;
}

