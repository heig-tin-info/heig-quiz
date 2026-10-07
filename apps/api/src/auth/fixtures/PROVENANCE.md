# Provenance of `launch.seb`

The `.seb` Quiz served for the start URL
`https://quiz.example.org/app/auth/seb/s3cret-ticket_0`, written by
`apps/api/src/auth/seb.ts` as it stood before it moved onto `@quiz/seb`
(M6-02), and never regenerated since. `seb.snapshot.test.ts` pins its bytes
(SHA-256 `2a4c6f820bf00ed9e092e9467f1fac59727ee982be29b0309dcfd1b8272a464d`)
and its Config Key: a change to either is a change every SEB holding a file
would see.

The Moodle vectors that used to sit here (`seb-json-mac-001.txt`, the
201-key SEB-JSON string) moved to `packages/seb/src/fixtures/`, with their
provenance.
