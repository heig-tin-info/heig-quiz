import { Component, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { useT } from "./i18n";
import { Button, EmptyState } from "./ui";

/**
 * The last net under the whole app: a render that throws shows a message and
 * a Reload button instead of unmounting everything to a white page (#228).
 * Nothing is lost by reloading — every answer is saved on the server as it is
 * written, and the attempt comes back where it was.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    return this.state.crashed ? <CrashScreen /> : this.props.children;
  }
}

function CrashScreen() {
  const t = useT();
  return (
    <main className="grid min-h-screen place-items-center bg-canvas">
      <EmptyState
        icon={TriangleAlert}
        title={t("error.title")}
        titleAs="h1"
        action={<Button onClick={() => window.location.reload()}>{t("crash.reload")}</Button>}
      >
        {t("crash.body")}
      </EmptyState>
    </main>
  );
}
