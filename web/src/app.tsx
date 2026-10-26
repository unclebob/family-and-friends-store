import { useEffect, useRef, useState } from "preact/hooks";
import { MoveTopic, type MoveOption } from "./move-topic";
import { matchesShow, ShowFilter, type Show } from "./show-filter";
import { cancelWish } from "./wish-actions";
import { Admin } from "./admin";
import { AllWishes } from "./wishes";
import { Note } from "./note";
import { api, firstField, listOrEmpty, money, textOr } from "./api";

type Me = { email: string; firstName: string; group: "admin" | "family" | "friend" };
type Topic = { id: number; slug: string; name: string; available?: number };
type WishKind = "now" | "someday";
type WishChange = { wished: boolean; kind?: WishKind };
type SetItems = (update: (current: Item[]) => Item[]) => void;
type Item = {
  id: number;
  title: string;
  description: string;
  wished: boolean;
  wishKind?: WishKind;
  priceCents?: number;
  alsoWantedBy?: { name: string; kind: WishKind }[];
  othersWishing?: number;
  activeWishes?: { id: number; name: string; kind: WishKind }[];
  status?: string;
  acceptedFor?: string;
  photos: { id: number; url: string }[];
};
type EmailReply = { ok: boolean; signedIn?: boolean; message?: string; devCode?: string; masked?: string; pending?: string };
// who goes with the code: the email typed, or the server's pending id after a phone start.
type Who = { email: string } | { pending: string };
type LoginPatch = { stage?: "email" | "code"; message: string; devCode?: string; who?: Who };

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [env, setEnv] = useState("");
  const page = location.pathname;
  const adminPage = page === "/admin" || page.startsWith("/admin/");
  useEffect(() => {
    void loadSession(setEnv, setMe, setReady);
  }, []);
  return (
    <main className="page">
      <header>
        <div>
          <h1>{titleText(me)}</h1>
        </div>
        <LogOff me={me} onLogout={() => void leave(setMe)} />
      </header>
      <nav className="parts">
        <AdminLinks me={me} />
        <BrowseLink me={me} adminPage={adminPage} />
      </nav>
      <Screen
        ready={ready}
        me={me}
        env={env}
        adminPage={adminPage}
        page={page}
        onDone={() => loadSession(setEnv, setMe, setReady)}
      />
    </main>
  );
}

function titleText(me: Me | null): string {
  if (me) return `Welcome, ${me.firstName}!`;
  return "Family & Friends";
}

function LogOff({ me, onLogout }: { me: Me | null; onLogout: () => void }) {
  if (!me) return null;
  return <button className="quiet" type="button" onClick={onLogout}>Log off</button>;
}

async function leave(setMe: (me: Me | null) => void): Promise<void> {
  await api("/logout", { method: "POST" });
  setMe(null);
}

function tabClass(current: string, selected: string): string {
  if (current === selected) return "on";
  return "";
}

function isAdmin(me: Me | null): boolean {
  if (!me) return false;
  return me.group === "admin";
}

function AdminLinks({ me }: { me: Me | null }) {
  if (!isAdmin(me)) return null;
  return (
    <>
      <a href="/admin">Admin</a>
      <a href="/admin/wishes">All wishes</a>
    </>
  );
}

function BrowseLink({ me, adminPage }: { me: Me | null; adminPage: boolean }) {
  if (!showBrowse(me, adminPage)) return null;
  return <a href="/">Browse</a>;
}

function showBrowse(me: Me | null, adminPage: boolean): boolean {
  if (!isAdmin(me)) return false;
  return adminPage;
}

type Where = { adminPage: boolean; page: string };

function Screen({ ready, me, env, adminPage, page, onDone }: Where & {
  ready: boolean;
  me: Me | null;
  env: string;
  onDone: () => Promise<boolean>;
}) {
  if (!ready) return <p>Loading…</p>;
  return <SignedIn me={me} env={env} adminPage={adminPage} page={page} onDone={onDone} />;
}

function SignedIn({ me, env, adminPage, page, onDone }: Where & {
  me: Me | null;
  env: string;
  onDone: () => Promise<boolean>;
}) {
  if (!me) return <Login env={env} onDone={onDone} />;
  return <Member me={me} adminPage={adminPage} page={page} />;
}

function Member({ me, adminPage, page }: Where & { me: Me }) {
  if (showAdmin(me, adminPage)) return <AdminPage page={page} />;
  return <BrowseOrEmpty me={me} adminPage={adminPage} />;
}

function AdminPage({ page }: { page: string }) {
  if (page === "/admin/wishes") return <AllWishes />;
  return <Admin />;
}

function showAdmin(me: Me, adminPage: boolean): boolean {
  if (!adminPage) return false;
  return isAdmin(me);
}

function BrowseOrEmpty({ me, adminPage }: { me: Me; adminPage: boolean }) {
  if (adminPage) return null;
  return <Browser me={me} />;
}

async function loadSession(
  setEnv: (env: string) => void,
  setMe: (me: Me | null) => void,
  setReady: (ready: boolean) => void,
): Promise<boolean> {
  const config = await api<{ env: string }>("/api/config");
  setEnv(config.body.env);
  const who = await api<Me>("/api/me");
  setMe(sessionUser(who));
  setReady(true);
  return who.status === 200;
}

function sessionUser(who: { status: number; body: Me }): Me | null {
  if (who.status === 200) return who.body;
  return null;
}

function Login({ env, onDone }: { env: string; onDone: () => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [message, setMessage] = useState("");
  const [devCode, setDevCode] = useState("");
  const [who, setWho] = useState<Who>({ email: "" });
  const apply = (patch: LoginPatch) => {
    applyPatch(patch, setStage, setMessage, setDevCode);
    if (patch.who) setWho(patch.who);
  };
  return (
    <section className="card">
      <LoginForm stage={stage} email={email} setEmail={setEmail} who={who} code={code} setCode={setCode} apply={apply} onDone={onDone} setMessage={setMessage} />
      <Note text={devCode} className="note" label="Local sign-in code:" />
      <Note text={message} />
      <DevMerit env={env} onUse={() => void localMerit(setMessage)} />
    </section>
  );
}

function applyPatch(
  patch: LoginPatch,
  setStage: (stage: "email" | "code") => void,
  setMessage: (message: string) => void,
  setDevCode: (devCode: string) => void,
): void {
  applyStage(patch.stage, setStage);
  setMessage(patch.message);
  applyText(patch.devCode, setDevCode);
}

function applyStage(stage: "email" | "code" | undefined, setStage: (stage: "email" | "code") => void): void {
  if (stage === undefined) return;
  setStage(stage);
}

function applyText(value: string | undefined, setValue: (value: string) => void): void {
  if (value === undefined) return;
  setValue(value);
}

function LoginForm({ stage, email, setEmail, who, code, setCode, apply, onDone, setMessage }: {
  stage: "email" | "code";
  email: string;
  setEmail: (email: string) => void;
  who: Who;
  code: string;
  setCode: (code: string) => void;
  apply: (patch: LoginPatch) => void;
  onDone: () => Promise<boolean>;
  setMessage: (message: string) => void;
}) {
  if (stage === "email") return <EmailForm email={email} setEmail={setEmail} apply={apply} onDone={onDone} />;
  return <CodeForm who={who} code={code} setCode={setCode} onDone={onDone} setMessage={setMessage} />;
}

function EmailForm({ email, setEmail, apply, onDone }: {
  email: string;
  setEmail: (email: string) => void;
  apply: (patch: LoginPatch) => void;
  onDone: () => Promise<boolean>;
}) {
  const [sending, run] = useBusy();
  return (
    <form onSubmit={(event) => run(() => submitEmail(event, email, apply, onDone))}>
      <label>
        Email or phone number
        <input type="text" value={email} autocomplete="username" onInput={(event) => setEmail(event.currentTarget.value)} />
      </label>
      <BusyButton busy={sending} label="Continue" busyLabel="Sending…" />
    </form>
  );
}

function submitEmail(event: Event, email: string, apply: (patch: LoginPatch) => void, onDone: () => Promise<boolean>): Promise<void> {
  event.preventDefault();
  return sendEmail(email, apply, onDone);
}

// While work runs, its form's button is disabled and says so.
function useBusy(): [boolean, (work: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  return [busy, run];
}

function BusyButton({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return <button type="submit" disabled={busy}>{busy ? busyLabel : label}</button>;
}

async function sendEmail(email: string, apply: (patch: LoginPatch) => void, onDone: () => Promise<boolean>): Promise<void> {
  const result = await api<EmailReply>("/login/email", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (result.body.signedIn) return void (await onDone()); // TEMPORARY test bypass: already signed in
  apply(emailPatch(result.body, email));
}

function emailPatch(body: EmailReply, email: string): LoginPatch {
  if (body.ok) return codeStage(body, email);
  return failedEmail(body);
}

function codeStage(body: EmailReply, email: string): LoginPatch {
  return { stage: "code", devCode: textOr(body.devCode, ""), ...codeTarget(body, email) };
}

// After a phone start only the masked address is shown; the code goes with the pending id.
function codeTarget(body: EmailReply, email: string): { message: string; who: Who } {
  if (!body.pending) return { message: "Enter the 6-digit code. It expires in 20 minutes.", who: { email } };
  return {
    message: `Check your email at ${textOr(body.masked, "your address")} for the 6-digit code. It expires in 20 minutes.`,
    who: { pending: body.pending },
  };
}

function failedEmail(body: EmailReply): LoginPatch {
  return { message: textOr(body.message, "Try again.") };
}

function CodeForm({ who, code, setCode, onDone, setMessage }: {
  who: Who;
  code: string;
  setCode: (code: string) => void;
  onDone: () => Promise<boolean>;
  setMessage: (message: string) => void;
}) {
  const [checking, run] = useBusy();
  return (
    <form onSubmit={(event) => run(() => submitCode(event, who, code, onDone, setMessage))}>
      <label>
        Code
        <input value={code} inputMode="numeric" autocomplete="one-time-code" onInput={(event) => setCode(event.currentTarget.value)} />
      </label>
      <BusyButton busy={checking} label="Sign in" busyLabel="Checking…" />
    </form>
  );
}

function submitCode(
  event: Event,
  who: Who,
  code: string,
  onDone: () => Promise<boolean>,
  setMessage: (message: string) => void,
): Promise<void> {
  event.preventDefault();
  return sendCode(who, code, onDone, setMessage);
}

async function sendCode(
  who: Who,
  code: string,
  onDone: () => Promise<boolean>,
  setMessage: (message: string) => void,
): Promise<void> {
  const result = await api<{ ok: boolean; message?: string }>("/login/code", {
    method: "POST",
    body: JSON.stringify({ ...who, code }),
  });
  await finishCode(result.body, onDone, setMessage);
}

const UNKEPT = "You're signed in, but this browser didn't keep the sign-in. Open the site in Safari or Chrome, or allow cookies.";

async function finishCode(
  body: { ok: boolean; message?: string },
  onDone: () => Promise<boolean>,
  setMessage: (message: string) => void,
): Promise<void> {
  if (!body.ok) return setMessage(textOr(body.message, "That code doesn't work."));
  if (!(await onDone())) setMessage(UNKEPT);
}

function DevMerit({ env, onUse }: { env: string; onUse: () => void }) {
  if (env !== "dev") return null;
  return <p><button className="quiet" type="button" onClick={onUse}>Use the local stand-in for Merit</button></p>;
}

async function localMerit(setMessage: (message: string) => void): Promise<void> {
  const result = await api<{ people?: string[] }>("/dev/merit", { method: "POST" });
  await api("/dev/seed", { method: "POST" });
  setMessage(peopleText(result.body.people));
}

function peopleText(people: string[] | null | undefined): string {
  return listOrEmpty(people).join(" ");
}

function Browser({ me }: { me: Me }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [slug, setSlug] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [show, setShow] = useState<Show>("all");
  useEffect(() => {
    void loadTopics(setTopics, setSlug);
  }, []);
  useEffect(() => {
    void loadItems(slug, setItems);
  }, [slug]);
  useEffect(() => {
    scrollToHash(location.hash);
  }, [items.length]);
  return (
    <section>
      <TopicTabs topics={topics} slug={slug} setSlug={setSlug} />
      <EmptyTopics topics={topics} />
      <AdminShow me={me} show={show} setShow={setShow} />
      <EmptyItems slug={slug} items={items} />
      {items.filter((item) => shownTo(item, show)).map((item) => (
        <CatalogItem key={item.id} item={item} me={me} topics={topics.filter((topic) => topic.slug !== slug)} setItems={setItems} reload={() => loadItems(slug, setItems)} />
      ))}
    </section>
  );
}

// Only admins get the filter; everyone else sees every item, as before.
function AdminShow({ me, show, setShow }: { me: Me; show: Show; setShow: (show: Show) => void }) {
  if (me.group !== "admin") return null;
  return <ShowFilter show={show} setShow={setShow} />;
}

// Only an admin can move show off "all".
function shownTo(item: Item, show: Show): boolean {
  return matchesShow(show, item.status, hasActiveWish(item));
}

// The member view leaves the viewer out of alsoWantedBy and reports their own
// active wish as wished, so together they cover every active wish.
function hasActiveWish(item: Item): boolean {
  return item.wished || listOrEmpty(item.alsoWantedBy).length > 0;
}

async function loadTopics(
  setTopics: (topics: Topic[]) => void,
  setSlug: (slug: string) => void,
): Promise<void> {
  const [result, hashed] = await Promise.all([
    api<{ topics: Topic[] }>("/api/topics"),
    hashTopic(location.hash),
  ]);
  const list = listOrEmpty(result.body.topics);
  setTopics(list);
  setSlug(keepSlug(hashed, list));
}

function keepSlug(current: string, list: Topic[]): string {
  if (current) return current;
  return firstField(list, "", (topic) => topic.slug);
}

async function hashTopic(hash: string): Promise<string> {
  const id = hashItemId(hash);
  if (!id) return "";
  const result = await api<{ item?: { topic?: string } }>(`/api/items/${id}`);
  return textOr(result.body.item?.topic, "");
}

function hashItemId(hash: string): string {
  if (!hash.startsWith("#item-")) return "";
  return hash.slice(6);
}

function scrollToHash(hash: string): void {
  document.getElementById(`item-${hashItemId(hash)}`)?.scrollIntoView();
}

async function loadItems(slug: string, setItems: (items: Item[]) => void): Promise<void> {
  if (!slug) {
    setItems([]);
    return;
  }
  const result = await api<{ items: Item[] }>(`/api/items?topic=${encodeURIComponent(slug)}`);
  setItems(shownItems(result));
}

function shownItems(result: { status: number; body: { items?: Item[] } }): Item[] {
  if (result.status !== 200) return [];
  return listOrEmpty(result.body.items);
}

function TopicTabs({ topics, slug, setSlug }: { topics: Topic[]; slug: string; setSlug: (slug: string) => void }) {
  return (
    <div className="tabs">
      {topics.map((topic) => (
        <button key={topic.slug} className={tabClass(topic.slug, slug)} type="button" onClick={() => setSlug(topic.slug)}>
          {topicLabel(topic)}
        </button>
      ))}
    </div>
  );
}

function topicLabel(topic: Topic) {
  return topic.available === undefined ? topic.name : `${topic.name} (${topic.available})`;
}

function EmptyTopics({ topics }: { topics: Topic[] }) {
  if (topics.length === 0) return <p>Nothing has been shared with you yet.</p>;
  return null;
}

function EmptyItems({ slug, items }: { slug: string; items: Item[] }) {
  if (!showEmptyItems(slug, items)) return null;
  return <p className="muted">Nothing in this topic yet.</p>;
}

function showEmptyItems(slug: string, items: Item[]): boolean {
  if (!slug) return false;
  return items.length === 0;
}

function CatalogItem({ item, me, topics, setItems, reload }: {
  item: Item;
  me: Me;
  topics: MoveOption[];
  setItems: (update: (current: Item[]) => Item[]) => void;
  reload: () => Promise<void>;
}) {
  return (
    <article className="item" id={`item-${item.id}`}>
      <Photos photos={item.photos} />
      <h2>{item.title}</h2>
      <ItemStatus item={item} />
      <p>{item.description}</p>
      <Price cents={item.priceCents} />
      <AlsoWanted me={me} item={item} />
      <OthersWishing count={item.othersWishing} />
      <WishControl me={me} item={item} setItems={setItems} />
      <AdminWishes me={me} item={item} topics={topics} reload={reload} />
    </article>
  );
}

// Admins can cancel any active wish from here, their own included.
function AdminWishes({ me, item, topics, reload }: { me: Me; item: Item; topics: MoveOption[]; reload: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  if (me.group !== "admin") return null;
  return (
    <>
      <MoveTopic itemId={item.id} topics={topics} say={setMessage} reload={reload} />
      {listOrEmpty(item.activeWishes).map((wish) => (
        <p key={wish.id}>
          {wish.kind === "someday" ? `${wish.name} (someday)` : wish.name}
          <button className="quiet" type="button" onClick={() => void cancelWish(wish, item.title, setMessage, reload)}>Cancel wish</button>
        </p>
      ))}
      <Note text={message} className="note" />
    </>
  );
}

// Friends tick a box; family and admins choose now or someday,
// and pressing the chosen one again withdraws the wish.
function ItemStatus({ item }: { item: Item }) {
  if (!closedStatus(item.status)) return null;
  return <p className="muted">{statusLine(item.status, item.acceptedFor)}</p>;
}

function closedStatus(status: string | undefined): status is string {
  return status !== undefined && status !== "open";
}

function statusLine(status: string, acceptedFor: string | undefined): string {
  if (!acceptedFor) return status;
  return `${status} · ${acceptedFor}`;
}

function WishControl({ me, item, setItems }: { me: Me; item: Item; setItems: SetItems }) {
  const [ack, showAck] = useAck();
  if (closedStatus(item.status)) return null;
  const friend = me.group === "friend";
  const wish = (change: WishChange) => {
    void sendWish(item, change, setItems).then((ok) => {
      if (ok) showAck(ackText(change, friend));
    });
  };
  return (
    <>
      <WishInput friend={friend} item={item} wish={wish} />
      <p className="ack" aria-live="polite">{ack}</p>
    </>
  );
}

function WishInput({ friend, item, wish }: { friend: boolean; item: Item; wish: (change: WishChange) => void }) {
  if (friend) {
    return (
      <label className="wish">
        <input type="checkbox" checked={item.wished} onChange={(event) => wish({ wished: event.currentTarget.checked })} />
        I would like this
      </label>
    );
  }
  return (
    <p className="wish">
      <KindButton item={item} kind="now" label="Want it now" wish={wish} />
      <KindButton item={item} kind="someday" label="Someday" wish={wish} />
    </p>
  );
}

function KindButton({ item, kind, label, wish }: { item: Item; kind: WishKind; label: string; wish: (change: WishChange) => void }) {
  const on = item.wished && item.wishKind === kind;
  const change: WishChange = on ? { wished: false } : { wished: true, kind };
  return <button type="button" aria-pressed={on ? "true" : "false"} onClick={() => wish(change)}>{label}</button>;
}

const ACK_MS = 5000;

// One line of text that clears itself; a new one restarts the clock.
function useAck(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (next: string) => {
    clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => setText(""), ACK_MS);
  };
  return [text, show];
}

function ackText(change: WishChange, friend: boolean): string {
  if (!change.wished) return "Wish withdrawn.";
  if (friend) return "Wish saved.";
  return change.kind === "someday" ? "Wish saved: someday." : "Wish saved: want it now.";
}

function Photos({ photos }: { photos: { id: number; url: string }[] }) {
  return <>{photos.map((photo) => <img key={photo.id} alt="" src={photo.url} />)}</>;
}

function Price({ cents }: { cents: number | undefined }) {
  if (typeof cents !== "number") return null;
  return <p className="price">{money(cents)}</p>;
}

function AlsoWanted({ me, item }: { me: Me; item: Item }) {
  if (!showAlso(me, item)) return null;
  return <p className="muted">Also wanted by: {wantedNames(item)}</p>;
}

// A friend is told only how many others want an item, never who.
function OthersWishing({ count }: { count: number | undefined }) {
  if (!count) return null;
  return <p className="muted">{othersText(count)}</p>;
}

function othersText(count: number): string {
  return `${count} ${count === 1 ? "other person wants" : "others want"} this.`;
}

function showAlso(me: Me, item: Item): boolean {
  if (me.group === "friend") return false;
  return hasNames(item.alsoWantedBy);
}

function hasNames(names: unknown[] | undefined): boolean {
  if (names == null) return false;
  return names.length > 0;
}

function wantedNames(item: Item): string {
  return listOrEmpty(item.alsoWantedBy).map(wisherText).join(", ");
}

function wisherText(wisher: { name: string; kind: WishKind }): string {
  return wisher.kind === "someday" ? `${wisher.name} (someday)` : wisher.name;
}

async function sendWish(item: Item, change: WishChange, setItems: SetItems): Promise<boolean> {
  setItems((current) => current.map((candidate) => wishOrSame(candidate, item.id, change)));
  const result = await api<{ wished?: boolean }>(`/api/items/${item.id}/wish`, {
    method: "POST",
    body: JSON.stringify(change),
  });
  revertUnlessOk(result.status, item, setItems);
  return result.status === 200;
}

function wishOrSame(candidate: Item, id: number, change: WishChange): Item {
  if (candidate.id !== id) return candidate;
  return { ...candidate, wished: change.wished, wishKind: change.kind };
}

function revertUnlessOk(
  status: number,
  item: Item,
  setItems: (update: (current: Item[]) => Item[]) => void,
): void {
  if (status === 200) return;
  setItems((current) => current.map((candidate) => sameOrItem(candidate, item)));
}

function sameOrItem(candidate: Item, item: Item): Item {
  if (candidate.id !== item.id) return candidate;
  return item;
}
