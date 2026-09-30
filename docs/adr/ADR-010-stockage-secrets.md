# ADR-010 — Secrets outside the repository and outside the database, in an encrypted institutional vault

## Status

Accepted (2026-07-03, phase 3). **Amended for quiz:** the principle (secrets in
the environment, never in the repository, an image or the database; no secret
in the logs) applies as written, but the GitHub App private key, the GitHub
OAuth and webhook secrets and the runner registration PAT (ADR-007) are
heig-classroom's and do not exist here. Quiz's secrets are the database
password (`POSTGRES_PASSWORD`), the OIDC client secret or private key
(`OIDC_CLIENT_SECRET`, `OIDC_PRIVATE_KEY_PATH`), the cookie secret, the
runner's shared token (`RUNNER_TOKEN`, ADR-016), the metrics token, and the
notification credentials (`SCW_SECRET_KEY`, `TEAMS_CLIENT_SECRET`, ADR-030);
`.env.prod.example` and `apps/api/src/config.ts` are the full list.

**Amended again (2026-09-30, ADR-035, the classroom merge):** the GitHub
secrets come back, as those of **Quiz's own GitHub App** (D23), not
classroom's: the App's private key (`GITHUB_APP_PRIVATE_KEY_PATH`, the PEM
mounted read-only), the webhook secret (`GITHUB_WEBHOOK_SECRET`) and the
App's OAuth client secret (`GITHUB_APP_CLIENT_SECRET`), beside
`GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_CLIENT_ID`. Staging holds
its own App's, never production's (ADR-028). Point 3's two-key rotation
applies to Quiz's App as written. The online workspace (ADR-047) adds the
codespace launch secret (`CODESPACE_LAUNCH_SECRET`, at least 32
characters, the same on both sides, refused without `CODESPACE_URL` and
as `change-me`), set only when phase M6 ships. The runners PAT of
ADR-007 stays on classroom's runner VM and never reaches Quiz. All of them
go into the age-encrypted vault of point 2.

## Context

Server secrets: the PEM private key of the GitHub App, the OIDC and GitHub OAuth client
secrets, the webhook secret, the cookie secret, the runner registration PAT (ADR-007). AU-43
requires that they come from the environment or from a secret manager, "never from the
repository nor from the database". The restore runbook (RTO 4 h, NFR-16) must be able to
reinject them reproducibly.

## Decision

1. **At runtime**: environment files on the VM (owned by root, permissions 600), the PEM key
   mounted read-only in the container; never in an image, a git repository or the database.
2. **For recovery**: an **age-encrypted** backup copy of each secret in the institutional
   vault (HEIG Vaultwarden or equivalent), referenced by the runbook; restoring is a script
   that decrypts and puts the files back.
3. **Rotation documented in the runbook**: the GitHub App accepts **two active private keys**
   during the switchover (generate, deploy, revoke the old one); the same interruption-free
   switchover procedure applies to the teacher API keys (AU-40) and to the runners PAT
   (12-month expiry).
4. **No secret in the logs**: dedicated pino serializers mask keys beyond their prefix, the
   OAuth `code`, cookies and `Authorization` headers (AU-41).

## Consequences

- A strict reading of AU-43 is satisfied: nothing in the repository, not even encrypted.
- Restoring depends on no human memory: the vault and the script make the RTO reproducible
  (the "manual KeePass" weakness is fixed).
- The compromise of a secret has a written response: immediate revocation on the GitHub or
  IdP side, rotation through the two-key procedure.

## Rejected alternatives

1. **sops/age secrets committed to the infrastructure repository** (productivity and
   robustness proposals): practical and versioned, but in literal tension with AU-43 ("never
   from the repository"); the encrypted copy therefore lives in a separate vault, not in git.
2. **A dedicated Vault (HashiCorp or equivalent)**: one more stateful service to operate and
   back up, out of proportion for about a dozen secrets.
3. **Secrets in the database**: forbidden by AU-43 and pointless — the database is backed up
   off site, which would widen the exposure surface.
