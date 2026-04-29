#!/bin/bash
set -e

# Mirror the freshly-merged `main` to https://github.com/artpromedia/epplaa.git
# so the GitHub backup/collaboration mirror stays current. This is the
# automation behind task #274: without it, future commits made in the
# Replit workspace never appear on GitHub until someone runs `git push`
# manually.
#
# Runs FIRST on purpose: the rest of post-merge (pnpm install, DB
# migrations) is environment setup for the dev/runtime container — if
# any of those fail, we still want the new commit reflected on the
# off-site mirror. Running the push first means a broken `pnpm install`
# can't strand the mirror behind the workspace.
#
# A failure here is loud on purpose — `set -e` propagates the non-zero
# exit and the platform surfaces the failed post-merge step in the
# merge log so it doesn't go unnoticed. See
# `scripts/src/syncGithubMirror.ts` for the push logic and exit codes,
# and the README of @workspace/scripts for how to re-run by hand.
pnpm --filter @workspace/scripts run sync-github-mirror

pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force
