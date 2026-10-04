---
search:
  exclude: true
---

# Measured inventory and coverage

> Snapshot of baseline `59c8925a` (2026-10-03). Paths and line numbers drift as
> `main` moves: re-measure before acting on a row.

Baseline `59c8925a7fee4bee9bcb2664bf2cdde781468cd0`. [Method](methodology.md).

Runtime physical lines include comments, blanks, schema declarations and translations.
Token-bearing lines exclude comments/blanks but still include declarations and data.
Neither is a count of executable statements. Test/support includes mocks and `testing.ts`;
seed files and scripts/configuration belong to tooling.

| Workspace / area | Runtime files | Physical lines | Token-bearing lines | Functions | CC > 10 | CC > 20 | Test/support files | Tooling files |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `.claude` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| `apps/api` | 244 | 54,594 | 37,210 | 3,164 | 68 | 6 | 175 | 11 |
| `apps/runner` | 10 | 1,605 | 1,028 | 108 | 2 | 0 | 14 | 3 |
| `apps/web` | 352 | 79,009 | 60,669 | 5,001 | 133 | 27 | 208 | 6 |
| `extensions/kiosk-attestation` | 2 | 92 | 70 | 9 | 0 | 0 | 2 | 0 |
| `packages/contracts` | 29 | 7,600 | 4,071 | 72 | 0 | 0 | 12 | 1 |
| `packages/core` | 11 | 1,617 | 624 | 44 | 0 | 0 | 8 | 1 |
| `packages/diagram` | 28 | 4,549 | 3,737 | 414 | 29 | 13 | 6 | 1 |
| `packages/docrender` | 7 | 934 | 526 | 54 | 2 | 0 | 4 | 1 |
| `packages/domain` | 62 | 7,515 | 4,127 | 486 | 12 | 1 | 59 | 1 |
| `packages/qt-categorize` | 13 | 2,234 | 1,655 | 180 | 5 | 0 | 9 | 1 |
| `packages/qt-circuit` | 29 | 10,591 | 7,908 | 663 | 16 | 2 | 26 | 1 |
| `packages/qt-cloze` | 11 | 1,182 | 891 | 77 | 0 | 0 | 9 | 1 |
| `packages/qt-code` | 40 | 8,319 | 6,062 | 466 | 16 | 1 | 34 | 1 |
| `packages/qt-diagram` | 8 | 934 | 655 | 54 | 2 | 1 | 8 | 1 |
| `packages/qt-mcq` | 12 | 2,120 | 1,365 | 121 | 3 | 0 | 10 | 1 |
| `packages/qt-rich` | 9 | 878 | 604 | 45 | 1 | 0 | 9 | 1 |
| `packages/qt-short` | 12 | 2,129 | 1,620 | 127 | 5 | 1 | 11 | 1 |
| `packages/registry` | 2 | 121 | 71 | 4 | 0 | 0 | 1 | 1 |
| `packages/ui` | 14 | 1,771 | 1,131 | 82 | 3 | 0 | 13 | 1 |
| `scripts` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| `vitest.shared.ts` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |

## Directory coverage

Every source area has a disposition in [API](api.md#area-by-area-disposition),
[web](web.md#inventory-every-source-area), or [packages and operations](packages.md#every-package-disposition).
The full file inventory, which the [analyzer](methodology.md#reproduce) regenerates, also covers config/scripts and test support.
Manual behavioral review was selected by risk and metrics; an inventoried file is not
a claim that every statement received a security review or a runtime test.

## Other tracked code and configuration

The analyzer's other-files inventory records source/configuration outside JS/TS.
SQL migrations and generated snapshots are retained historical state, not deletion targets.
CSS/help/translation content, deployment configuration, build images and screenshot
scenes are not interchangeable algorithms. Shell/Python/CSS/YAML/HTML receive inventory
and selected operational review, **not** the TypeScript cyclomatic metric. No browser,
real Podman, live PostgreSQL/GitHub/load test or staging restore was executed.
