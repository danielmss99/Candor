# Security Policy

## Supported Versions

Candor is in alpha. Security fixes are applied to the current `main` branch and the newest public alpha build.

## Reporting A Vulnerability

Do not open a public issue for suspected vulnerabilities involving calendar tokens, local files, audio recordings, installers, or update channels.

Send a private report to the project maintainer before public disclosure. Include:

- Candor version and operating system
- Steps to reproduce
- Impact and affected data
- Any proof-of-concept files or logs that do not expose other users' private data

Until a public security contact is published, alpha testers should report issues directly to the maintainer who provided the build.

## Security Commitments

- Calendar credentials must use operating-system secret storage where available.
- Calendar integrations request write access only for user-initiated create, edit, and delete event flows.
- Calendar write payloads must be validated in the backend, since the renderer is not a security boundary.
- iCloud CalDAV requests must stay under the connected calendar home URL before Candor sends Apple credentials.
- Meeting audio, transcripts, and notes should remain local by default.
- Any cloud or webhook feature must be opt-in and clearly labeled before release.
- Release builds must be signed before broad distribution.
- Downloaded speech models must pass SHA-256 verification before use.
