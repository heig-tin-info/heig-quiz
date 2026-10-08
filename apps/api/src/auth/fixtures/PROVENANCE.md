# Provenance of `launch.seb`

The `.seb` Quiz served for the start URL
`https://quiz.example.org/app/auth/seb/s3cret-ticket_0`, written by
`apps/api/src/auth/seb.ts` as it stood before it moved onto `@quiz/seb`
(M6-02), then changed once by hand on purpose: the quit link (`quitURL`
`https://quiz.example.org/seb/quit`, `quitURLConfirm` false) after
`allowQuit`, 2026-10-08. `seb.snapshot.test.ts` pins its bytes
(SHA-256 `e894e40b575f008af40e8e81b2e4d9efc12157ebfa1b31a9d38a99a9704d5f2b`)
and its Config Key: a change to either is a change every SEB holding a file
would see.

The Moodle vectors that used to sit here (`seb-json-mac-001.txt`, the
201-key SEB-JSON string) moved to `packages/seb/src/fixtures/`, with their
provenance.
