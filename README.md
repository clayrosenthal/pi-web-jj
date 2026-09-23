# pi-web-jj

Jujutsu (`jj`) workspace provider and panel for [PI WEB](https://pi-web.dev).

PI WEB only bundles a Git provider. On a jj repo (colocated or not) that shows
detached HEADs and `refs/jj/*` noise, and it cannot see `jj workspace add`
workspaces. This plugin claims any project with a `.jj/` directory (before Git)
and provides:

- **Workspaces** — every `jj workspace` is a PI WEB workspace; `default` is main.
  Stale workspaces (directory deleted) are listed in the panel with a _forget_ button.
- **jj panel** — where `@` is, the stack (`trunk() | trunk()..@ | @::`), per-change
  diff with file filter, op log, and a _Snapshot_ button.
- **Labels** — `@ spvtkour · mainline` next to each workspace in the sidebar.
- **Pull** — runs the `jj pull` alias (fetch all remotes + rebase mutable work onto
  `trunk()`) in the visible terminal, then refreshes. Any conflicted changes show
  in a banner with **Resolve with agent**, which inserts a prompt invoking the
  `jj-pull` pi skill (`configs/pi/skills/jj-pull/`) so the session agent resolves them.
- **Actions** — `jj: New workspace` (runs `jj workspace add`), `jj: Open panel`,
  `jj: Refresh panel`, `jj: Pull and resolve conflicts (agent)`.
- **Removal** — the host's "Forget jj workspace" runs
  `jj workspace forget <name> && rm -rf <path>` in a visible terminal. `default`
  is never removable.

Every read runs with `--ignore-working-copy`, so opening the panel never creates
an operation while an agent is editing. Only _Snapshot_, _New workspace_ and
_forget_ mutate the repo, and all are user-triggered.

## Install

```bash
cd pi-web-jj
npm install && npm run build
mkdir -p ~/.pi-web/plugins && ln -s "$PWD" ~/.pi-web/plugins/jj
systemctl --user restart pi-web-sessiond     # server entries load once per sessiond start
```

Then reload the browser. Check **Settings → PI WEB plugins** shows `jj` as active.
Restarting `pi-web-sessiond` interrupts running sessions — do it from a shell,
not from a pi session.

Requires PI WEB `1.202609.1`+ (browser plugin API v4, server API v3) and jj `0.43`+ on the login-shell `PATH` of the
session daemon (mise shims via `~/.zprofile` are fine).

## Settings

`~/.pi-web/config.json`:

```json
{
    "plugins": {
        "jj": {
            "enabled": true,
            "settings": {
                "jjPath": "jj",
                "workspaceBaseDir": "~/jj-workspaces"
            }
        }
    }
}
```

- `jjPath` — jj executable (default `jj`, resolved on sessiond's `PATH`).
- `workspaceBaseDir` — where `jj: New workspace` creates directories, as
  `<workspaceBaseDir>/<project-name>/<name>`. Default: `<project>/../.jj-workspaces/<project-name>/`.

Settings are captured at sessiond start.

## Backend operations

Served through the package peer (`context.peer.request(op, input)` from this plugin's browser entry):

| op                 | input                                      | result                                                                        |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `status`           | `{}`                                       | `{ workspace, where, stack: Commit[], conflicts: Commit[], staleWorkspaces }` |
| `diff`             | `{ revision? } \| { from?, to? }`, `path?` | `{ patch, truncated }` (git format, ≤1 MiB)                                   |
| `files`            | same as `diff`                             | `[{ status: "A"\|"M"\|"D"\|…, path }]`                                        |
| `oplog`            | `{ limit? }`                               | `[{ id, description, time, snapshot, workspace }]`                            |
| `snapshot`         | `null`                                     | `{ ok }` — the only read that snapshots                                       |
| `workspace.add`    | `{ name, revision? }`                      | `{ name, path }`                                                              |
| `workspace.forget` | `{ name }`                                 | `{ ok, name }`                                                                |

`Commit` = `{ change, changePrefix, changeFull, commit, commitFull, description,
bookmarks, parents, isWorkingCopy, conflict, empty, immutable, author, timestamp }`.

## Interop

- **pi-jj** (Pi extension) keeps working; its checkpoints are the same op ids the
  _Op log_ tab shows.
- **Git worktrees** created by other tools are not jj workspaces and will not be
  listed. Use `jj: New workspace`, or `jj workspace add` in a terminal.
- To go back to the Git panel for one machine, disable `jj` in
  **Settings → PI WEB plugins** and restart sessiond.

## Development

```bash
npm run check    # typecheck
npm run build    # emit dist/
```

`dist/` is committed so a fresh dotfiles checkout can symlink the package without
a build step. Rebuild and commit after changing `src/`.
