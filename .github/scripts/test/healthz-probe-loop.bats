#!/usr/bin/env bats
#
# Unit tests for `.github/scripts/healthz-probe-loop.sh`.
#
# The integration-level cover (the rehearse-chat-firing job in
# .github/workflows/rehearse-healthz-degraded.yml) exercises the same
# script end-to-end against staging once a week. These tests cover the
# pure-shell logic on every PR so a regression in the dedup guards,
# notify-log contract, exit-code mapping, or rehearsal clear hook is
# caught in CI rather than at 04:17 UTC on Sunday.
#
# Stubs (.github/scripts/test/stubs/) intercept `pnpm`, `curl`, and
# `sentry-cli` via PATH manipulation so the tests run hermetically with
# no network and no real workspace install.

setup() {
  TEST_TMP="$(mktemp -d)"
  export STUB_STATE_DIR="$TEST_TMP/state"
  mkdir -p "$STUB_STATE_DIR"

  STUB_DIR="$BATS_TEST_DIRNAME/stubs"
  export PATH="$STUB_DIR:$PATH"

  export NOTIFY_LOG_FILE="$TEST_TMP/notify.log"
  : > "$NOTIFY_LOG_FILE"

  export NOTIFY_WEBHOOK="https://hooks.example.com/services/T/B/X"
  export NOTIFY_CHANNEL="#ops-test"
  export GITHUB_REPOSITORY="acme/repo"
  export GITHUB_RUN_ID="42"
  export HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS="60000"

  # Skip the inter-iteration sleep so the suite finishes in well under
  # a second instead of `iterations * 60s`.
  export PROBE_LOOP_SLEEP_SECONDS=0
  export PROBE_LOOP_ITERATIONS=3

  # Sensible defaults — each test can override these before run_loop.
  export STUB_PNPM_EXITS="0 0 0"
  export STUB_PNPM_OUTPUTS=""
  export STUB_NOTIFY_CODES="200 200 200 200 200"
  export STUB_CLEAR_CODES="200 200"

  # Keep the Sentry forwarder branch off by default; tests opt in
  # explicitly when they need to assert on it.
  unset SENTRY_DSN SENTRY_ORG SENTRY_PROJECT
  unset REHEARSAL_CLEAR_AFTER_ITERATION REHEARSAL_CLEAR_URL \
        REHEARSAL_CLEAR_TOKEN REHEARSAL_CLEAR_SUBSYSTEM
  # The script writes a final summary to GITHUB_STEP_SUMMARY when any
  # iteration fails — give it a sandboxed file so we don't pollute the
  # real workflow summary in CI.
  export GITHUB_STEP_SUMMARY="$TEST_TMP/step_summary.md"
  : > "$GITHUB_STEP_SUMMARY"
}

teardown() {
  rm -rf "$TEST_TMP"
}

run_loop() {
  bash "$BATS_TEST_DIRNAME/../healthz-probe-loop.sh"
}

# Convenience: count lines of a given kind in NOTIFY_LOG_FILE.
# `grep -c` exits 1 when there are zero matches, which would propagate
# through `$(...)` and trip `set -e`-style harnesses; awk avoids that.
notify_lines_for() {
  awk -v kind="$1" '$1 == kind { n++ } END { print n + 0 }' "$NOTIFY_LOG_FILE"
}

# ---------------------------------------------------------------------
# Exit-code mapping
# ---------------------------------------------------------------------

@test "all-green run: no chat posts, exit 0" {
  export PROBE_LOOP_ITERATIONS=3
  export STUB_PNPM_EXITS="0 0 0"

  run run_loop
  [ "$status" -eq 0 ]
  [ ! -s "$NOTIFY_LOG_FILE" ]
  [ ! -f "$STUB_STATE_DIR/notify_count" ]
}

@test "exit 1 (probe error, not page) does NOT post a chat message" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="1 1"

  run run_loop
  # Any non-zero iteration flips the script's overall exit to 1.
  [ "$status" -eq 1 ]
  # No chat heads-up because exit 1 is a probe-host error, not a page.
  [ ! -s "$NOTIFY_LOG_FILE" ]
  [ ! -f "$STUB_STATE_DIR/notify_count" ]
}

@test "any paging iteration flips overall exit to 1, all-green stays 0" {
  export PROBE_LOOP_ITERATIONS=4
  export STUB_PNPM_EXITS="0 0 2 0"

  run run_loop
  [ "$status" -eq 1 ]
  # Run-summary block was written for the failure path.
  grep -q "Healthz degraded probe failed" "$GITHUB_STEP_SUMMARY"
}

# ---------------------------------------------------------------------
# Dedup guards: at most one FIRING and one RESOLVED per run
# ---------------------------------------------------------------------

@test "single page emits exactly one FIRING line" {
  export PROBE_LOOP_ITERATIONS=1
  export STUB_PNPM_EXITS="2"

  run run_loop
  [ "$status" -eq 1 ]
  [ "$(notify_lines_for firing)" -eq 1 ]
  [ "$(notify_lines_for resolved)" -eq 0 ]
}

@test "three consecutive pages dedup to exactly one FIRING" {
  export PROBE_LOOP_ITERATIONS=3
  export STUB_PNPM_EXITS="2 2 2"

  run run_loop
  [ "$status" -eq 1 ]
  [ "$(notify_lines_for firing)" -eq 1 ]
  [ "$(notify_lines_for resolved)" -eq 0 ]
  # Webhook was hit once (one chat post), even though pnpm exited 2 thrice.
  [ "$(cat "$STUB_STATE_DIR/notify_count")" -eq 1 ]
}

@test "page then recover emits one FIRING and one RESOLVED" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 0"

  run run_loop
  [ "$status" -eq 1 ]
  [ "$(notify_lines_for firing)" -eq 1 ]
  [ "$(notify_lines_for resolved)" -eq 1 ]
  # FIRING came first, then RESOLVED.
  first_kind=$(awk '{print $1}' "$NOTIFY_LOG_FILE" | head -n1)
  second_kind=$(awk '{print $1}' "$NOTIFY_LOG_FILE" | sed -n '2p')
  [ "$first_kind" = "firing" ]
  [ "$second_kind" = "resolved" ]
}

@test "page, page, recover, recover: one FIRING and one RESOLVED only" {
  export PROBE_LOOP_ITERATIONS=4
  export STUB_PNPM_EXITS="2 2 0 0"

  run run_loop
  [ "$status" -eq 1 ]
  [ "$(notify_lines_for firing)" -eq 1 ]
  [ "$(notify_lines_for resolved)" -eq 1 ]
}

@test "all-green run does NOT post a stale RESOLVED" {
  # Cross-run recovery is intentionally NOT posted; only a recovery
  # *after* a same-run page produces a RESOLVED.
  export PROBE_LOOP_ITERATIONS=3
  export STUB_PNPM_EXITS="0 0 0"

  run run_loop
  [ "$status" -eq 0 ]
  [ "$(notify_lines_for resolved)" -eq 0 ]
}

# ---------------------------------------------------------------------
# NOTIFY_LOG_FILE format contract: `<kind> <code|skipped>`
# (this is what the rehearse-chat-firing job greps for)
# ---------------------------------------------------------------------

@test "log line format is '<kind> <code>' for HTTP 200" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 0"
  export STUB_NOTIFY_CODES="200 200"

  run run_loop
  [ "$status" -eq 1 ]
  grep -E -x 'firing 200' "$NOTIFY_LOG_FILE"
  grep -E -x 'resolved 200' "$NOTIFY_LOG_FILE"
}

@test "log line records HTTP 204 success the same way" {
  export PROBE_LOOP_ITERATIONS=1
  export STUB_PNPM_EXITS="2"
  export STUB_NOTIFY_CODES="204"

  run run_loop
  grep -E -x 'firing 204' "$NOTIFY_LOG_FILE"
}

@test "log line is '<kind> skipped' when NOTIFY_WEBHOOK is unset" {
  unset NOTIFY_WEBHOOK
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 0"

  run run_loop
  [ "$status" -eq 1 ]
  grep -E -x 'firing skipped' "$NOTIFY_LOG_FILE"
  grep -E -x 'resolved skipped' "$NOTIFY_LOG_FILE"
  # Curl was never invoked because the webhook is unset.
  [ ! -f "$STUB_STATE_DIR/notify_count" ]
}

@test "log line is '<kind> 000' on a curl-level failure" {
  export PROBE_LOOP_ITERATIONS=1
  export STUB_PNPM_EXITS="2"
  export STUB_NOTIFY_CODES="000"

  run run_loop
  grep -E -x 'firing 000' "$NOTIFY_LOG_FILE"
}

@test "log line records non-2xx HTTP errors verbatim (e.g. 429)" {
  export PROBE_LOOP_ITERATIONS=1
  export STUB_PNPM_EXITS="2"
  export STUB_NOTIFY_CODES="429"

  run run_loop
  grep -E -x 'firing 429' "$NOTIFY_LOG_FILE"
}

# ---------------------------------------------------------------------
# Transient-failure retry: notified_firing/_resolved stay 0 on non-2xx
# so the next paging/healthy iteration in the same run gets another shot
# ---------------------------------------------------------------------

@test "FIRING retries on next paging iteration after a 429" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 2"
  export STUB_NOTIFY_CODES="429 200"

  run run_loop
  [ "$status" -eq 1 ]
  # Two firing log lines: one failed (429), one succeeded (200).
  [ "$(notify_lines_for firing)" -eq 2 ]
  grep -E -x 'firing 429' "$NOTIFY_LOG_FILE"
  grep -E -x 'firing 200' "$NOTIFY_LOG_FILE"
}

@test "FIRING retries on next paging iteration after a curl-level 000" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 2"
  export STUB_NOTIFY_CODES="000 200"

  run run_loop
  [ "$status" -eq 1 ]
  [ "$(notify_lines_for firing)" -eq 2 ]
  grep -E -x 'firing 000' "$NOTIFY_LOG_FILE"
  grep -E -x 'firing 200' "$NOTIFY_LOG_FILE"
}

@test "RESOLVED retries on next healthy iteration after a 429" {
  export PROBE_LOOP_ITERATIONS=3
  export STUB_PNPM_EXITS="2 0 0"
  # Codes (in webhook-call order): firing 200, resolved 429, resolved 200
  export STUB_NOTIFY_CODES="200 429 200"

  run run_loop
  [ "$status" -eq 1 ]
  [ "$(notify_lines_for firing)" -eq 1 ]
  [ "$(notify_lines_for resolved)" -eq 2 ]
  grep -E -x 'firing 200' "$NOTIFY_LOG_FILE"
  grep -E -x 'resolved 429' "$NOTIFY_LOG_FILE"
  grep -E -x 'resolved 200' "$NOTIFY_LOG_FILE"
}

# ---------------------------------------------------------------------
# REHEARSAL_CLEAR_AFTER_ITERATION mid-loop hook
# ---------------------------------------------------------------------

@test "rehearsal clear hook is a no-op when REHEARSAL_CLEAR_AFTER_ITERATION is unset" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 0"
  # REHEARSAL_CLEAR_AFTER_ITERATION intentionally not set (production behaviour).

  run run_loop
  [ "$status" -eq 1 ]
  # No clear-call ever made; only the two notify webhook calls landed.
  [ ! -f "$STUB_STATE_DIR/clear_count" ]
}

@test "rehearsal clear hook fires exactly once after the configured iteration" {
  export PROBE_LOOP_ITERATIONS=3
  export STUB_PNPM_EXITS="2 0 0"
  export REHEARSAL_CLEAR_AFTER_ITERATION=1
  export REHEARSAL_CLEAR_URL="https://staging.example.com/api/_rehearsal/clear-stuck-degraded"
  export REHEARSAL_CLEAR_TOKEN="rehearsal-token"
  export REHEARSAL_CLEAR_SUBSYSTEM="rateLimitStore"

  run run_loop
  [ "$status" -eq 1 ]
  # Exactly one POST to the clear endpoint.
  [ "$(cat "$STUB_STATE_DIR/clear_count")" -eq 1 ]
  # Targeted the configured URL and forwarded the configured subsystem.
  grep -F "url=$REHEARSAL_CLEAR_URL" "$STUB_STATE_DIR/curl.log"
  grep -F '"subsystem":"rateLimitStore"' "$STUB_STATE_DIR/curl.log"
  # Both FIRING (iter 1) and RESOLVED (iter 2) chat posts landed —
  # this is the rehearsal's whole point.
  [ "$(notify_lines_for firing)" -eq 1 ]
  [ "$(notify_lines_for resolved)" -eq 1 ]
}

@test "rehearsal clear hook does NOT fire if REHEARSAL_CLEAR_URL is missing" {
  export PROBE_LOOP_ITERATIONS=2
  export STUB_PNPM_EXITS="2 0"
  export REHEARSAL_CLEAR_AFTER_ITERATION=1
  # Deliberately leave REHEARSAL_CLEAR_URL unset.

  run run_loop
  # Loop still runs to completion; the hook just no-ops.
  [ "$status" -eq 1 ]
  [ ! -f "$STUB_STATE_DIR/clear_count" ]
}

@test "rehearsal clear hook does not fire on iterations other than N" {
  export PROBE_LOOP_ITERATIONS=4
  export STUB_PNPM_EXITS="2 2 0 0"
  export REHEARSAL_CLEAR_AFTER_ITERATION=2
  export REHEARSAL_CLEAR_URL="https://staging.example.com/api/_rehearsal/clear-stuck-degraded"
  export REHEARSAL_CLEAR_TOKEN="rehearsal-token"
  export REHEARSAL_CLEAR_SUBSYSTEM="db"

  run run_loop
  [ "$status" -eq 1 ]
  # Only the iteration-2 boundary triggered a clear call.
  [ "$(cat "$STUB_STATE_DIR/clear_count")" -eq 1 ]
  grep -F '"subsystem":"db"' "$STUB_STATE_DIR/curl.log"
}
