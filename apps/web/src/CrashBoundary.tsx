import { Component, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

import { useT } from "./i18n";
import { OutdatedError } from "./lazyPage";
import { Button, EmptyState } from "./ui";

type Crash = "error" | "outdated" | null;

/**
 * The last net under the whole app: a render that throws shows a message and
 * a Reload button instead of unmounting everything to a white page (#228).
 * Nothing is lost by reloading — every answer is saved on the server as it is
 * written, and the attempt comes back where it was. A page of an older build
 * that may not reload by itself says so, and leaves the reload to the reader
 * (ADR-110).
 */
export class CrashBoundary extends Component<{ children: ReactNode }, { crashed: Crash }> {
  state: { crashed: Crash } = { crashed: null };

  static getDerivedStateFromError(error: unknown): { crashed: Crash } {
    return { crashed: error instanceof OutdatedError ? "outdated" : "error" };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    return this.state.crashed ? <CrashScreen outdated={this.state.crashed === "outdated"} /> : this.props.children;
  }
}

function CrashScreen({ outdated }: { outdated: boolean }) {
  const t = useT();
  return (
    <main className="grid min-h-screen place-items-center bg-canvas">
      <EmptyState
        icon={outdated ? RefreshCw : TriangleAlert}
        title={t(outdated ? "crash.outdated.title" : "error.title")}
        titleAs="h1"
        action={<Button onClick={() => window.location.reload()}>{t("crash.reload")}</Button>}
      >
        {t(outdated ? "crash.outdated.body" : "crash.body")}
      </EmptyState>
    </main>
  );
}
