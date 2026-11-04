#!/usr/bin/env bash
# The PDF tools of the API's tests in CI (ADR-125 §3): the pinned Typst on
# PATH and poppler's pdftotext. Under `CI` the PDF tests fail, never skip,
# when either is missing. Run by ci.yml and coverage.yml, on a GitHub runner.
set -euo pipefail

node "$(dirname "$0")/fetch-typst.mjs" "$RUNNER_TEMP/typst"
echo "$RUNNER_TEMP/typst" >> "$GITHUB_PATH"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends poppler-utils
