# Fleet: machines, routes and sessions across computers

Ponte's home node sees every machine you reach: the devices on your Tailscale, the concrete `Host` entries of `~/.ssh/config` and the Ponte mesh. For each one it checks the SSH route (latency or a stable error code), reads what agents it has, and lets a Claude Code, Codex or Jcode session started on one machine continue on another. The typical case: work on the notebook at the office, get home, continue the same conversation on the PC.

Nothing is installed on the other machines. The probe (`backend/fleet-probe.py`, stdlib only, Python 3.8+) goes over SSH as `python3 -` on stdin.

## Look

```sh
./ponte fleet                 # machines, routes, cached health
./ponte fleet list --check    # connect to every key route now
./ponte fleet sessions        # recent agent sessions everywhere, each with its continue command
./ponte fleet --json ...      # the server answer, for agents
```

The same through `ponte ctl` (JSON envelope, schema in `ponte ctl schema`): `fleet list [--deep] [--fresh]`, `fleet sessions`, `fleet check`, `fleet probe --machine ssh:ALIAS`, `fleet handoff`, `fleet jobs`, `fleet job --id ID [--wait 60]`. The phone shows the Home card "Machines and connections".

Machine ids are `self` or `ssh:ALIAS` (the alias of `~/.ssh/config` used to reach it). A route is:

| kind | meaning | checked |
|---|---|---|
| `key` | a key login (`BatchMode` works) | yes |
| `tailscale-ssh` | Tailscale SSH, may ask for a browser check | no |
| `hop` | a `RemoteCommand` jump: terminals only | no |

Health: `ok`, `degraded` (SSH works, the probe failed), `unreachable` (with `TIMEOUT`, `DNS`, `REFUSED`, `UNREACHABLE`, `HOST_KEY`, `AUTH`, `TAILSCALE_CHECK` or `FAILED`), `unchecked`, `no-ssh` (on the tailnet, no key route), `offline`. Checks share one SSH master per machine (`ControlPersist=600`), so after the first one a probe costs one round trip.

## Continue a session here

```sh
./ponte fleet continue claude 5e5e…f1ee --from ssh:notebook            # to this machine
./ponte fleet continue codex 01a0…9513 --from self --to ssh:notebook   # or the other way
  --git branch    # default: bring the branch by fast-forward
  --git changes   # also carry uncommitted edits and new files as a patch
  --git none      # leave the project alone
  --plan          # check both sides, change nothing
  --no-resume     # copy only
  --force         # the session is still open there, or the copy here is newer (a backup stays)
```

A handoff is a job (`202` + id; `fleet job --wait`), in steps:

1. **session**: where it ran and whether it is still open (an open agent stops the job unless forced).
2. **project**: the same repository on the destination, by `origin` (the source's path under `~` first, then `~/Projects/NAME`, then any checkout two levels deep); cloned into `~/Projects/NAME` when missing.
3. **git**: the branch travels as a `git bundle` of only the commits the destination lacks, then a fast-forward. Never a merge, reset or checkout over edits: a dirty destination (`FLEET_DEST_DIRTY`) or a diverged branch (`FLEET_DIVERGED`) stops the job and nothing is touched.
4. **changes** (`--git changes`): `git diff --binary HEAD` plus untracked files; an untracked file that already exists stops it.
5. **copy**: the session files, streamed from one probe to the other, with the source's home and cwd rewritten to the destination's. Claude transcripts are filed under the destination project's folder; a Jcode copy is marked `Closed`. A newer copy at the destination needs `--force` and is kept as `*.ponte-bak`.
6. **resume**: a Ponte terminal on the destination runs `claude --resume ID`, `codex resume ID` or `jcode --resume ID` in the project. Here directly; on a paired mesh node through `/api/fleet/resume`. Anywhere else the job returns the command to run by hand.

Job errors carry a `FLEET_*` code, the stage and `text: {en, pt}`.

## Known limits

- The destination must be logged in to the agent. Codex in a Ponte terminal uses the destination's `~/.codex/auth.json`; without it `codex resume` opens its login screen.
- A Codex rollout copied without its `state_5.sqlite` row is found by `codex resume ID` (it scans `~/.codex/sessions`); it may be missing from `codex resume`'s picker until Codex indexes it.
- Sessions of the last 14 days, 30 per machine. Claude runs from `-p`/SDK and transcripts under 2 KB are not listed.
- Windows machines and phones are listed, never probed.
