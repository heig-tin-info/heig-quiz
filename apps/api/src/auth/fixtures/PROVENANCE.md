# Provenance of `launch.seb` and `launch-unlock.seb`

The `.seb` Quiz served for the start URL
`https://quiz.example.org/app/auth/seb/s3cret-ticket_0`, written by
`apps/api/src/auth/seb.ts` as it stood before it moved onto `@quiz/seb`
(M6-02), then changed once by hand on purpose: the quit link (`quitURL`
`https://quiz.example.org/seb/quit`, `quitURLConfirm` false) after
`allowQuit`, 2026-10-08. `seb.snapshot.test.ts` pins its bytes
(SHA-256 `e894e40b575f008af40e8e81b2e4d9efc12157ebfa1b31a9d38a99a9704d5f2b`)
and its Config Key: a change to either is a change every SEB holding a file
would see. It is now the file of a project (D21), whose `.seb` carries no
unlock password in v1.

`launch-unlock.seb` is the same file with the unlock password of an
evaluation (ADR-027, addendum of 2026-11-06): `hashedQuitPassword`, the
SHA-256 of `cde234`, right after `quitURLConfirm`. Written once by
`sebConfig(url, [], "cde234")` on 2026-11-06 and pinned by the same test
(SHA-256 `779072d1bd7906b8c90c3b9f9468d257ff73733b4a1ed7e871edbb7959ffa27b`).

The Moodle vectors that used to sit here (`seb-json-mac-001.txt`, the
201-key SEB-JSON string) moved to `packages/seb/src/fixtures/`, with their
provenance.
