/**
 * The teacher's update in a staging repository (ADR-132 §11 owns the rule):
 * one branch's commit, set by its sha on `refs/quiz/update/<branch>`, never a
 * branch. Host git runs on `staging.git` only (the portal's invariant 13).
 */
import { Sha1 } from "@quiz/contracts";

import { serializer } from "../serializer.js";
import { gitAuthEnv, gitBare } from "./gitRunner.js";
import { guardPortalRefs, PORTAL_REFS } from "./staging.js";

/** Where a branch's update lands. */
export const updateRef = (branch: string): string => `${PORTAL_REFS}/update/${branch}`;

/** One fetch of the update never takes longer: GitHub down must not hold anything for long. */
export const UPDATE_FETCH_TIMEOUT_MS = 60_000;

export interface UpdateHead {
  branch: string;
  sha: string;
}

export interface FetchUpdateOptions {
  gitDir: string;
  /** The student's repository on the forge, where the sync pushed the commit on `sync/<branch>`. */
  url: string;
  head: UpdateHead;
  /** The forge's `Authorization`, asked for only when the commit must come from the forge. */
  authorize?: () => Promise<string | undefined>;
  /** The fetch that used an authorization is over (`Forge.settle`). */
  settle?: (authorization: string) => void;
  timeoutMs?: number;
}

/** Whether the branch's update ref is at `sha`: the one reader of the ref, and what `push-status` asks. */
export async function updateAt(gitDir: string, branch: string, sha: string): Promise<boolean> {
  const found = await gitBare(gitDir, ["rev-parse", "--verify", "--quiet", updateRef(branch)]).catch(() => "");
  return found.trim() === sha;
}

const oneAtATime = serializer();

/**
 * Brings the branch's update ref to `head.sha`, one call at a time per
 * staging repository: `current` when it is there already; `local` when the
 * repository holds the commit (a seeding that mirrored `sync/<branch>`), set
 * with no token and no network; otherwise one fetch by sha (`fetched`).
 * Throws on a failure, the ref left as it was.
 */
export function fetchProjectUpdate(opts: FetchUpdateOptions): Promise<"current" | "local" | "fetched"> {
  const { gitDir, head } = opts;
  // The refspec's left side: a full sha, never anything git would read otherwise.
  if (!Sha1.safeParse(head.sha).success) return Promise.reject(new Error("invalid update sha"));
  const ref = updateRef(head.branch);
  return oneAtATime(gitDir, async () => {
    if (await updateAt(gitDir, head.branch, head.sha)) return "current";
    // A staging repository seeded before this rule existed gets it here.
    await guardPortalRefs(gitDir);
    const held = await gitBare(gitDir, ["cat-file", "-e", `${head.sha}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (held) {
      await gitBare(gitDir, ["update-ref", ref, head.sha]);
      return "local";
    }
    const authorization = await opts.authorize?.();
    try {
      await gitBare(gitDir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", opts.url, `+${head.sha}:${ref}`], {
        ...(authorization ? { env: gitAuthEnv(authorization, opts.url) } : {}),
        timeoutMs: opts.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS,
      });
    } finally {
      if (authorization) opts.settle?.(authorization);
    }
    return "fetched";
  });
}
