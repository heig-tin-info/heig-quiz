/**
 * The return of a GitHub link round trip (F-GH-05, M2-03): the callback
 * lands on the page the user started from with `?github=linked|conflict|error`
 * appended. Said once as a toast through Quiz's notify, then the parameter is
 * taken out of the address (the rest of the query and the fragment kept), so
 * a reload or a shared link does not say it again.
 */
import { useEffect } from "react";

import { GithubLinkOutcome } from "@quiz/contracts";

import { useT } from "../i18n";
import { useToast } from "../notify";

const TONES = { linked: "success", conflict: "error", error: "error" } as const;

/** Reads `?github=` once the app is signed in (`enabled`), toasts it, and drops it. */
export function useGithubLinkReturn(enabled: boolean): void {
  const t = useT();
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("github");
    if (raw === null) return;
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    // Anything but a known outcome is dropped silently: the parameter is
    // the callback's, and a forged one must not put words on the screen.
    const outcome = GithubLinkOutcome.safeParse(raw);
    if (outcome.success) toast(t(`github.return.${outcome.data}`), TONES[outcome.data]);
    // Once per page load: the parameter is consumed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
