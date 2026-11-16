/**
 * `/projects/:id/station` — a kiosk station's project sitting (ADR-089 §3,
 * §4, §7, §8): the station stays on Quiz and frames the portal. A thin bar
 * (the station's label, the server's deadline, **Leave this station**) above
 * a sandboxed `iframe` whose address is the `{ url }` of the student's own
 * start route. The page's CSP admits the portal in a frame, on this address
 * only (`apps/api/src/csp.ts`, §10).
 *
 * Everything of ADR-051 runs here as on an exam: the attestation at once and
 * every 10 minutes, the 30 s retries (`useStationAttestation`), the
 * suspension screen covering the frame, and the return to `/kiosk` once the
 * session is gone (`StationOrLanding`, through `/me`). The frame makes no
 * write to Quiz, so the page also covers itself when one of its own
 * attestations is refused, and asks for its session every minute: the event
 * stream serves no project session.
 *
 * The portal's own cookie (`exam_session`) lives 4 h, a station's session 6:
 * the page relaunches before the portal's runs out (§8), from the same
 * route; resuming a workspace consumes no quota.
 *
 * The four decisions (DESIGN.md, "The kiosk station"):
 *   - Type: the station's label at 14 px medium, the project's title muted,
 *     the countdown at its own 15 px; the frame is the page. Until the
 *     frame's page has loaded, the opening notice of `/kiosk`, at its size.
 *   - Color: no accent; Leave is secondary, the one way out.
 *   - Space: a 44 px bar, hairline under it, the frame to the edges.
 *   - Finish: surface bar on the canvas, no shadow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogOut, Monitor, ShieldAlert } from "lucide-react";

import {
  workspaceStartPath,
  WorkspaceStartRefusal,
  type KioskStation,
  type StudentProject,
  type WorkspaceStart,
} from "@quiz/contracts";

import { api, refusalCodeOf, refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { kioskStationKey, meKey, studentProjectKey } from "../queryKeys";
import { useServerClock } from "../realtime/useServerClock";
import { ScreenOverlay } from "../student/PausedOverlay";
import { Button, ClockCountdown, EmptyState, Spinner } from "../ui";
import { STATION_SPINNER } from "./KioskPage";
import { toKiosk } from "./navigation";
import { endProjectSitting } from "./station";
import { useStationAttestation } from "./useStationAttestation";

/**
 * When the frame is relaunched, after its last launch: under the portal's
 * `exam_session`, with ten minutes to spare. The 4 h mirror the DEFAULT of
 * the portal's configurable `EXAM_COOKIE_MAX_AGE_MS`
 * (`apps/codespace/src/auth/config.ts`): a portal configured shorter
 * outruns this. The page cannot read the frame's 403 across origins; the
 * launch reply or the portal telling the page its expiry is a follow-up
 * (M6-11e card).
 */
export const PORTAL_RELAUNCH_MS = 4 * 3_600_000 - 10 * 60_000;

/** How often the page asks whether its session still stands. */
export const SESSION_CHECK_MS = 60_000;

/**
 * How often a launch that did not open is looked at again: a failure is
 * launched again, a refusal has the project read again (below).
 */
export const LAUNCH_RETRY_MS = 10_000;

/** The sandbox of the portal's frame: no top navigation, no popups (§3). */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals";

/** What the frame holds: a launch in flight (over the last address, if any), the portal, a refusal, or a failure. */
type Frame =
  | { kind: "launching"; url: string | null }
  | { kind: "open"; url: string; at: number }
  | { kind: "refused"; code: WorkspaceStartRefusal }
  | { kind: "failed" };

export function StationProjectPage({ id, relaunchMs = PORTAL_RELAUNCH_MS }: { id: string; relaunchMs?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);
  const attestation = useStationAttestation(true, { suspendOnRefusal: true });
  const { suspended, guardSubmit } = attestation;
  const station = useQuery<KioskStation>({
    queryKey: kioskStationKey,
    queryFn: () => api("/app/api/kiosk/station"),
    retry: false,
  });
  const project = useQuery<StudentProject>({
    queryKey: studentProjectKey(id),
    queryFn: () => api(`/app/api/student/projects/${id}`),
  });
  const clock = useServerClock();
  const { sample } = clock;
  const serverNow = project.data?.serverNow;
  useEffect(() => {
    if (serverNow) sample(serverNow);
  }, [sample, serverNow]);

  // A session the server ended signs the page out; `StationOrLanding` then returns to `/kiosk`.
  useEffect(() => {
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: meKey }), SESSION_CHECK_MS);
    return () => clearInterval(timer);
  }, [qc]);

  // The project as the student sees it, the server's clock aside; null until read. The launch waits
  // for the first read, so that it knows which project it was refused on.
  const facts = project.data ? JSON.stringify({ ...project.data, serverNow: null }) : null;
  const frame = usePortalFrame(id, guardSubmit, suspended || project.isPending, relaunchMs, facts);

  // A refusal lifts by what the student does elsewhere (accepting the project): the page reads
  // the project again meanwhile. That read wants no attestation; the start route wants a fresh one.
  const refused = frame.state.kind === "refused";
  useEffect(() => {
    if (!refused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: studentProjectKey(id) }), LAUNCH_RETRY_MS);
    return () => clearInterval(timer);
  }, [refused, qc, id]);

  const leave = async () => {
    const ok = await confirm({
      title: t("kiosk.station.leave.title"),
      message: t("kiosk.station.leave.body"),
      confirmLabel: t("kiosk.station.leave.confirm"),
    });
    if (!ok) return;
    setLeaving(true);
    const outcome = await endProjectSitting();
    // Only a sitting the server ended goes back to the station's screen; a suspended
    // station already shows its notice, and a failure leaves the sitting as it was.
    if (outcome === "left") return toKiosk();
    setLeaving(false);
    if (outcome === "failed") toast(t("kiosk.station.leave.failed"), "error");
  };

  const url = frame.state.kind === "open" || frame.state.kind === "launching" ? frame.state.url : null;
  // The portal starts the workspace before it serves the editor: the frame is blank meanwhile.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  // Where `/kiosk` left its own "Opening your workspace…", at its size: one notice from the scan to the editor.
  const opening = (
    <div className="absolute inset-0 grid place-items-center bg-canvas">
      <Spinner label={t("kiosk.opening.workspace")} className={STATION_SPINNER} />
    </div>
  );
  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 text-sm">
        <Monitor className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 truncate font-medium text-fg" data-testid="station-label">
          {station.data?.label ?? ""}
        </span>
        {/* A station's screen is wide; on a narrow one the title gives way first. */}
        <span className="hidden min-w-0 truncate text-fg-muted md:inline">{project.data?.title ?? ""}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {project.data ? <ClockCountdown deadlineAt={Date.parse(project.data.deadlineAt)} clock={clock.now} /> : null}
          <Button variant="secondary" size="sm" loading={leaving} onClick={() => void leave()}>
            <LogOut /> {t("kiosk.station.leave")}
          </Button>
        </span>
      </header>
      <main className="relative min-h-0 flex-1">
        {url ? (
          <>
            <iframe
              key={url}
              src={url}
              title={t("sproj.workspace")}
              allow="clipboard-read; clipboard-write"
              sandbox={FRAME_SANDBOX}
              // Under a notice (the suspension, §7, or the opening) the frame takes no focus and no keystroke.
              inert={suspended || loadedUrl !== url}
              onLoad={() => setLoadedUrl(url)}
              className="absolute inset-0 size-full border-0"
            />
            {/* The same words as the launch, over the frame until its page has loaded. */}
            {loadedUrl !== url ? opening : null}
          </>
        ) : frame.state.kind === "refused" ? (
          <EmptyState icon={AlertTriangle} titleAs="h1" title={t("sproj.workspace.refused")} className="pt-24">
            {t(`sproj.workspace.refusal.${frame.state.code}`)}
          </EmptyState>
        ) : frame.state.kind === "failed" ? (
          <EmptyState
            icon={AlertTriangle}
            titleAs="h1"
            title={t("sproj.workspace.refused")}
            className="pt-24"
            action={
              <Button variant="primary" onClick={frame.retry}>
                {t("common.retry")}
              </Button>
            }
          >
            {t("kiosk.station.failed.body")}
          </EmptyState>
        ) : (
          opening
        )}
      </main>
      {/* ADR-051 §6, ADR-089 §7: the notice covers the frame; it lifts by itself. */}
      <ScreenOverlay show={suspended} icon={ShieldAlert} title={t("player.suspended.title")} body={t("kiosk.station.suspended.body")} />
    </div>
  );
}

/**
 * The frame's launch: the start route's POST (CSRF, the station's `423`s,
 * a fresh attestation, which `guardSubmit` renews once when stale), its
 * `{ url }` in the frame, again `relaunchMs` after each launch. A `held`
 * page launches nothing (a suspended station, the project not read yet);
 * the launch waits for the hold to lift.
 *
 * A refusal the student can read stays on screen, and is launched again
 * once `facts` (the project they see) differs from what it was when the
 * refused launch started: never on a timer, which would cost the station an
 * attestation every two minutes. Anything else offers a retry, and is
 * launched again `LAUNCH_RETRY_MS` later, for as long as it fails.
 */
function usePortalFrame(
  projectId: string,
  guardSubmit: <T>(submit: () => Promise<T>) => Promise<T>,
  held: boolean,
  relaunchMs: number,
  facts: string | null,
) {
  const [state, setState] = useState<Frame>({ kind: "launching", url: null });
  const launching = state.kind === "launching";
  /** `facts` when the last launch started. */
  const launchedOn = useRef(facts);

  useEffect(() => {
    if (!launching || held) return;
    let alive = true;
    launchedOn.current = facts;
    guardSubmit(() => api<WorkspaceStart>(workspaceStartPath(projectId), { method: "POST" })).then(
      ({ url }) => {
        if (alive) setState({ kind: "open", url, at: Date.now() });
      },
      (error: unknown) => {
        // A suspended station: the notice is up, and the launch is tried again once it lifts.
        if (!alive || refusedWith(error, "kiosk_suspended")) return;
        const refusal = WorkspaceStartRefusal.safeParse(refusalCodeOf(error));
        setState(refusal.success ? { kind: "refused", code: refusal.data } : { kind: "failed" });
      },
    );
    return () => {
      alive = false;
    };
    // `facts` is read when a launch starts and never starts one here: the effect below does.
  }, [launching, held, projectId, guardSubmit]);

  const openAt = state.kind === "open" ? state.at : null;
  useEffect(() => {
    if (openAt === null) return;
    const timer = setTimeout(
      () => setState((s) => (s.kind === "open" ? { kind: "launching", url: s.url } : s)),
      Math.max(0, openAt + relaunchMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [openAt, relaunchMs]);

  const retry = useCallback(() => setState({ kind: "launching", url: null }), []);
  const failed = state.kind === "failed";
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(retry, LAUNCH_RETRY_MS);
    return () => clearTimeout(timer);
  }, [failed, retry]);
  const refused = state.kind === "refused";
  useEffect(() => {
    if (refused && facts !== launchedOn.current) retry();
  }, [refused, facts, retry]);
  return { state, retry };
}
