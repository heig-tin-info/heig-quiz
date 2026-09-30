/**
 * The HTTP metrics of N-OPS-02 (ADR-055 §7): on `/metrics`, a counter of the
 * requests by method, ROUTE TEMPLATE and status class, and a latency
 * histogram of few buckets; on the System status page, the server errors
 * (5xx) of the last day and the three routes that answered most of them.
 *
 * A route is named by its template (`/app/api/classrooms/:id`), never by the
 * URL, which carries ids and one-time secrets; a request no route matched is
 * `unmatched`. No user, no IP, no query string: nothing personal leaves.
 */
import type { FastifyInstance } from "fastify";
import { Counter, Histogram, type Registry } from "prom-client";

import { perApp } from "./perApp.js";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** A day of hourly buckets: small, and old errors fall off on their own. */
const HOUR = 3_600_000;
const WINDOW_HOURS = 24;

interface ErrorWindow {
  /** Per hour (`floor(ms / HOUR)`), the 5xx answers by route template. */
  hours: Map<number, Map<string, number>>;
}

const windows = perApp<ErrorWindow>();

/**
 * Registers the counter, the histogram and the hook that feeds them and the
 * 5xx window. Called once, from `buildApp`, before any route: a hook added
 * to the root instance reaches every route registered after it.
 */
export function registerHttpMetrics(app: FastifyInstance, registry: Registry): void {
  const requests = new Counter({
    name: "quiz_http_requests_total",
    help: "HTTP requests answered, by method, route template and status class",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
  });
  const latency = new Histogram({
    name: "quiz_http_request_duration_seconds",
    help: "Time to answer an HTTP request, by method and route template",
    labelNames: ["method", "route"] as const,
    buckets: [0.025, 0.1, 0.25, 1, 2.5, 10],
    registers: [registry],
  });
  const window: ErrorWindow = { hours: new Map() };
  windows.set(app, window);

  app.addHook("onResponse", async (req, reply) => {
    const method = METHODS.has(req.method) ? req.method : "OTHER";
    // A 404 of the not-found handler has no route: its URL is whatever was asked.
    const route = req.routeOptions.url ?? "unmatched";
    const status = `${Math.floor(reply.statusCode / 100)}xx`;
    requests.inc({ method, route, status });
    latency.observe({ method, route }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) countServerError(window, route, Date.now());
  });
}

function countServerError(window: ErrorWindow, route: string, now: number): void {
  const hour = Math.floor(now / HOUR);
  let byRoute = window.hours.get(hour);
  if (!byRoute) {
    byRoute = new Map();
    window.hours.set(hour, byRoute);
    for (const h of window.hours.keys()) if (h <= hour - WINDOW_HOURS) window.hours.delete(h);
  }
  byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
}

export interface ServerErrors {
  /** 5xx answers of this process in the last 24 hours (or since it started). */
  count: number;
  /** The routes that answered most of them, at most three, most first. */
  top: { route: string; count: number }[];
}

/** The 5xx of the last day, or null when this instance keeps no window. */
export function serverErrorsOf(app: FastifyInstance, now = Date.now()): ServerErrors | null {
  const window = windows.get(app);
  if (!window) return null;
  const from = Math.floor(now / HOUR) - WINDOW_HOURS;
  const byRoute = new Map<string, number>();
  for (const [hour, routes] of window.hours) {
    if (hour <= from) continue;
    for (const [route, n] of routes) byRoute.set(route, (byRoute.get(route) ?? 0) + n);
  }
  const all = [...byRoute].map(([route, count]) => ({ route, count }));
  all.sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
  return { count: all.reduce((sum, r) => sum + r.count, 0), top: all.slice(0, 3) };
}
