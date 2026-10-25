# Progress

Local v2 app in this directory. Specs stay in `~/junk/family-and-friends-store`.

## Domain

Configured in `site.config.json` (`family.<domain>` and `friends.<domain>`). Locally, use `?host=family` or `?host=friends`. DNS is already on Cloudflare. This project does not change DNS, Email Routing, Access, or any Cloudflare account setting.

## Works

Checked on 2026-10-20, after the pre-deploy fixes. Nothing was deployed.

- Visibility, the one serializer, and Merit's resolution order (SPEC §3, §5, §9). Family responses omit price. Friend responses omit other wishers. Hidden items and photos are 404.
- A friend's topics are the `default` grant list plus that friend's own list. The default comes first, and a repeated slug appears once. No `default` key means the default is empty. A contact appended on the friends host gets the same list. The slugs live in grants.yaml. They are not constants in the code. SPEC §3 steps 3 and 4 now say that.
- Migration `0002_seed_topics.sql` inserts the eight topics in spec order and is safe to run again (`ON CONFLICT(slug) DO UPDATE`). `POST /dev/seed` only adds the sample brooch and pilot logbook, and only when the catalog has no items. A second call inserts nothing.
- vCard FN and EMAIL values drop a trailing carriage return, including the `&#13;` iCloud puts in the XML, before display and before the address compare. The CardDAV query uses `starts-with` so a value that still ends in `&#13;` can come back, and the stripped address is checked again. `carddav.py` was not run against iCloud.
- Login codes: 6 digits, hashed, 20 minutes, single-use, host-bound, 5 attempts, rate limits. In dev the response includes `devCode` and the message is stored in the D1 outbox. In production the same message is sent through Resend (`RESEND_API_KEY`, `MAIL_FROM`) and the response does not contain the code. A failed send returns a generic error. Tests stub `fetch`. No real email was sent.
- `?host=` and `x-ff-host` work only when `ENV` is `dev`. Production accepts only the configured `family.<domain>` and `friends.<domain>` hosts. Any other hostname is 404. `/dev/*` is 404 unless `ENV` is `dev`.
- `wrangler.jsonc` and `site.config.json` are gitignored; copy `wrangler.jsonc.example`, `site.config.example.json`, and `.dev.vars.example` for local dev.
- MeritLink in fake mode, and the same object over a live WebSocket.
- Topics, items, the wish checkbox, and admin accept. In dev, winner and apology mail go to the D1 outbox (`recipient`). In production they go through Resend.
- An accept log line is delivered once to the agent, including when the socket is down at first. A retry after the id file is lost does not write a second CSV line.
- The Merit agent reads its default socket, CardDAV user, and Keychain item names from `site.config.json`. `merit-agent/INSTALL.md` and `merit-agent/ffstore-agent.plist.example` describe a GUI-session install. The agent was not loaded, and `~/ffstore` was not created.
- The Preact UI builds. It was not clicked in a browser.

## Tests

```bash
npm test
npm run test:agent
npm run types
npx tsc --noEmit
npx tsc -p web/tsconfig.json --noEmit
npm run build
npx wrangler d1 migrations apply ffstore --local
npm run dev
~/projects/crapper/crapper --threshold 10
~/projects/dryer/dryer --threshold 0.8
~/projects/mutator/mutator --use-existing-coverage --max-workers 4 src web/src merit-agent/agent.mjs merit-agent/lists.mjs
```

`npm test` is 52 tests. `npm run test:agent` is 6 tests. Both typechecks passed. `npm run build` passed. `npm run types` writes `worker-configuration.d.ts`, which is gitignored. With `.dev.vars` present, that file types `ENV` as `string` and includes the dev secrets.

`crapper --threshold 10` exits 0. The worst score is still `postCode` at 9.5. Python `coverage` is not installed (PEP 668), so `carddav.py` scores 0% and its functions stay at complexity 2 or less. Do not add an `npm run coverage` script. The full-tree mutator run was not repeated. The browser was not clicked.

Open `http://127.0.0.1:8787/?host=family`. Use "Use the local stand-in for Merit", then a configured admin address, `ada@example.com`, or `bea@example.com`. The page shows the code. Mail is at `http://127.0.0.1:8787/dev/outbox?host=family`.

A local agent must set `MERIT_URL=ws://127.0.0.1:8787/merit/ws`. The default is the production socket from `site.config.json`. Do not point `FFSTORE_HOME` at `~/ffstore`, and do not run `merit-agent/carddav.py` against iCloud, until instructed.

## Next

Ask before replacing the D1 `database_id`, signing in to Cloudflare, deploying, sending real email, loading the launchd agent, or writing `~/ffstore`.

## Not done, on purpose

No deploy, no DNS or Cloudflare account changes, no real email, no launchd load, and no writes to Merit's `~/ffstore`.

## Spec notes, left as written

- `REVISED-FLOW.md` still says both subdomains require moving DNS to Cloudflare later. `START-HERE.md` says the domain was bought at Cloudflare Registrar on 2026-10-20, so DNS is already there. The build follows `START-HERE.md` and does not change DNS.
- `REVISED-FLOW.md` says the wrong-subdomain check happens at the door, before Merit sees the email. The check on Merit is the one to keep. SPEC §3 now says that, and the code does that. The lists live only on Merit, so the Worker always sends the lookup. Merit returns `wrong_host` before CardDAV. A contact who is not on the family list is not appended when they try the family host.
- SPEC §8 now names the outbox column `recipient`, because `to` is reserved in SQLite. Production mail uses Resend and does not write that table.
