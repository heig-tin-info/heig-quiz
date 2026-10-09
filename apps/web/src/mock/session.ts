/**
 * Section 1a — the session: who this browser is, and the public config the
 * shell reads before anything else.
 */
import type {
  ApiToken,
  ApiTokenCreated,
  ChangelogAudience,
  ChangelogList,
  Me,
  OAuthConnection,
  OAuthRequestView,
  PublicConfig,
  SuperPowersState,
} from "@quiz/contracts";
import {
  D,
  H,
  MockError,
  flags,
  iso,
  nextId,
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
  coach: { enabled: null, seen: [] },
  rpnCalculator: null,
  ...(flags.impersonating
    ? {
        session: {
          kind: "impersonation",
          evaluationId: null,
          projectId: null,
          readOnly: true,
          superPowersUntil: null,
          superPowersAvailable: false,
        },
      }
    : flags.sebproject && role === "student"
      ? {
          // D21 (M6-07): inside SEB, confined to the student's `online_seb`
          // project (`STUDENT_PROJECT_INVITED` of `mock/student.ts`).
          session: {
            kind: "seb",
            evaluationId: null,
            projectId: "77777777-7777-4777-8777-777777777705",
            readOnly: false,
            superPowersUntil: null,
            superPowersAvailable: false,
          },
        }
      : role === "admin"
      ? {
          session: {
            kind: "portal",
            evaluationId: null,
            projectId: null,
            readOnly: false,
            superPowersUntil:
              flags.superpowers || flags.lastminutes
                ? iso(flags.lastminutes ? 4.5 * 60_000 : 54 * 60_000)
                : null,
            superPowersAvailable: true,
          },
        }
      : {}),
};

/** The session's Super Powers (ADR-054), switched like the real route: an hour, never extended. */
const setSuperPowers = (until: string | null): SuperPowersState => {
  if (!me) throw new MockError(401, "Signed out");
  if (me.role !== "admin") throw new MockError(403, "Forbidden");
  me = {
    ...me,
    session: {
      kind: "portal",
      evaluationId: null,
      projectId: null,
      readOnly: false,
      superPowersUntil: until,
      superPowersAvailable: true,
    },
  };
  return { superPowersUntil: until };
};
on("POST", "/app/api/me/super-powers", () => {
  if (me?.session?.superPowersUntil) throw new MockError(409, "Super Powers are already on");
  return setSuperPowers(new Date(Date.now() + H).toISOString());
});
on("DELETE", "/app/api/me/super-powers", () => setSuperPowers(null));

/**
 * The one way another section changes the session: `?as=guest` on the poll
 * page signs this browser out (section 6). An ES module cannot assign to an
 * imported binding, so the write stays here and the read stays live.
 */
export const setMe = (next: Me | null) => {
  me = next;
};

on("GET", "/app/api/config", (): PublicConfig => ({ devLogin: true, kiosk: { extensionId: null, mock: true } }));

on("GET", "/app/api/me", () => {
  if (!me) throw new MockError(401, "Signed out");
  return me;
});
on("PATCH", "/app/api/me", (_m, body) => {
  const { coachEnabled, ...rest } = body as Partial<Me> & { coachEnabled?: boolean | null };
  if (me) me = { ...me, ...rest };
  if (me && coachEnabled !== undefined) me = { ...me, coach: { ...me.coach, enabled: coachEnabled } };
  return me;
});
// The coach marks read so far: merged, or forgotten (`reset`).
on("POST", "/app/api/me/coach", (_m, body) => {
  const b = body as { seen?: string[]; reset?: true };
  if (!me) throw new MockError(401, "Signed out");
  const seen = b.reset ? [] : [...new Set([...me.coach.seen, ...(b.seen ?? [])])].sort();
  me = { ...me, coach: { ...me.coach, seen } };
  return { seen };
});
// --- What's new (ADR-087): two releases; the latest unseen under `?whatsnew=1` ---

type Entry = ChangelogList[number];
/** A release's rows, the persona's audience only: a student reads no teacher entry. */
const release = (liveAt: string, commitSha: string, rows: [ChangelogAudience, Entry["kind"], string, string][]) =>
  rows
    .filter(([audience]) => role !== "student" || audience === "student")
    .map(([, kind, en, fr], i): Entry => ({ id: `${commitSha}-${i}`, kind, text: { en, fr }, liveAt, commitSha }));
const LATEST = iso(-2 * H);
const changelog: ChangelogList = flags.empty || flags.impersonating
  ? []
  : [
      ...release(LATEST, "d9cfd51e4b7a", [
        ["student", "new", "After an update, a summary of what changed on the platform is shown once; find it again under **What's new** in your account menu.", "Après une mise à jour, un résumé des nouveautés s'affiche une fois ; retrouvez-le sous **Nouveautés** dans le menu de votre compte."],
        ["teacher", "moved", "Evaluation conditions now live in the course **Settings**.", "Les conditions d'évaluation se trouvent désormais dans les **Réglages** du cours."],
        ["teacher", "changed", "Course and pool cards show a larger icon.", "Les cartes des cours et des pools affichent une icône plus grande."],
      ]),
      ...release(iso(-9 * D), "79faa04f1c2d", [
        ["student", "changed", "A journal's task lists are drawn as a course plan.", "Les listes de tâches du journal sont présentées comme un plan de cours."],
        ["teacher", "deprecated", "The classroom join code is going away: share the classroom's link instead.", "Le code d'accès de la classe va disparaître : partagez plutôt le lien de la classe."],
      ]),
    ];
let changelogSeen = !flags.whatsnew;
on("GET", "/app/api/changelog", () => changelog);
on("GET", "/app/api/changelog/unseen", () => (changelogSeen ? [] : changelog.filter((e) => e.liveAt === LATEST)));
on("POST", "/app/api/me/changelog", () => {
  changelogSeen = true;
  return undefined;
});
on("PUT", "/app/api/me/avatar", () => undefined);
on("DELETE", "/app/api/me/avatar", () => undefined);
// --- Personal API tokens (ADR-022) ---

const tokens: ApiToken[] = flags.empty
  ? []
  : [
      {
        id: "t-claude",
        name: "Claude Desktop",
        prefix: "quiz_pat_Xk3v9Q",
        createdAt: iso(-12 * D),
        lastUsedAt: iso(-2 * H),
        expiresAt: iso(78 * D),
        revokedAt: null,
      },
      {
        id: "t-script",
        name: "Import script",
        prefix: "quiz_pat_b7TzR2",
        createdAt: iso(-120 * D),
        lastUsedAt: null,
        expiresAt: iso(-30 * D),
        revokedAt: null,
      },
    ];

on("GET", "/app/api/me/tokens", () => tokens);
on("POST", "/app/api/me/tokens", (_m, body): ApiTokenCreated => {
  const days = body.expiresInDays as number | null;
  const secret = `quiz_pat_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const token: ApiToken = {
    id: nextId("t-"),
    name: String(body.name),
    prefix: secret.slice(0, 15),
    createdAt: iso(0),
    lastUsedAt: null,
    expiresAt: days === null ? null : iso(days * D),
    revokedAt: null,
  };
  tokens.unshift(token);
  return { ...token, token: secret };
});
on("DELETE", "/app/api/me/tokens/:id", (m) => {
  const token = tokens.find((t) => t.id === m.groups!.id);
  if (!token) throw new MockError(404, "Not found");
  token.revokedAt = iso(0);
  return token;
});

// --- OAuth: connected assistants and the consent page (ADR-023) ---

const connections: OAuthConnection[] = flags.empty
  ? []
  : [
      {
        id: "0190d3c4-0000-7000-8000-00000000c1a0",
        clientName: "Claude",
        redirectHost: "claude.ai",
        createdAt: iso(-5 * D),
        lastUsedAt: iso(-1 * H),
      },
    ];

on("GET", "/app/api/me/connections", () => connections);
on("DELETE", "/app/api/me/connections/:id", (m) => {
  const i = connections.findIndex((c) => c.id === m.groups!.id);
  if (i < 0) throw new MockError(404, "Not found");
  connections.splice(i, 1);
  return undefined;
});
// Any id opens the same request; `/oauth/authorize/<id>?loopback=1` shows the
// desktop-client variant with its warning.
on("GET", "/app/api/oauth/requests/:id", (m, _b, url): OAuthRequestView => {
  const loopback = url.searchParams.get("loopback") === "1" || window.location.search.includes("loopback=1");
  return {
    id: m.groups!.id!,
    clientName: loopback ? "Claude Code" : "Claude",
    clientUri: null,
    redirectHost: loopback ? "localhost:39152" : "claude.ai",
    loopback,
    expiresAt: iso(10 * 60_000),
  };
});
on("POST", "/app/api/oauth/requests/:id/decision", () => ({ redirectTo: "/settings" }));

on("POST", "/app/auth/logout", () => {
  me = null;
  return undefined;
});
