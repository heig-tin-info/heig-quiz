/**
 * Section 1a — the session: who this browser is, and the public config the
 * shell reads before anything else.
 */
import type {
  Me,
  PublicConfig,
} from "@quiz/contracts";
import {
  H,
  MockError,
  iso,
  on,
  role,
} from "./runtime";

// --- Session ---

export let me: Me | null = {
  id: "u-me",
  email: role === "student" ? "lea.rochat@heig-vd.ch" : `${role}@heig-vd.ch`,
  givenName: role === "student" ? "Léa" : role === "admin" ? "Admin" : "Prof",
  familyName: role === "student" ? "Rochat" : "Démo",
  role,
  lastLoginAt: iso(-3 * H),
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: null,
  mcqPolicy: null,
};

/**
 * The one way another section changes the session: `?as=guest` on the poll
 * page signs this browser out (section 6). An ES module cannot assign to an
 * imported binding, so the write stays here and the read stays live.
 */
export const setMe = (next: Me | null) => {
  me = next;
};

on("GET", "/app/api/config", (): PublicConfig => ({ devLogin: true }));

on("GET", "/app/api/me", () => {
  if (!me) throw new MockError(401, "Signed out");
  return me;
});
on("PATCH", "/app/api/me", (_m, body) => {
  if (me) me = { ...me, ...(body as Partial<Me>) };
  return me;
});
on("PUT", "/app/api/me/avatar", () => undefined);
on("DELETE", "/app/api/me/avatar", () => undefined);
on("POST", "/app/auth/logout", () => {
  me = null;
  return undefined;
});
