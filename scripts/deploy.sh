#!/usr/bin/env bash
# Self-hosted runner invokes this script via the deploy workflow.
#
# Steps:
#   1. git pull (or checkout the SHA the runner passed)
#   2. docker compose build <changed-services>
#   3. docker compose up -d
#   4. wait for /health/ready to return 200
#   5. run smoke_e2e.py
#   6. on failure: git checkout HEAD~1 and re-run
#
# Idempotent. Safe to interrupt mid-run (docker will just keep the
# previous containers running).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_DIR="$REPO_DIR"
LOG_FILE="$REPO_DIR/deploy.log"
SMOKE="${SMOKE:-1}"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

cd "$REPO_DIR"

# 1. Sync source from the SHA the runner passed (default: HEAD of current branch)
TARGET_SHA="${1:-}"
if [ -n "$TARGET_SHA" ]; then
    log "Checking out $TARGET_SHA"
    git fetch --all --quiet
    git checkout --quiet "$TARGET_SHA"
fi

# Capture the "current good" SHA so we can roll back to it if smoke fails.
PRE_DEPLOY_SHA=$(git rev-parse HEAD)
log "Pre-deploy SHA: $PRE_DEPLOY_SHA"

# 2. Build changed services. Pass the affected services as args, or build all.
shift_count=0
if [ -n "$TARGET_SHA" ]; then shift_count=1; fi
shift $shift_count || true

SERVICES_TO_BUILD=("$@")
if [ ${#SERVICES_TO_BUILD[@]} -eq 0 ]; then
    log "No services specified — building api (the only service with a Python source tree that changes)"
    SERVICES_TO_BUILD=(api)
fi

for svc in "${SERVICES_TO_BUILD[@]}"; do
    log "Building $svc"
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" build "$svc" 2>&1 | tee -a "$LOG_FILE"
done

# 3. Apply — only restart the services we built so we don't take down the
#    whole stack on every deploy.
log "docker compose up -d ${SERVICES_TO_BUILD[*]}"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d "${SERVICES_TO_BUILD[@]}" 2>&1 | tee -a "$LOG_FILE"

# 4. Wait for api /health/ready to return 200 (max 90s).
log "Waiting for api /health/ready ..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8000/health/ready 2>/dev/null | grep -q 200; then
        log "api is ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        log "TIMEOUT: api never became ready after 60s"
        _rollback
        exit 1
    fi
    sleep 2
done

# 5. Smoke E2E.
if [ "$SMOKE" = "1" ]; then
    log "Running smoke_e2e.py"
    if python3 "$REPO_DIR/scripts/smoke_e2e.py" 2>&1 | tee -a "$LOG_FILE"; then
        log "DEPLOY OK: $(git rev-parse --short HEAD)"
        exit 0
    else
        log "SMOKE FAILED — rolling back to $PRE_DEPLOY_SHA"
        _rollback
        exit 1
    fi
fi

log "DEPLOY OK (no smoke): $(git rev-parse --short HEAD)"
exit 0


_rollback() {
    log "ROLLBACK: git checkout $PRE_DEPLOY_SHA"
    git checkout --quiet "$PRE_DEPLOY_SHA" || true
    for svc in "${SERVICES_TO_BUILD[@]}"; do
        docker compose -f "$COMPOSE_DIR/docker-compose.yml" build "$svc" 2>&1 | tee -a "$LOG_FILE" || true
    done
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d "${SERVICES_TO_BUILD[@]}" 2>&1 | tee -a "$LOG_FILE" || true
}
