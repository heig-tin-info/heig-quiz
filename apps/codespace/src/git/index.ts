/**
 * Git channel (P3). Public surface for the rest of the portal:
 *
 *   ensureStagingRepo  seeds <volume>/staging.git from the right source
 *   startGitServer     the Fastify server of `gitBackendPlugin`, on its own port (9418)
 *   createRelayWorker  the background push to the forge
 *
 * Only what the rest of the portal imports is re-exported here; the tests of
 * this directory import the files beside it directly.
 *
 * See README.md in this directory for the development commands.
 */
// `db.ts` is gone in V1: the database is the portal's own (`db/client.ts`).
export {
  createForgejoForge,
  createUnconfiguredGithubForge,
  ForgeUnconfiguredError,
  type Forge,
  type ForgeOwner,
} from "./forge.js";
export { createQuizForge, type QuizForgeOptions } from "./quizForge.js";
export { git, gitBare, redactSecrets } from "./gitRunner.js";
export { startGitServer } from "./httpBackend.js";
export {
  createPushEventStore,
  lastRejectedPush,
  type PushEventStore,
  type RejectedPush,
} from "./pushEvents.js";
export { createRelayWorker, stagingTargets, type RelayWorker } from "./relay.js";
export {
  ensureStagingRepo,
  refSnapshot,
  stagingHeadBranch,
  stagingPaths,
  type StagingPaths,
  type StagingResult,
  type StagingSource,
} from "./staging.js";
export type { RepoRef, SessionLookup, StagingSession } from "./types.js";
