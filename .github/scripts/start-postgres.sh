#!/usr/bin/env bash
# Start the CI Postgres, with a pull we OWN the retry for.
#
# THE FAILURE THIS EXISTS TO REMOVE (#1828)
# -----------------------------------------
# Every DB-using job used to declare postgres as a `services:` block, and a
# transient registry error there destroys the whole job before step 1:
#
#   ##[command] /usr/bin/docker pull public.ecr.aws/docker/library/postgres:17
#   ##[warning] Docker pull failed with exit code 1, back off 5.114s
#   ##[warning] Docker pull failed with exit code 1, back off 6.358s
#   ##[error]   Docker pull failed with exit code 1
#
# A 141-line job log, no test ever run. Measured on the six ci.yml runs before
# this landed: 1, 0, 1, 3, 0, 2 jobs killed this way — several re-run cycles a
# night, none of them about code.
#
# ⚠ THIS IS THE SECOND TIME. The `services:` blocks carried the note "AWS ECR
# Public mirror — avoids the flaky Docker Hub service-container pull", i.e.
# Docker Hub flaked, someone swapped to ECR Public, and ECR Public now flakes
# the same way. So a THIRD registry swap is not the fix: the defect is that a
# single registry is a HARD DEPENDENCY of a job, wherever it points.
#
# WHY A STEP AND NOT A SERVICE
# ----------------------------
# Service containers are initialised BEFORE the first step runs, so nothing a
# step could do — no pre-pull, no cache restore, no retry wrapper — can protect
# them. GitHub's own three attempts are the whole budget, they share one
# registry, and when they are exhausted the job is already over. Moving the
# container into a step is the only place from which the pull is recoverable;
# everything below is possible only because of that move.
#
# This is the same rule scripts/ci-fetch-retry.test.ts applies to every `curl`
# in CI after #1534 ("a required gate must not be one third-party hiccup away
# from reddening main"), extended to the class of network fetch that rule could
# not reach: the image pull.
#
# WHAT IT DOES
# ------------
#   1. Pulls postgres, trying each registry in PG_REGISTRIES in order, for
#      1 + |PG_PULL_BACKOFF| passes with growing backoff between passes. Both
#      dimensions matter and they cover different outages: the retry covers a
#      transient error from ONE registry, the fallback covers that registry
#      being down for longer than the retry budget.
#   2. Runs it detached with the same env/port mapping the `services:` block
#      published, so DATABASE_URL is unchanged in every caller.
#   3. Polls pg_isready until it answers, then returns. This replaces the
#      service block's `--health-cmd`, which GitHub waited on before starting
#      steps — so a caller still gets "the next step can talk to postgres".
#
# The registries are FALLBACKS, not a swap: ECR Public stays primary (no rate
# limits, and it is what every green run has used), Docker Hub is the second
# opinion. They are separately operated, so an outage of one is not an outage of
# the other — which is the only property that makes the list worth having.
#
# USAGE
#   .github/scripts/start-postgres.sh              # start it
#   .github/scripts/start-postgres.sh --print-refs # print the refs it would try
#
# The --print-refs mode is what scripts/ci-service-container-pull.test.ts reads,
# so the gate asserts the ACTUAL resolution order rather than grepping for a
# hostname in this file's source.
#
# INPUTS (all optional; defaults reproduce the deleted `services:` blocks)
#   PG_IMAGE_TAG        postgres major tag                  (default 17)
#   PG_HOST_PORT        host port to publish 5432 on        (default 5432)
#   PG_CONTAINER_NAME   container name                      (default ci-postgres)
#   POSTGRES_DB/_USER/_PASSWORD                             (default patchtogether_test/postgres/postgres)
#   PG_REGISTRIES       space-separated registry prefixes; `/postgres:<tag>` is appended
#   PG_PULL_BACKOFF     space-separated seconds between passes (default "5 15 45")
#   PG_PULL_TIMEOUT     per-attempt cap in seconds          (default 240)
#   PG_READY_TIMEOUT    readiness poll budget in seconds    (default 90)
set -euo pipefail

PG_IMAGE_TAG="${PG_IMAGE_TAG:-17}"
PG_HOST_PORT="${PG_HOST_PORT:-5432}"
PG_CONTAINER_NAME="${PG_CONTAINER_NAME:-ci-postgres}"
PG_DB="${POSTGRES_DB:-patchtogether_test}"
PG_USER="${POSTGRES_USER:-postgres}"
PG_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

# ⚠ ORDER IS THE POLICY. ECR Public first: it has no anonymous rate limit and is
# what the working runs pulled from. Docker Hub second — the ORIGINAL registry
# these blocks used before the first swap, so it is known-good here, and it is
# rate-limited for anonymous pulls, which is survivable precisely because it is
# only reached when ECR has already failed.
#
# A third entry is a one-line change and needs no code: any registry serving the
# official image under `<prefix>/postgres:<tag>` works. It is deliberately NOT
# added speculatively — a prefix that 404s every time would make this list look
# deeper than it is and add a guaranteed-failing attempt to every bad pass.
PG_REGISTRIES="${PG_REGISTRIES:-public.ecr.aws/docker/library docker.io/library}"
PG_PULL_BACKOFF="${PG_PULL_BACKOFF:-5 15 45}"
PG_PULL_TIMEOUT="${PG_PULL_TIMEOUT:-240}"
PG_READY_TIMEOUT="${PG_READY_TIMEOUT:-90}"

# ⚠ VALIDATE BEFORE BUILDING THE ARRAY, not after. Under `set -u` in bash 3.2
# (macOS, where this is developed and unit-tested) expanding an EMPTY array as
# "${arr[@]}" is an unbound-variable error, so an empty PG_REGISTRIES would
# abort with a shell diagnostic instead of the message below. CI runs bash 5,
# where it would not — i.e. exactly the shape that passes on one machine and
# fails on the other.
if [ -z "${PG_REGISTRIES// /}" ]; then
  echo "start-postgres: PG_REGISTRIES is empty — there is nothing to pull." >&2
  exit 1
fi

read -r -a REGISTRIES <<<"$PG_REGISTRIES"
# BACKOFF may legitimately be empty (one pass, no retry). Only ever read by
# index and by ${#…}, never expanded as "${BACKOFF[@]}", so an empty array here
# is safe on bash 3.2 as well.
read -r -a BACKOFF <<<"$PG_PULL_BACKOFF"

REFS=()
for registry in "${REGISTRIES[@]}"; do
  REFS+=("${registry}/postgres:${PG_IMAGE_TAG}")
done

if [ "${1:-}" = "--print-refs" ]; then
  printf '%s\n' "${REFS[@]}"
  exit 0
fi

# Bound a HUNG pull rather than letting it eat the job's timeout-minutes. A
# stalled transfer and a refused connection look identical from the job log
# otherwise, and only one of them is worth retrying quickly. `timeout` is
# coreutils and present on ubuntu-latest; if it is missing we still run, just
# unbounded, because failing to start postgres over a missing helper would be a
# worse outcome than an unbounded pull.
pull() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$PG_PULL_TIMEOUT" docker pull "$1"
  else
    docker pull "$1"
  fi
}

attempts=0
image=""
passes=$((1 + ${#BACKOFF[@]}))
for ((pass = 0; pass < passes; pass++)); do
  if [ "$pass" -gt 0 ]; then
    delay="${BACKOFF[$((pass - 1))]}"
    echo "start-postgres: pass $pass failed on every registry; sleeping ${delay}s"
    sleep "$delay"
  fi
  for ref in "${REFS[@]}"; do
    attempts=$((attempts + 1))
    echo "start-postgres: pull attempt $attempts — $ref"
    if pull "$ref"; then
      image="$ref"
      break
    fi
    echo "start-postgres: attempt $attempts FAILED — $ref" >&2
  done
  # `if`, NOT `[ … ] && break` — under `set -e` a trailing test that evaluates
  # FALSE makes the line exit non-zero and aborts the script. That exact bug was
  # live in `task vrt:commit` and killed the documented baseline-capture entry
  # point; it is not a style preference.
  if [ -n "$image" ]; then break; fi
done

if [ -z "$image" ]; then
  echo "start-postgres: could not pull postgres:${PG_IMAGE_TAG} after ${attempts} attempts across ${#REFS[@]} registries (${REFS[*]})." >&2
  echo "start-postgres: every registry in PG_REGISTRIES failed every pass — this is an outage, not a flake. Check the registries' status before re-running." >&2
  exit 1
fi

echo "start-postgres: pulled $image on attempt $attempts of a possible $((passes * ${#REFS[@]}))"

docker run -d \
  --name "$PG_CONTAINER_NAME" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  -p "${PG_HOST_PORT}:5432" \
  "$image" >/dev/null

# Readiness, replacing the `services:` health-check GitHub used to wait on
# before starting steps. Poll the SUBJECT (pg_isready inside the container),
# never a fixed sleep: a sleep is a different number of "is it up yet" on every
# runner, and this has to hold on a loaded one.
deadline=$((SECONDS + PG_READY_TIMEOUT))
ready=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if docker exec "$PG_CONTAINER_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "start-postgres: $PG_CONTAINER_NAME never became ready within ${PG_READY_TIMEOUT}s. Container log follows." >&2
  docker logs "$PG_CONTAINER_NAME" || true
  exit 1
fi

echo "start-postgres: postgres ${PG_IMAGE_TAG} ready on localhost:${PG_HOST_PORT} (db=${PG_DB})"
