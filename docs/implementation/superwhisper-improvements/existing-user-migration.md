# Existing User Setup Migration

Candor snapshots upgrade evidence in Electron main before starting `candor-core`.
This ordering matters because a first-run core handshake can create Candor's
local data root.

The migration runs only when `desktop-preferences.json` does not exist. It
persists `setup.nonBlockingUpgrade` as either `true` or `false`, so later
launches never reinterpret newly created files as legacy evidence.

Schema-v2 and schema-v3 desktop preferences already contain explicit setup
state. Their migration preserves that state and initializes
`nonBlockingUpgrade` to `false` instead of overriding an in-progress first run.

Evidence is intentionally limited to Candor-owned footprints:

- the exact pre-existing Candor v3 core data root;
- known children such as recordings, settings, consent, models, keys, vault,
  recovery, search, or deletion state;
- Electron's encrypted `license-state.bin`; or
- Electron's fixed capture-recovery record.

Generic Electron user-data directories, Chromium caches, arbitrary files, and
symlinks do not qualify. Test and smoke harnesses pre-create their temporary
root, so those modes require a known Candor child instead of root existence.

If the first atomic write fails transiently, the service retains the pre-core
decision in memory and retries publication on the next serialized preferences
operation. It never re-runs detection after the core handshake in that process.

The renderer receives only the persisted boolean and custody sentinels. It does
not receive evidence names or filesystem paths. A non-blocking upgrade opens
the workspace even with an empty visible library or only quarantined meetings,
then shows the one-time Finish device setup prompt until its dismissal is
persisted.
