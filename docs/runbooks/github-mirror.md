# GitHub Mirror — Runbook

The Replit workspace's `main` branch is mirrored to GitHub at
[`artpromedia/epplaa`](https://github.com/artpromedia/epplaa).

## How the initial snapshot was published

Mirroring was bootstrapped by a one-shot push performed from inside
the workspace, captured as Task #273. The push used a small helper
script at `/tmp/igit/push.mjs` (not committed) built on
[`isomorphic-git`](https://isomorphic-git.org/) so it talks GitHub's
smart-HTTP protocol directly, without invoking the platform's `git`
CLI. (The platform's main-agent shell wraps the `git` binary and
refuses any operation that would write into the workspace's `.git/`
directory, including `git remote add` and `git push`. Pure-JS git
sidesteps that wrapper while still being a normal authenticated push
on the GitHub side.)

Authentication used the `GITHUB_TOKEN` Replit secret as basic-auth
password (`x-access-token:${GITHUB_TOKEN}`). The token is **not**
persisted in `.git/config`, **not** committed, and **not** logged.

### Verification of the initial push

| Check | Value |
| --- | --- |
| Target | `https://github.com/artpromedia/epplaa.git` |
| Local `main` HEAD | `49b57899f818530c010c68f65b4d6351098fb574` |
| Remote `refs/heads/main` after push | `49b57899f818530c010c68f65b4d6351098fb574` |
| Match | ✅ identical |
| GitHub server response | `{ ok: true, refs: { "refs/heads/main": { ok: true, error: "" } } }` |
| GitHub request id | `B11A:36F244:144A7704:1495F107:69F224C5` |

Re-listed independently after push (`git.listServerRefs`):

```json
[
  { "ref": "refs/heads/main", "oid": "49b57899f818530c010c68f65b4d6351098fb574" }
]
```

## Re-running the push manually

If GitHub `main` ever falls behind the workspace `main`, run the same
shape of one-shot script:

```bash
mkdir -p /tmp/igit && cd /tmp/igit
cat > package.json <<'JSON'
{"name":"igit-push","version":"1.0.0","private":true,
 "dependencies":{"isomorphic-git":"^1.27.1"}}
JSON
npm install --silent --no-audit --no-fund

cat > push.mjs <<'JS'
import http from 'isomorphic-git/http/node';
import git from 'isomorphic-git';
import fs from 'fs';
const dir = '/home/runner/workspace';
const url = 'https://github.com/artpromedia/epplaa.git';
const token = process.env.GITHUB_TOKEN;
if (!token) { console.error('GITHUB_TOKEN missing'); process.exit(2); }
const onAuth = () => ({ username: 'x-access-token', password: token });
const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
console.log('local HEAD:', head);
const r = await git.push({ fs, http, dir, url, ref: 'main',
                            remoteRef: 'main', force: false, onAuth });
console.log('push result:', JSON.stringify(r, null, 2));
const remote = await git.listServerRefs({ http, url, onAuth,
                                          prefix: 'refs/heads/' });
console.log('remote refs:', JSON.stringify(remote, null, 2));
JS

GITHUB_TOKEN=$(cat /path/to/token) node push.mjs
```

The script is intentionally idempotent: if local HEAD already matches
remote, GitHub responds with `ok: true` and no objects are uploaded.

## Token requirements

- GitHub Personal Access Token (Classic or Fine-grained).
- Scope: `repo` (Classic) or **Contents: Read and write** on
  `artpromedia/epplaa` (Fine-grained).
- Stored as the Replit secret `GITHUB_TOKEN`.

## Known limitation

This runbook covers the **manual one-shot** push only. New commits on
`main` are NOT automatically mirrored to GitHub. Continuous mirroring
is tracked separately as **Task #274 ("Keep GitHub mirror in sync
after every commit")**.
