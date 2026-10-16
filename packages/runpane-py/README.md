# runpane

Install or configure Pane from PyPI.

The package does not include the Pane desktop runtime. It downloads the correct
Pane release artifact only when you run `runpane install` or `runpane update`.

The same CLI also drives a running Pane app: list and add repos, create and
manage panes, read and send input to panels, manage sessions, and follow events
with `runpane watch`. See the
[runpane CLI contract](https://github.com/greenfield-inc/Pane/blob/main/docs/RUNPANE_CLI_CONTRACT.md) for every command.

`runpane panes adopt` is not in the Python CLI yet; use the npm package for it.

## Quick Start

Run the guided setup:

```bash
pipx run runpane
```

Persistent install:

```bash
python -m pip install runpane
python -m runpane setup
```

The wizard can install Pane on this machine, configure this machine as a remote
host, update Pane, or run diagnostics.

## MCP Server

The Pane MCP server (`runpane mcp`) ships in the npm package and inside the
Pane desktop app, not in this package. Run it with Node:
`npx --yes runpane@latest mcp`.

## Advanced

### Explicit Commands

```bash
pipx run runpane setup
pipx run runpane install client
pipx run runpane install daemon --label "My Server"
pipx run runpane update
pipx run runpane doctor
```

`runpane install daemon` installs Pane and then invokes the installed executable
with `--remote-setup`, preserving the `pane-remote://...` connection-code output.

### Python Runners

One-shot execution:

```bash
uvx runpane@latest
```

Persistent install:

```bash
python -m pip install runpane
python -m runpane setup

pipx install runpane
runpane setup
```

### Commands

```bash
runpane
runpane setup
runpane install
runpane install client
runpane install daemon
runpane update
runpane version
runpane doctor
runpane --help
```

### Common Options

```bash
--version <latest|vX.Y.Z>
--format <auto|appimage|deb|dmg|zip|exe>
--download-dir <path>
--pane-path <path>
--dry-run
--verbose
```

Daemon setup also forwards Pane remote-host options:

```bash
--label <name>
--prefer-tunnel <tailscale|ssh|manual|auto>
--print-only
```

### Watching the Workspace

`runpane watch` waits for workspace transitions from the Pane daemon without
polling. Under `--follow` it prints one line per event: `READY` (a turn ended),
`BLOCKED` (the agent is waiting on a human), `IDLE`, `STUCK` (real unsubmitted
composer text; an agent prompt suggestion never counts), `NEW`, `GONE`, `EXIT`,
and optional `HEARTBEAT` lines when enabled with `--heartbeat`.

```bash
runpane watch --self-test
runpane watch --follow
```

`--follow` uses the unattended profile: READY settles for 3 minutes, BLOCKED
for 30 seconds, and non-urgent events batch every 10 minutes. IDLE starts at
10 minutes and backs off to 30 minutes, 1 hour, 3 hours, then daily. Heartbeats
are off. WATCH OK prints once when armed; WATCH EXPIRED and exit 0 end a watch
after 3 quiet hours. Meaningful events reset expiry; IDLE and replay do not.

Use `--present` or `--profile present` when someone is waiting: READY settles
for 1 minute, BLOCKED for 15 seconds, batches every 2 minutes, and IDLE does
not back off. `--profile unattended` explicitly selects the default. Duration
overrides accept `30s`, `3m`, `3h`, or `0`: `--ready-settle`, `--blocked-settle`,
`--min-interval`, `--idle-after`, `--expire-after`, `--heartbeat`, and
watch `--timeout-ms` (for example, `--until-event --timeout-ms 30s`).
`--expire-after 0` disables natural expiry. Bare values retain milliseconds,
except heartbeat's legacy seconds. `--json` selects NDJSON; otherwise lines.

```bash
runpane watch --session <session-id> --follow --json
runpane watch --session <session-id> --follow --profile present --json
runpane watch --pane <pane-id> --until-event --json
```

Session membership changes need no re-arm. Named cursors survive daemon
restarts; the journal and PR baselines are saved together. RESET/DROPPED mean
refresh the overview; replayed baseline entries never mean a new READY.
`--until-event` waits for REPORT, BLOCKED, EXIT or GONE by default and exits 0
when one arrives. Override `--kinds` for PR events. Its `--timeout-ms` is a
total deadline (exit 124); under follow it bounds each daemon request.

REPORT remains the completion signal: workers use `runpane report --state
ready|blocked|failed|done --summary-file <path>`, adding a PR/head and a question
when blocked. READY alone is activity evidence. Read the full report with
`runpane agents status --panel <id> --json`. Resume stopped workers in the same
panel with `runpane panels resume --panel <id> --wait-ready --yes --json`.

Do not pipe follow through `head` or `grep -m1` to wait. Run `--until-event` as
a supported background task, act on its events, then re-arm with its cursor.
Never sleep-poll your own background task output. WATCH ERROR/nonzero exit
means failure: report it and re-arm once. A superseded cursor means keep the
replacement. A normal expiry means re-arm with the next dispatch.

### Watching a PR from any Pane

```bash
runpane pr watch --pane <pane-id> --url https://github.com/owner/repo/pull/123 --head <full-sha> --json
runpane watch --pane <pane-id> --since <generation-returned-above> --until-event --json --kinds pr.checks,pr.conflicted,pr.head,pr.review,pr.comment,pr.closed,pr.merged,pr.stopped,github.unavailable,github.recovered
runpane pr list --pane <pane-id> --json
runpane pr unwatch --pane <pane-id> --url https://github.com/owner/repo/pull/123 --json
```

Inside a Pane, registration defaults to its `PANE_SESSION_ID`. Keep the last
printed event's generation for the next wait. Registration uses the full
host/repository/number identity. It pins success to `--head`, or the first
observed head; a new head emits `pr.head` and needs a fresh registration before
success can be reported. Read existing discussions before arming. A wake
means inspect the change; it never authorizes merging.

The daemon batches up to 25 fingerprints per host every two minutes (plus up
to ten seconds of jitter), reads details on changes and at a 30-minute
backstop, and keeps 10% of GitHub quota for interactive work. It uses `gh auth
token` for cached authentication and direct GraphQL for reads. Session PR
branch discovery still uses Pane's existing `gh pr list` lookup.

Failures emit immediately, even while other checks run. Success requires a
complete, nonempty set of checks on the pinned head and all required checks
passing (all checks when none are marked required). BLOCKED/UNKNOWN merge
status conservatively withholds success, including when reviews are missing.
Comments/reviews from the authenticated account are excluded. Merge/close,
eight non-rate-limit failures, or ten comment-only updates stop registration;
archiving/deleting the Pane removes it. Rate limits pause instead of consuming
the failure budget. Outages and recovery are journal events.

Removed flags fail with replacement guidance: `--settle` became
`--ready-settle`; `--format` became `--json`; all-managed/agents-only,
quiet/no-control-lines, and idle-backoff are covered by defaults or profiles.

## Attribution

PyPI package downloads use `source=pip` when requesting release artifacts from
`runpane.com/api/download`. If that route is unavailable, the CLI falls back to
matching GitHub release assets and prints a warning.

The wrapper sends best-effort command failures and download lifecycle telemetry
with a persisted anonymous `install_id`. Successful routine commands emit nothing.
Distinct `install_id` counts on `runpane_wrapper_*` events measure installs that
report failures or download activity, not all CLI users. Telemetry is disabled in
CI, when local analytics is explicitly opted out, or with `RUNPANE_TELEMETRY_DISABLED=1`.

## Maintenance Notes

Keep the npm and PyPI clients in sync with each Pane release. When changing
shared installer behavior:

- If release asset names or platforms change, update both npm and PyPI wrapper
  artifact matching.
- If `runpane` CLI behavior changes, update both clients and the shared smoke
  tests.
- If the website `/api/download` contract changes, verify npm and PyPI fallback
  behavior.
- If daemon setup flags change, update docs, README files, and wrapper tests
  together.
- Keep the CI wrapper matrix green: Linux, macOS, Windows, Node 20/22, and
  Python 3.8/3.13 (runs on PRs that touch the wrappers or contract).

## Publishing

This package should be published through PyPI Trusted Publishing from GitHub
Actions. Token-based `PYPI_API_TOKEN` publishing is a fallback for first package
reservation or manual publication only.
