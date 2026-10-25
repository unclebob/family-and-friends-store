# Family & Friends Store

Local build of the household catalog. The decisions are in `~/junk/family-and-friends-store`.

The site runs on `family.<domain>` and `friends.<domain>`, configured in `site.config.json`. Nothing here deploys, and DNS is not changed.

## Run

Copy the example config files before running tests or `wrangler dev`:

```bash
cp site.config.example.json site.config.json
cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
```

`site.config.json`, `wrangler.jsonc`, and `.dev.vars` stay out of git. `wrangler.jsonc` is the production Worker config: `ENV` is `production`, and `MERIT_SECRET`, `CODE_PEPPER`, and `RESEND_API_KEY` are Worker secrets, not vars. Tests do not read `.dev.vars`; Vitest sets `ENV=dev` and the dev secrets itself. Production sends mail through Resend and never returns a login code. Dev writes the D1 outbox and returns `devCode`.

```bash
npm test
npm run test:agent
npm run types
npx tsc --noEmit
npx tsc -p web/tsconfig.json --noEmit
npm run build
npx wrangler d1 migrations apply ffstore --local
npm run dev
```

Open `http://127.0.0.1:8787/`. Both sites behave the same, so local development always runs as the family host. On the sign-in screen, use "Use the local stand-in for Merit", then sign in as an admin from `site.config.json`, `ada@example.com`, or `bea@example.com`. The dev screen shows the 6-digit code. Mail is stored in D1 and can be read at `http://127.0.0.1:8787/dev/outbox`.

## Merit agent

The agent lives in `merit-agent/`. Its default socket comes from `site.config.json` (`merit.wsUrl`). It is not loaded. Install notes are in `merit-agent/INSTALL.md`. It will not write `~/ffstore` unless `FFSTORE_HOME` points there. Ask before that.

```bash
FFSTORE_HOME=/tmp/ffstore MERIT_SECRET=dev-merit-secret MERIT_URL=ws://127.0.0.1:8787/merit/ws node --experimental-strip-types merit-agent/agent.mjs
```
