# Loops

A loop runs an agent or command on a schedule. Each run gets its own Pane
(workspace) in a fresh worktree and branch, so the result of a nightly bug sweep
or a weekly dependency check is ready to review like any other Pane.

A loop is a cron schedule plus the same request `runpane panes create` takes:

- the repository (`--repo`)
- the agent (`--agent claude`, `codex` or `cursor`) or a custom command
  (`--tool-command`, such as `agent-farm run <task>`)
- an optional prompt sent when the run starts (`--prompt <text>`, or
  `--prompt-file <path>` to read it from a file; `-` reads stdin)
- a worktree and branch name template (`--worktree-name`), `loop-<name>` by
  default. Each run adds its date and time, such as
  `loop-nightly-bug-sweep-20261024-0300`.

## When to use a loop

Use a loop for a large job that should run on a schedule: a nightly bug sweep,
a weekly docs audit, a Monday dependency check. Loops run at most once an hour.

An agent that needs to wait a few minutes, for CI or a review, sleeps and
wakes with its own tools (such as a sleep command or its harness's wake-up
timer).

## In the app

Open **Loops** in the sidebar, under Home and Pane Chat. The Loops page lists
every loop across your projects. Select one to see its schedule, next run, the
strip of its last 10 runs and a table of those runs. **+ New** and **Edit** open
a side drawer where you pick the project, what runs (Claude, Codex, Cursor or a
command), and the schedule. Presets write the cron for you and the drawer shows
it as a sentence with the next three run times.

A run's Pane shows a loop header above its tabs: the loop's name and schedule,
Run now, Pause and Edit, and a rail that switches between the loop's runs.

## From the CLI

Create a loop that starts Claude every day at 03:00:

```bash
runpane loops create --repo active --name nightly-bug-sweep \
  --cron "0 3 * * *" --agent claude \
  --prompt "Pick one bug from yesterday's issues, fix it, and open a PR." --yes
```

Run a custom command every Monday at 09:00:

```bash
runpane loops create --repo my-app --name dependency-check \
  --cron "0 9 * * 1" --tool-command "agent-farm run dependency-check" --yes
```

Check a schedule before saving it. `--dry-run` prints the schedule in words and
the next run time, and saves nothing:

```bash
runpane loops create --repo active --name docs-audit --cron "0 16 * * 5" \
  --agent codex --prompt-file audit.md --dry-run
```

Manage loops by id (`runpane loops list` shows it):

```bash
runpane loops list
runpane loops update --loop <id> --cron "0 4 * * *" --yes
runpane loops run --loop <id> --yes
runpane loops pause --loop <id> --yes
runpane loops resume --loop <id> --yes
runpane loops delete --loop <id> --yes
```

`--repo` takes the same selectors as `panes create`: `active` (the repo
selected in the app), a repo id, an exact path or a saved name. Commands that
change a loop need `--yes` when run from a script or agent; in a terminal they
ask first. `update` changes only the values you pass; `--agent` and
`--tool-command` replace each other. Add `--json` to any command for
machine-readable output. The same commands are MCP tools: `loops_list`,
`loops_create`, `loops_update`, `loops_run`, `loops_pause`, `loops_resume` and
`loops_delete`, in the `loops` toolset (see
[Pane MCP Server](PANE_MCP.md#toolsets)).

## Rules

- **Schedule.** One five-field cron expression, in the local time zone of the
  machine running Pane. `0 3 * * *` is every day at 03:00; `0 9 * * 1` is
  Mondays at 09:00.
- **At most once an hour.** Saving rejects a cron whose runs fall less than 60
  minutes apart.
- **Pane must be running.** Runs start only while Pane is running on that
  machine.
- **Missed runs.** A run up to 15 minutes late still starts. A later one is
  recorded as skipped. Missed runs are never caught up.
- **Overlap.** A run starts even if the previous one is still going.
- **Kept runs.** Pane keeps each loop's last 10 runs and archives older run
  Panes. A run Pane with uncommitted or unpushed work is not archived; it stays
  under its project for you to review.
- **Delete.** Deleting a loop stops its schedule. Its run Panes stay, as
  normal Panes.
- **Pause.** A paused loop starts no scheduled runs. Resuming picks up at the
  next scheduled time.
- **Permissions.** Runs are unattended, so Claude, Codex and Cursor runs skip
  their permission prompts. A `--tool-command` runs as written.
- **Folder trust.** Claude and Codex ask whether to trust a folder they have
  not seen, and each run is a new worktree. A run stopped at that prompt shows
  as **needs attention**. Open the run and answer it, or open the project
  folder in the agent once and trust it so later runs start on their own. Pane
  never answers a trust prompt for you.
- **Run now.** `runpane loops run` starts a run immediately, even while the
  loop is paused. The schedule stays the same, and the run counts toward the 10
  kept runs.

## Runs

Each run is a new Pane in a fresh worktree branched from the repository's
default base branch. It appears as a normal Pane under its project, and you
review its work the way you review any Pane.

`runpane loops list --json` lists each loop's newest runs. A run's `status` is
`started` (its Pane was created; `sessionId` is that Pane's id, so read its
progress with `runpane agents status --pane <sessionId>`; when `error` is set
too, the Pane started but its agent is waiting at a prompt such as folder
trust, never became ready, or Pane could not confirm the prompt arrived; the
app shows the run as needing attention), `failed` (the Pane
could not be created; `error` says why) or `skipped` (the run came and went
while Pane was not running).
