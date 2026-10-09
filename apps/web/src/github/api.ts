/**
 * The web side of the `github` module's reads (M2-02, M2-03), shared by the
 * classroom's Settings, its header and the user Settings card.
 *
 * The routes exist only on a platform with Quiz's GitHub App configured:
 * without one, every one of them answers 404, and `githubAbsent` is how a
 * screen tells that from a failure — it then shows no GitHub at all, as a
 * classroom that was never connected looks (F-ORG-13).
 */
import { useQuery } from "@tanstack/react-query";

import type { GithubAccountState, GithubClassroom, GithubOrg } from "@quiz/contracts";

import { api, isNotFound } from "../api";
import { classroomGithubKey, githubOrgsKey, meGithubKey } from "../queryKeys";

/** The route is not there: no App on this platform (or, for a classroom, not ours). */
export const githubAbsent = isNotFound;

/** `GET /classrooms/:id/github`: the link and its checks, re-read when the Settings open (F-GH-03). */
export function useClassroomGithub(id: string) {
  return useQuery<GithubClassroom>({
    queryKey: classroomGithubKey(id),
    queryFn: () => api(`/app/api/classrooms/${id}/github`),
  });
}

/** `GET /github/orgs`: the organizations the App is installed on, for the connect sheet. */
export function useGithubOrgs() {
  return useQuery<GithubOrg[]>({
    queryKey: githubOrgsKey,
    queryFn: () => api("/app/api/github/orgs"),
  });
}

/** `GET /me/github`: the caller's own link, for the user Settings card. */
export function useGithubAccount() {
  return useQuery<GithubAccountState>({
    queryKey: meGithubKey,
    queryFn: () => api("/app/api/me/github"),
  });
}

/**
 * Where "Link GitHub" goes: the App's authorisation, back to `returnTo` (the
 * page the user starts from, F-GH-05). The server keeps only a safe
 * same-origin path and falls back to `/settings` otherwise.
 */
export function githubLinkHref(returnTo: string): string {
  return `/app/auth/github/link?return=${encodeURIComponent(returnTo)}`;
}
