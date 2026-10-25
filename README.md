# Family & Friends Store

## The Problem

Over a lifetime, grandparents accumulate a house full of meaningful things—jewelry, books, aviation gear, art, dishes, tools, electronics, and family mementos. Eventually comes the time to downsize and pass those treasures along to the people who will actually cherish or use them: children, grandchildren, extended family, and close friends.

Doing that well is surprisingly hard:

- **Group texts and spreadsheets get messy fast.** Sending photos of dozens or hundreds of items over email or group chat turns into an awkward free-for-all where people either hesitate to speak up or step on each other's toes.
- **Family and friends have different relationships to the items.** For family, these are heirlooms and mementos—there should never be a price tag attached, and it helps when family members can see who else in the family is interested and whether someone wants an item right away ("Want it now") or only when the time comes ("Someday"). For friends, some items are gifts and others have a modest asking price, different friends have different shared interests (topics), and one friend's wishes are nobody else's business.
- **Grandparents want to decide thoughtfully, not run a first-come-first-served race.** When someone expresses interest, it should be recorded quietly as a wish. The grandparents get a calm daily digest, talk it over, and accept a wish when they are ready—at which point the recipient gets a warm note, anyone else who wished for that item gets a polite note, and the item moves through staging (`staged`) to handoff (`delivered`).
- **Personal contact lists shouldn't live in a public cloud database.** Who counts as family, who counts as a friend, and their phone numbers and email addresses already live in the grandparents' own contacts and local lists at home—not on a third-party server.

**Family & Friends Store** is a small, private household catalog built to solve that problem.

---

## How It Works

### Two Doors: `family.<domain>` and `friends.<domain>`

The same Cloudflare Worker serves two subdomains with tailored rules enforced on the server:

- **Family (`family.<domain>`):**
  - Sees all topics and all open catalog items.
  - **Never sees prices.** The server serializer strips prices from every family response, and the item-entry tools reject dollar amounts in descriptions.
  - Can see which other family members have also wished for an item (for example, `Also wanted by: Bea (someday), Cy`).
  - Receives a morning announcement email whenever new items were added the day before, with signed inline photos and direct `#item-<id>` links that open that item's topic tab and scroll straight to the item.

- **Friends (`friends.<domain>`):**
  - Sees only the topics granted to them (a default topic list plus any per-friend topic grants).
  - Sees the asking price when an item has one.
  - Never sees who else has wished for an item.
  - Anyone in the household's iCloud Contacts who isn't already on the family list can sign in at `friends.<domain>` and is automatically added to the friends list with the default topic grants.

### Wishing, Accepting, Staging, and Delivering

1. **Passwordless sign-in:** Visitors sign in with their email address (or phone number, matched against the household phone list) and enter a 6-digit code sent via Resend.
2. **Two kinds of wishes:** On any open item, a member can tap **Want it now** or **Someday** (or tap again to withdraw their wish).
3. **Daily admin digest:** Every morning, the admins receive a summary email of new wishes from the previous day, plus a morning announcement email to family when new items were posted.
4. **Admin review & fulfillment:** On `/admin` and `/wishes`, admins can filter items and wishes, add or edit items and photos, cancel a wish on someone's behalf, or **Accept** a wish. Accepting an item hides it from non-admin visitors, sends the acceptance and polite runner-up emails, records the decision to the household log, and lets admins track physical handoff through **Staged** and **Delivered** states.

### Privacy & the Local Home Agent (`merit-agent/`)

The Cloudflare Worker stores catalog items, photos (in R2), and wishes (in D1), but **the member lists and address book stay on a home Mac**:

- A lightweight local daemon (`merit-agent/agent.mjs`) opens an outbound authenticated WebSocket (`MeritLink` Durable Object) to the Worker.
- When someone signs in, the Worker asks the home agent to resolve their email or phone number against the local text lists (`admins.txt`, `family.txt`, `friends.txt`, `grants.yaml`, `phones.txt`) and, if needed, queries macOS iCloud CardDAV (`merit-agent/carddav.py`) using a Keychain password.
- When an admin accepts a wish, the Worker streams an idempotent CSV log line back to the home agent's local `accepted.csv`.

---

## Configuration & Privacy

No secrets, passwords, email addresses, domain names, or database IDs are stored in this repository. All deployment and household identifiers live in gitignored local files:

- `site.config.json` — domain name, D1 database UUID, admin names/emails, `MAIL_FROM`, `REPORT_TO`, `FAMILY_REPLY_TO`, and local agent paths/Keychain service names (copy from `site.config.example.json`).
- `wrangler.jsonc` — Cloudflare Worker config (copy from `wrangler.jsonc.example`).
- `.dev.vars` — local development secrets (copy from `.dev.vars.example`).

```bash
cp site.config.example.json site.config.json
cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
```

---

## Running & Testing Locally

```bash
npm install
npm test
npm run test:agent
python3 -m unittest discover -s merit-agent
npm run types
npx tsc --noEmit
npx tsc -p web/tsconfig.json --noEmit
npm run build
npx wrangler d1 migrations apply ffstore --local
npm run dev
```

Open `http://127.0.0.1:8787/` (or add `?host=friends` in dev mode to preview the friends view). On the sign-in screen, click **Use the local stand-in for Merit** to load sample contacts (`admin@example.com`, `ada@example.com` as family, `bea@example.com` as a friend with `jewelry` access), request a sign-in code, and inspect outgoing dev emails at `http://127.0.0.1:8787/dev/outbox`.

---

## Command-Line Item Tool (`scripts/ffstore-item`)

Admins (or an assistant working on their behalf) can also list topics and add or edit items and photos from the terminal—shrinking iPhone HEIC, JPEG, PNG, and WebP photos to 1600 px JPEG automatically and enforcing the no-prices-in-descriptions rule:

```bash
scripts/ffstore-item [--live] topics
scripts/ffstore-item [--live] add --topic <slug> --title "<title>" [--description "<text>"] [--price <dollars>] --photo <path>
scripts/ffstore-item [--live] list [--topic <slug>]
scripts/ffstore-item [--live] show <id>
scripts/ffstore-item [--live] photo-add <id> <path>
scripts/ffstore-item [--live] edit <id> [--title "<title>"] [--description "<text>"] [--price <dollars or "">]
```

See `scripts/ffstore-item.md` for full details and `merit-agent/INSTALL.md` for setting up the local home agent.
