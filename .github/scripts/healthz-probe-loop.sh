#!/usr/bin/env bash
# Per-minute /healthz degraded probe loop. Source of truth for the
# production probe's iterate -> page -> chat-firing logic. Invoked by:
#
#   - .github/workflows/check-healthz-degraded.yml
#       Production scheduler. 5 iterations × 60s sleep = ~per-minute
#       cadence; default env values match this and the workflow does
#       not override them.
#
#   - .github/workflows/rehearse-healthz-degraded.yml
#       Weekly rehearsal of the *production probe's* chat-firing path
#       against staging's synthetic stuck-degraded streak. Overrides
#       PROBE_LOOP_ITERATIONS / _SLEEP_SECONDS for fast iteration and
#       sets the REHEARSAL_CLEAR_* hooks below so iteration N pages and
#       iteration N+1 recovers — exercising both the FIRING and the
#       RESOLVED chat posts in a single run.
#
# Extracting this body out of the inline `cat <<'PROBE_LOOP'` heredoc
# (where it used to live) is what makes the rehearsal possible: both
# workflows now run the SAME script, so a regression in the dedup
# logic / JSON parsing / curl call surfaces in the rehearsal *before*
# a real outage instead of during one. See task #86 in the runbook.
#
# Tunable env vars (production defaults shown):
#
#   PROBE_LOOP_ITERATIONS         — number of iterations (default 5).
#   PROBE_LOOP_SLEEP_SECONDS      — sleep between iterations (default 60).
#   NOTIFY_WEBHOOK                — Slack/Teams incoming webhook URL.
#                                   Empty -> chat path is no-op'd.
#   NOTIFY_CHANNEL                — cosmetic channel label included in
#                                   the chat message body and the GH
#                                   log line. Routing is determined by
#                                   the webhook URL, not this value.
#   NOTIFY_LOG_FILE               — when set, every notify_chat call
#                                   appends one line of the form
#                                   `<kind> <http_code>` (e.g.
#                                   `firing 200`, `resolved 204`,
#                                   `<kind> skipped` when NOTIFY_WEBHOOK
#                                   is unset, `<kind> 000` on a
#                                   curl-level failure). The rehearsal
#                                   uses this to assert both FIRING and
#                                   RESOLVED posts landed without
#                                   scraping stdout. Production leaves
#                                   it unset.
#   SENTRY_DSN, SENTRY_ORG,       — when SENTRY_DSN is set, each
#   SENTRY_PROJECT                  iteration that exits non-zero
#                                   forwards the JSON line to Sentry
#                                   via `sentry-cli send-event`.
#   HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS — referenced in the FIRING
#                                          message body when the probe
#                                          JSON line lacks a
#                                          `thresholdMs` field.
#
# Rehearsal-only hooks (default empty / disabled — leave unset for
# the per-minute probe; production behaviour is unchanged):
#
#   REHEARSAL_CLEAR_AFTER_ITERATION — when set to a positive integer N,
#                                     the loop POSTs to REHEARSAL_CLEAR_URL
#                                     after iteration N to clear the
#                                     synthetic streak so iteration N+1
#                                     observes a recovered subsystem
#                                     and fires the RESOLVED chat post.
#   REHEARSAL_CLEAR_URL             — clear-stuck-degraded endpoint URL.
#   REHEARSAL_CLEAR_TOKEN           — X-Rehearsal-Token header value.
#   REHEARSAL_CLEAR_SUBSYSTEM       — subsystem to clear (rateLimitStore | db).
#
# Exit code: 1 if any iteration exited non-zero, else 0. The
# per-iteration exit code is preserved in the Sentry payload's
# `extra.exit_code` and in the run-summary block at the end.

set +e

ITERATIONS=${PROBE_LOOP_ITERATIONS:-5}
SLEEP_SECONDS=${PROBE_LOOP_SLEEP_SECONDS:-60}

fails=0
last_output=""
last_code=0
# Track whether we've already posted a "firing" / "resolved" chat
# message in this workflow run so we mirror Sentry's fingerprint
# dedup: one chat post per page (not five), and at most one matching
# "resolved" if a later iteration recovers. Across-run state is
# intentionally not tracked — if a streak spans multiple 5-minute
# runs, each run's first paging iteration re-announces, which is the
# right behaviour for an ongoing incident that hasn't been ack'd yet.
notified_firing=0
notified_resolved=0
firing_iteration=0
run_url="https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

# Helper: POST a `{"text": ...}` payload to NOTIFY_WEBHOOK (Slack
# incoming webhook OR Teams workflow webhook — both accept this
# shape). No-op when NOTIFY_WEBHOOK is unset (degrade-safe). A non-2xx
# response is logged via ::warning:: but never aborts the probe loop
# — a broken chat path must not interfere with the Sentry pager path.
#
# When NOTIFY_LOG_FILE is set, appends `<kind> <code>` per call so
# callers (specifically the rehearsal job) can assert what was posted.
notify_chat() {
  local text="$1"
  local kind="${2:-other}"
  if [ -z "$NOTIFY_WEBHOOK" ]; then
    if [ -n "$NOTIFY_LOG_FILE" ]; then
      printf '%s skipped\n' "$kind" >> "$NOTIFY_LOG_FILE"
    fi
    return 0
  fi
  local payload
  payload=$(jq -nc --arg text "$text" '{text: $text}')
  local code body
  code=$(curl -sS -o /tmp/notify_resp -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    --data "$payload" "$NOTIFY_WEBHOOK" || echo "000")
  body=$(cat /tmp/notify_resp 2>/dev/null || true)
  if [ -n "$NOTIFY_LOG_FILE" ]; then
    printf '%s %s\n' "$kind" "$code" >> "$NOTIFY_LOG_FILE"
  fi
  if [ "$code" != "200" ] && [ "$code" != "204" ]; then
    echo "::warning::notify webhook returned HTTP $code (body: $body) — chat heads-up did not reach ${NOTIFY_CHANNEL}; check webhook URL rotation"
    return 1
  fi
  echo "chat heads-up posted to ${NOTIFY_CHANNEL} (HTTP $code)"
}

i=0
while [ "$i" -lt "$ITERATIONS" ]; do
  i=$((i+1))
  echo "::group::iteration $i (UTC $(date -u +%FT%TZ))"
  out=$(pnpm --silent --filter @workspace/api-server run check-healthz-degraded 2>&1)
  code=$?
  # Always echo the probe's structured line into the GH log so
  # operators can see the full sequence even when the iteration
  # didn't fail.
  printf '%s\n' "$out"
  if [ "$code" -ne 0 ]; then
    fails=$((fails+1))
    last_output="$out"
    last_code="$code"
    echo "::error::probe iteration $i exited $code"
    if [ -n "$SENTRY_DSN" ]; then
      # Forward the probe's JSON line to Sentry as a fatal-level
      # message. The fingerprint groups all iterations of this
      # alert into a single Sentry issue so on-call gets one page,
      # not five.
      sentry-cli send-event \
        --message "rate_limit_store_stuck_degraded (probe exit $code)" \
        --level fatal \
        --tag "subsystem:rate_limit" \
        --tag "alert:rate_limit_store_stuck_degraded" \
        --tag "exit_code:$code" \
        --tag "scheduler:github-actions" \
        --tag "workflow:check-healthz-degraded" \
        --fingerprint "rate_limit_store_stuck_degraded" \
        --extra "probe_output=$out" \
        --extra "exit_code=$code" \
        --extra "iteration=$i" \
        --extra "workflow_run=$run_url" \
        || echo "::warning::sentry-cli send-event failed (Sentry forwarder error, not the probe itself)"
    else
      echo "::warning::HEALTHZ_PROBE_SENTRY_DSN not configured; relying on GitHub workflow-failure notification"
    fi
    # Chat heads-up on the FIRST paging iteration (exit 2) in this
    # run. Subsequent paging iterations are silent in chat —
    # Sentry rolls them up into one issue and #ops doesn't need 5
    # copies. exit 1 (probe error, not a stuck-degraded page)
    # deliberately stays silent on chat: a probe-host error isn't
    # an api outage and would only confuse #ops. The GitHub
    # failed-workflow notification still covers the exit-1 case.
    if [ "$code" -eq 2 ] && [ "$notified_firing" -eq 0 ]; then
      # Pull subsystem / streak duration / threshold straight from
      # the probe's JSON line so the chat post matches what
      # Sentry's `extra.probe_output` would show. jq falls through
      # to defaults when the line isn't valid JSON (e.g. probe
      # printed a stderr error before the JSON), so a malformed
      # body still produces a useful post instead of an empty one.
      subsystem=$(printf '%s' "$out" | jq -r '.subsystem // "unknown"' 2>/dev/null || echo "unknown")
      if [ -z "$subsystem" ] || [ "$subsystem" = "null" ]; then subsystem="unknown"; fi
      duration_ms=$(printf '%s' "$out" | jq -r '.durationMs // 0' 2>/dev/null || echo "0")
      if [ -z "$duration_ms" ] || [ "$duration_ms" = "null" ]; then duration_ms="0"; fi
      threshold_ms=$(printf '%s' "$out" | jq -r '.thresholdMs // 0' 2>/dev/null || echo "0")
      if [ -z "$threshold_ms" ] || [ "$threshold_ms" = "null" ] || [ "$threshold_ms" = "0" ]; then
        threshold_ms="$HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS"
      fi
      text=$(printf '%s\n%s\n%s' \
        ":rotating_light: *Healthz stuck-degraded page FIRING* on production (${NOTIFY_CHANNEL}, run \`${GITHUB_RUN_ID}\`)." \
        "Subsystem: \`${subsystem}\`, streak duration: \`${duration_ms}ms\` (> threshold \`${threshold_ms}ms\`). On-call has been paged via Sentry — this post is so #ops sees the incident in real time. See runbook: docs/runbooks/rate-limit-store.md (Step 5)." \
        "Workflow run: ${run_url}")
      # Only mark the firing notification as "delivered" when
      # notify_chat actually succeeded (or no-op'd because the
      # webhook is unset — that's a config decision, not a
      # transient failure, so retrying every iteration would just
      # spam ::warning::s into the log without changing outcome).
      # On a transient HTTP failure (rotated webhook URL,
      # Slack/Teams 5xx, runner network blip) we LEAVE
      # notified_firing=0 so the next paging iteration in this run
      # gets another chance to deliver the heads-up. The Sentry
      # pager path is unaffected either way.
      if notify_chat "$text" firing; then
        notified_firing=1
        firing_iteration=$i
      else
        echo "::warning::firing chat post failed on iteration $i; will retry on the next paging iteration in this run"
      fi
    fi
  else
    # Recovery heads-up. Only post if a previous iteration in THIS
    # run paged AND we haven't already posted a resolved message.
    # Cross-run recovery (this run is all-green after a previous
    # run paged) is intentionally NOT posted — Sentry's auto-resolve
    # on the issue is the source of truth across runs, and posting
    # on every green run would flood #ops between incidents.
    if [ "$notified_firing" -eq 1 ] && [ "$notified_resolved" -eq 0 ]; then
      text=$(printf '%s\n%s\n%s' \
        ":white_check_mark: *Healthz stuck-degraded page RESOLVED* on production (${NOTIFY_CHANNEL}, run \`${GITHUB_RUN_ID}\`)." \
        "Iteration $i went back to exit 0 after iteration ${firing_iteration} paged. The probe sees the subsystem as healthy again from this run's perspective; confirm via the Sentry issue and \`/healthz\` before fully closing the incident." \
        "Workflow run: ${run_url}")
      # Same retry-on-transient-failure pattern as the firing post:
      # leave notified_resolved=0 if the chat path was transiently
      # broken so the next healthy iteration can try again. (No-op
      # when webhook is unset still counts as success — see
      # notify_chat above.)
      if notify_chat "$text" resolved; then
        notified_resolved=1
      else
        echo "::warning::resolved chat post failed on iteration $i; will retry on the next healthy iteration in this run"
      fi
    fi
  fi
  echo "::endgroup::"
  # Rehearsal hook: after iteration REHEARSAL_CLEAR_AFTER_ITERATION,
  # POST clear-stuck-degraded so the synthetic streak goes away and
  # the next iteration sees a recovered subsystem (which is what
  # triggers the RESOLVED chat post). Empty/unset in production —
  # the production probe never has anything to "clear", so this hook
  # is a no-op there.
  if [ -n "$REHEARSAL_CLEAR_AFTER_ITERATION" ] \
     && [ "$i" -eq "$REHEARSAL_CLEAR_AFTER_ITERATION" ] \
     && [ -n "$REHEARSAL_CLEAR_URL" ]; then
    echo "::group::rehearsal: clearing synthetic streak after iteration $i"
    clear_resp=$(curl -sS -w '\n%{http_code}' \
      -X POST "$REHEARSAL_CLEAR_URL" \
      -H 'Content-Type: application/json' \
      -H "X-Rehearsal-Token: $REHEARSAL_CLEAR_TOKEN" \
      --data "{\"subsystem\":\"${REHEARSAL_CLEAR_SUBSYSTEM}\"}")
    clear_body=$(printf '%s' "$clear_resp" | head -n -1)
    clear_code=$(printf '%s' "$clear_resp" | tail -n 1)
    echo "rehearsal clear response (HTTP $clear_code): $clear_body"
    if [ "$clear_code" != "200" ]; then
      echo "::warning::rehearsal clear endpoint returned HTTP $clear_code — RESOLVED chat post may not fire because the synthetic streak is still in effect"
    fi
    echo "::endgroup::"
  fi
  # Don't sleep after the last iteration so the run finishes
  # promptly; this also keeps the next scheduled tick close to a
  # 60s gap from this one in production.
  if [ "$i" -lt "$ITERATIONS" ]; then sleep "$SLEEP_SECONDS"; fi
done

if [ "$fails" -gt 0 ]; then
  # Echo the last failing JSON line into the failure summary so
  # the GitHub failed-run notification body is useful even without
  # clicking through to logs.
  {
    echo "## Healthz degraded probe failed"
    echo ""
    echo "$fails of $ITERATIONS iterations exited non-zero. Last failing iteration:"
    echo ""
    echo '```json'
    printf '%s\n' "$last_output"
    echo '```'
    echo ""
    echo "Exit code: $last_code"
  } >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi
