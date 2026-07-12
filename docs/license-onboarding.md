# Candor Purchase and Activation Onboarding

Candor now uses purchase-and-activation onboarding instead of a sign-up-first flow.

## Current behavior

- Fresh installs show `Welcome to Candor` with `Activate License` and `Start Trial`.
- Normal app use does not require a persistent account.
- License state is owned by the Electron main process and exposed to the renderer only through named IPC actions.
- The local activation record is written under Electron app data and encrypted with Electron `safeStorage` when OS encryption is available.
- If OS encryption is unavailable, Candor stores only pathless, non-secret entitlement metadata locally.
- Development activation accepts `CANDOR-DEV-*` keys in dev builds, or when `CANDOR_ENABLE_MOCK_LICENSE=1` is set.
- Production activation verification is marked as pending until the licensing backend exists.

## First-run setup sequence

After activation or local trial start, onboarding continues through:

1. `Candor is yours`
2. Microphone recording consent
3. System-audio consent when the OS capture path supports it
4. Protected local vault setup
5. Local AI model setup, with fast local fallback allowed

The setup flow reuses the existing local consent, vault, and model services. It does not create a cloud profile.

## License Portal scope

Settings includes an optional `License Portal` section for:

- Viewing local license status
- Deactivating the current device
- Downloading installers
- Downloading receipts
- Future paid major upgrades

Only local status and device deactivation are implemented today. Installer downloads, receipts, and upgrade purchase flows require the production portal.

## Remaining production decisions

- Choose the production license provider or build an internal license verification service.
- Decide whether activation should be fully offline, online with a long offline grace period, or a hybrid.
- Define the device activation limit and user-facing device reset policy.
- Decide how purchased installers and receipts are delivered without requiring sign-in inside the desktop app.
- Define how paid major upgrades work for perpetual Candor 1 licenses.
- Decide whether license keys are transferable and how deactivation works when a device is lost.
- Add code-signing and tamper-resistance checks around production activation responses.
- Add a custom storage-location picker if Candor should support user-selected vault roots beyond the protected default.
