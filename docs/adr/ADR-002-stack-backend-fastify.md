# ADR-002 — Node.js + TypeScript + Fastify backend

## Status

Accepted (2026-07-03, inherited from heig-classroom). The language/framework
choice remains; version pins and integration mechanisms below describe Quiz.
The [inherited record](history/ADR-002-stack-backend-fastify.md) preserves the original library shortlist.

## Context

One maintainer needs readable control flow and shared types across the API,
SPA and tools, including GitHub and OIDC integrations.

## Decision

1. Strict TypeScript and Node.js, with Zod contracts in `packages/contracts`.
   Runtime and compiler versions belong to `package.json`, workspace manifests,
   `pnpm-lock.yaml` and the Dockerfiles, not a second dependency list in this ADR.
2. Fastify, explicit plugin/service wiring, no DI framework or decorators.
   Routes validate with shared contracts; `modules/guards.ts` loads authorized
   entities. Access rules are the invariants in `CLAUDE.md`.
3. Quiz uses Octokit, `openid-client` and Fastify's structured logging.
   The installed dependencies are in `apps/api/package.json`; webhook HMAC,
   request validation and rate limits are implemented in the corresponding
   auth/GitHub modules, not guaranteed by the libraries once proposed here.

## Consequences

Client and server share schemas, while module discipline stays explicit.
Development can use Keycloak for real OIDC independently of institutional
configuration. The inherited Swagger/type-provider/Luxon dependency proposals
are not evidence that those packages or generated clients exist in Quiz.

## Rejected alternatives

NestJS would add framework indirection; another backend language would lose
shared contracts. No second route-contract framework is needed merely to
duplicate Zod. See the inherited rationale before reconsidering those choices.
