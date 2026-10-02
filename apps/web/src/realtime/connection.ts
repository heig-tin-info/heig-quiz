import { HealthResponse } from "@quiz/contracts";

export type ConnectionState = "connected" | "reconnecting" | "updating";

/** One recovery loop per tab. A failed operation is never replayed here. */
export class ConnectionMonitor {
  private state: ConnectionState = "connected";
  private listeners = new Set<() => void>();
  private active = false;
  private recovering = false;
  private generation = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private grace: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  start = () => {
    this.active = true;
    window.addEventListener("offline", this.offline);
    window.addEventListener("online", this.online);
    if (!navigator.onLine) this.offline();
    return () => {
      this.active = false;
      window.removeEventListener("offline", this.offline);
      window.removeEventListener("online", this.online);
      this.reset();
      this.publish("connected");
    };
  };
  private offline = () => this.suspect();
  private online = () => {
    this.suspect();
    if (!this.controller) {
      clearTimeout(this.timer);
      void this.probe();
    }
  };

  /** SSE errors and transport failures are clues, not proof of a deployment. */
  suspect = () => {
    if (!this.active || this.recovering) return;
    this.recovering = true;
    this.grace = setTimeout(() => this.publish("reconnecting"), 1_200);
    void this.probe();
  };

  /** Only the server's explicit shutdown frame may use the update wording. */
  updating = () => {
    if (!this.active) return;
    this.reset();
    this.recovering = true;
    this.publish("updating");
    // Let the old listener shut down before asking whether the API is back.
    this.timer = setTimeout(() => void this.probe(), 1_500);
  };

  private reset() {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.grace);
    this.controller?.abort();
    this.controller = undefined;
    this.recovering = false;
    this.failures = 0;
  }

  private async probe() {
    if (!this.active || !this.recovering || this.controller) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let healthy = false;
    try {
      if (navigator.onLine) {
        const response = await fetch("/healthz", {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        // A captive portal's HTML (even HTTP 200) is not a recovered API.
        if (response.ok) {
          const health = HealthResponse.safeParse(await response.json());
          healthy = health.success && health.data.status === "ok";
        }
      }
    } catch {
      // Keep the page mounted and try again; no mutation is replayed here.
    } finally {
      clearTimeout(timeout);
    }
    if (!this.active || generation !== this.generation) return;
    this.controller = undefined;
    if (healthy) {
      this.reset();
      this.publish("connected");
    } else {
      // Bounded backoff with jitter: a whole classroom must not retry in lockstep.
      const delay = Math.min(1_000 * 2 ** Math.min(this.failures++, 3), 5_000);
      this.timer = setTimeout(() => void this.probe(), delay + Math.random() * 500);
    }
  }
}

export const connection = new ConnectionMonitor();
