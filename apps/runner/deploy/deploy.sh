#!/usr/bin/env bash
# The engine VM's forced command before M6-04, now a forwarder to the
# dispatcher infra/engine/deploy.sh with the production scope, the request
# untouched. Why it exists and when it goes: that script's header.
set -euo pipefail
exec "$(dirname "$(readlink -f "$0")")/../../../infra/engine/deploy.sh" production
