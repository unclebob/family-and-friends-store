# Install the Merit agent

This is the procedure. It was not run. The agent is not loaded, `~/ffstore` was not created, and `carddav.py` was not pointed at iCloud.

The agent opens the `merit.wsUrl` socket from `site.config.json` unless `MERIT_URL` is set. Load it only after the Worker is deployed, the Keychain item (`merit.linkKeychainService` in `site.config.json`) exists, and the list files are ready. A missing secret makes launchd restart the process.

## Node

The plist expects Node at `/opt/homebrew/bin/node`. If that path is missing, install Node with Homebrew (`brew install node`).

## Repo

The plist runs `merit-agent/agent.mjs` from the checkout path configured in `site.config.json` (`merit.repoDir`).

## Keychain

Two generic-password items named in `site.config.json`. Do not print either secret, and do not put them in the plist or the repo.

- `merit.carddavKeychainService` is the iCloud CardDAV password for `merit.carddavUser`. `carddav.py` reads it.
- `merit.linkKeychainService` is the Merit link secret. The agent reads it when `MERIT_SECRET` is unset.

Create them in Keychain Access, or with `security add-generic-password`. Prefer a prompt over a password on the command line, so the secret does not land in the shell history or the process list.

## Lists

`FFSTORE_HOME` in the plist is `~/ffstore` (`merit.ffstoreHome` in `site.config.json`). Create that directory and the list files only when you mean to. This note does not create them.

## Load in the GUI session

Copy `merit-agent/ffstore-agent.plist.example` to a local plist (gitignored as `merit-agent/*.plist`), fill in the values from `site.config.json`, and load it:

```bash
cp merit-agent/<label>.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
```

`LimitLoadToSessionType` is `Aqua`, so the job stays in the graphical session. These commands were not run.

## Local run

A local agent has to set `MERIT_URL`. The default is the production socket from `site.config.json`.

```bash
FFSTORE_HOME=/tmp/ffstore MERIT_SECRET=dev-merit-secret MERIT_URL=ws://127.0.0.1:8787/merit/ws node --experimental-strip-types merit-agent/agent.mjs
```
