#!/usr/bin/env bash
# The engine VM's forced command until M6-04, kept as a forwarder. Since
# M6-04 one dispatcher deploys both components of the VM, the runner and the
# codespace portal: infra/engine/deploy.sh. A production key whose
# authorized_keys line still names THIS path:
#   command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
# keeps deploying exactly as before: the request ("<sha> <token>",
# "<token>", or the dispatcher's own form) is handed over untouched, with the
# production scope.
#
# The first deploy after M6-04 runs the PREVIOUS copy of this file, which
# moves the checkout and re-executes "$0" with QUIZ_DEPLOY_REEXEC=1 and the
# sha in QUIZ_DEPLOY_SHA, the login already done: it lands here, and the
# dispatcher takes that hand-over as the runner's deploy (RUNBOOK.md of
# apps/codespace/deploy, "Moving the key to the dispatcher").
set -euo pipefail
exec "$(dirname "$(readlink -f "$0")")/../../../infra/engine/deploy.sh" production
