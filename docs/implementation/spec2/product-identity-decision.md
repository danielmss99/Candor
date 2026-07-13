# Product identity decision

## Public identity

- Product name: `Candor`
- Application version: `0.4.0`
- Window title: `Candor`
- Installer title: `Candor`
- Core, protocol, schema, and product versions remain independent.

The repository previously used `2.0.0` as an internal architecture-generation value.
No published GitHub release or product version tag was found when `0.4.0` was selected.
Even so, a locally installed prerelease may exist. The clean-machine matrix must test
that exact previous installer. If Windows treats `0.4.0` as a downgrade or creates a
parallel installation, the beta must stop and use a tested bridge-installer strategy.
The version change alone is not migration proof.

## Installer ID

The installed application currently uses `com.candor.v3`. The preferred stable ID is
`com.candor.desktop`, but that migration is deferred until an upgrade test proves all
of the following with a previously released Electron installer:

1. The new installer upgrades the existing application instead of creating a second copy.
2. Existing user data opens without copying, renaming, or deletion.
3. Existing recordings remain openable, exportable, and deletable.
4. Uninstall preserves user data according to the documented policy.
5. Rollback to the prior prerelease does not alter the local data directory.

Changing the ID before this proof would turn a cosmetic cleanup into a data-access risk.
The product identity verifier therefore requires the current app ID and Windows App
User Model ID to match while the migration remains deferred.
