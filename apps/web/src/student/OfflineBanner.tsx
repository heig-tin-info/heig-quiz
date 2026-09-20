/**
 * "You are offline", in the zen player.
 *
 * It states the only thing that matters to someone whose Wi-Fi just dropped
 * in an exam room: what they typed is not lost. `Autosave` keeps every
 * unacked payload in memory and replays it on reconnect (N-RES-02), so the
 * honest message is "kept here, sent again soon" and not "save your work".
 *
 * It sits in the page flow under the player's bar rather than floating: a
 * toast that fades is the wrong shape for a state that lasts.
 */
import { WifiOff } from "lucide-react";

import { useT } from "../i18n";
import { Alert } from "../ui";

export function OfflineBanner({ show }: { show: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <Alert tone="warning" icon={WifiOff} title={t("player.offline.title")}>
      {t("player.offline.body")}
    </Alert>
  );
}
