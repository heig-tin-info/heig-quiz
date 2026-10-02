# ADR-065 — Connection recovery without reloading student work

## Status

Accepted (2026-10-02, product owner request). Completes N-RES-02 and N-RES-03.

## Decision

Keep the application mounted while a native modal blurs the background and
makes the page, including portalled dialogs, inert. Ordinary outages say
“Connection lost”, with automatic reconnection; a graceful API restart says
“Platform update in progress”. Both messages are translated. Never reload the
page to obtain a new frontend during an attempt.

The existing SSE channel receives one final typed `platform.updating` frame
in `preClose`, before the responses are ended. Ending streams in `preClose`
also lets Fastify drain its requests before `onClose`. This is an explicit
signal of an orderly restart, not a guess based on a 502. A crash, a forced
kill or a missed shutdown frame uses the ordinary connection message. An
already-open tab must have this frontend version to understand the signal.

Browser offline events, API transport failures and 502/503/504 responses,
and SSE errors or its existing silence watchdog start one recovery loop.
Only while recovering, probe the existing `/healthz` without cache, with a
five-second timeout and backoff from one to five seconds plus jitter. A valid
healthy response clears the interruption; a captive portal's HTML cannot.
An SSE authorization failure alone does not block a healthy REST API. A
1.2-second grace hides short hiccups. No new periodic healthy-state poll.

On recovery, invalidate reads. Do not retry arbitrary mutations: their result
may be ambiguous. The existing student's autosave owns the revision-aware
replay of unacknowledged answers, and SSE owns its reconnect and snapshots.
Keep this tab open: pending work is in memory, not durable offline storage.
The server's deadlines continue to apply; this overlay does not pause an exam
or extend its deadline. The live-evaluation deployment guard stays in force.

## Limits

This smooths an interruption, it does not make deployment zero-downtime.
Frontend/backend compatibility and backward-compatible migrations remain
necessary. An old lazy frontend chunk removed by a deploy is a separate asset
retention concern; no automatic reload is introduced as a workaround.
