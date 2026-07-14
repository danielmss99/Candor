# Claude review reconciliation

Date: 2026-07-14

Codex requested independent, focused Claude reviews of the Rust job and capture boundary and of the dictionary, Electron, UI, and release boundary. Both reviews completed through the authenticated collaboration helper. Claude reported six defects. All six were validated against the repository and accepted.

## Findings and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| High | A concurrent pause or start transition could overwrite cancellation. | Fixed. Terminal and cancellation states now guard pause, queue, run, and shutdown transitions. A race regression test proves cancellation remains terminal. |
| Medium | A large dictionary descriptor could exceed the encrypted job-store capacity and poison later persistence. | Fixed. Submission projects serialized store size before mutation and returns `JOB_STORE_CAPACITY`. A regression test proves normal jobs still run after capacity is reclaimed. |
| Medium | ZIP checks trusted declared sizes before unbounded decompression. | Fixed. Every archive member is read through an actual output-byte cap, and limits use actual bytes. A bounded-reader regression test was added. |
| Medium | Standard packaging did not reject an extra full `large-v3` model. | Fixed. Profile membership is now enforced for every speech model in the host bundle. The verifier self-test covers a Maximum-only model in Standard. |
| Low | Re-importing the same dictionary package ID ignored a newer version. | Fixed. The core reports installed and available versions and the UI explicitly reports that the installed version was kept. Encrypted-store tests prove no silent replacement occurs. |
| Low | Background job buttons did not identify their job to assistive technology. | Fixed. Cancel all, open, cancel, retry, and dismiss actions now have contextual accessible names with markup tests. |

## Follow-up review status

Because the high-severity concurrency finding was material, Codex requested a focused Claude re-review of only the fixes. The authenticated Claude CLI began the review but returned HTTP 429 after reaching the account session limit. The collaboration helper saved the exact failure in `claude-fix-rereview.md` instead of claiming a completed review.

The unresolved external review retry does not replace repository verification. Formatting, strict Clippy, 148 Rust tests, 155 renderer tests, TypeScript checking, the full Electron build, five Playwright Electron tests, source security mutation tests, architecture checks, identity checks, and AI bundle verifier tests all pass after the fixes.
