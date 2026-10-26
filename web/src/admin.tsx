import { useEffect, useState } from "preact/hooks";
import { api, firstField, listOrEmpty, money, shrinkPhoto } from "./api";
import { MoveTopic } from "./move-topic";
import { StatusButtons } from "./status-buttons";
import { acceptWish, cancelWish } from "./wish-actions";
import { Note } from "./note";
import { matchesShow, ShowFilter, type Show } from "./show-filter";

type Wish = { id: number; email: string; name: string; status: string; kind?: string };
type Item = {
  id: number;
  topicId: number;
  topicName: string;
  title: string;
  description: string;
  priceCents: number | null;
  status: string;
  photos: { id: number; url: string }[];
  wishes: Wish[];
};
type Topic = { id: number; slug: string; name: string };

export function Admin() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [topicId, setTopicId] = useState(0);
  const [show, setShow] = useState<Show>("all");
  const refresh = () => reload(setTopics, setItems, topicId, setTopicId);
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section>
      <h2>Topics and items</h2>
      <p className="muted">People and topic grants are edited on Merit, not here.</p>
      <Note text={message} className="note" />
      <TopicForm name={name} setName={setName} onSubmit={(event) => submitTopic(event, name, setMessage, setName, refresh)} />
      <ItemForm
        topics={topics}
        topicId={topicId}
        setTopicId={setTopicId}
        title={title}
        setTitle={setTitle}
        description={description}
        setDescription={setDescription}
        price={price}
        setPrice={setPrice}
        onSubmit={(event) => submitItem(event, topicId, title, description, price, setMessage, () => clearItem(setTitle, setDescription, setPrice), refresh)}
      />
      <ShowFilter show={show} setShow={setShow} />
      {items.filter((item) => shown(item, show)).map((item) => (
        <AdminItem key={item.id} item={item} topics={topics.filter((topic) => topic.id !== item.topicId)} setMessage={setMessage} refresh={refresh} />
      ))}
    </section>
  );
}

// "Items with wishes" means at least one active wish.
function shown(item: Item, show: Show): boolean {
  return matchesShow(show, item.status, item.wishes.some(isActive));
}

async function reload(
  setTopics: (topics: Topic[]) => void,
  setItems: (items: Item[]) => void,
  topicId: number,
  setTopicId: (id: number) => void,
): Promise<void> {
  const [topicRes, itemRes] = await Promise.all([
    api<{ topics: Topic[] }>("/api/admin/topics"),
    api<{ items: Item[] }>("/api/admin/items"),
  ]);
  const topics = listOrEmpty(topicRes.body.topics);
  setTopics(topics);
  setItems(listOrEmpty(itemRes.body.items));
  chooseTopic(topicId, topics, setTopicId);
}

function chooseTopic(topicId: number, topics: Topic[], setTopicId: (id: number) => void): void {
  if (topicId) return;
  setTopicId(firstField(topics, 0, (topic) => topic.id));
}

function TopicForm({ name, setName, onSubmit }: {
  name: string;
  setName: (name: string) => void;
  onSubmit: (event: Event) => void;
}) {
  return (
    <form className="card" onSubmit={onSubmit}>
      <label>
        New topic
        <input value={name} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <button type="submit">Add topic</button>
    </form>
  );
}

function submitTopic(
  event: Event,
  name: string,
  setMessage: (message: string) => void,
  setName: (name: string) => void,
  refresh: () => Promise<void>,
): void {
  event.preventDefault();
  void addTopic(name, setMessage, setName, refresh);
}

async function addTopic(
  name: string,
  setMessage: (message: string) => void,
  setName: (name: string) => void,
  refresh: () => Promise<void>,
): Promise<void> {
  const result = await api("/api/admin/topics", { method: "POST", body: JSON.stringify({ name }) });
  setMessage(savedNote(result.status, "Topic added.", "The topic was not added."));
  clearWhenSaved(result.status, () => setName(""));
  await refresh();
}

function savedNote(status: number, ok: string, fail: string): string {
  if (status === 201) return ok;
  return fail;
}

function ItemForm({ topics, topicId, setTopicId, title, setTitle, description, setDescription, price, setPrice, onSubmit }: {
  topics: Topic[];
  topicId: number;
  setTopicId: (id: number) => void;
  title: string;
  setTitle: (title: string) => void;
  description: string;
  setDescription: (description: string) => void;
  price: string;
  setPrice: (price: string) => void;
  onSubmit: (event: Event) => void;
}) {
  return (
    <form className="card" onSubmit={onSubmit}>
      <label>
        Topic
        <select value={String(topicId)} onChange={(event) => setTopicId(Number(event.currentTarget.value))}>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
      </label>
      <label>
        Title
        <input value={title} onInput={(event) => setTitle(event.currentTarget.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onInput={(event) => setDescription(event.currentTarget.value)} />
      </label>
      <label>
        Price in dollars, if a friend might buy it
        <input value={price} onInput={(event) => setPrice(event.currentTarget.value)} />
      </label>
      <button type="submit">Add item</button>
    </form>
  );
}

function submitItem(
  event: Event,
  topicId: number,
  title: string,
  description: string,
  price: string,
  setMessage: (message: string) => void,
  clear: () => void,
  refresh: () => Promise<void>,
): void {
  event.preventDefault();
  void addItem(topicId, title, description, price, setMessage, clear, refresh);
}

async function addItem(
  topicId: number,
  title: string,
  description: string,
  price: string,
  setMessage: (message: string) => void,
  clear: () => void,
  refresh: () => Promise<void>,
): Promise<void> {
  const result = await api("/api/admin/items", {
    method: "POST",
    body: JSON.stringify({ topicId, title, description, priceCents: dollarsToCents(price) }),
  });
  setMessage(savedNote(result.status, "Item added.", "The item was not added."));
  clearWhenSaved(result.status, clear);
  await refresh();
}

function dollarsToCents(price: string): number | null {
  if (price.trim() === "") return null;
  return Math.round(Number(price) * 100);
}

function clearWhenSaved(status: number, clear: () => void): void {
  if (status !== 201) return;
  clear();
}

function clearItem(
  setTitle: (title: string) => void,
  setDescription: (description: string) => void,
  setPrice: (price: string) => void,
): void {
  setTitle("");
  setDescription("");
  setPrice("");
}

function AdminItem({ item, topics, setMessage, refresh }: {
  item: Item;
  topics: Topic[];
  setMessage: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  return (
    <article className="item" id={`item-${item.id}`}>
      <h2>{item.title}</h2>
      <p className="muted">{item.topicName} · {item.status}</p>
      <p>{item.description}</p>
      <AdminPrice cents={item.priceCents} />
      <Photos photos={item.photos} />
      <PhotoInput item={item} setMessage={setMessage} refresh={refresh} />
      <ActiveWishes item={item} setMessage={setMessage} refresh={refresh} />
      <MoveTopic itemId={item.id} topics={topics} say={setMessage} reload={refresh} />
      <StatusButtons itemId={item.id} status={item.status} say={setMessage} reload={refresh} />
    </article>
  );
}

function AdminPrice({ cents }: { cents: number | null }) {
  if (cents == null) return null;
  return <p className="price">{money(cents)}</p>;
}

function Photos({ photos }: { photos: { id: number; url: string }[] }) {
  return <>{photos.map((photo) => <img key={photo.id} src={photo.url} alt="" />)}</>;
}

function PhotoInput({ item, setMessage, refresh }: {
  item: Item;
  setMessage: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  if (item.status !== "open") return null;
  return (
    <label>
      Add a photo
      <input type="file" accept="image/*" onChange={(event) => void upload(item.id, chosenFile(event.currentTarget.files), setMessage, refresh)} />
    </label>
  );
}

function chosenFile(files: FileList | null): File | null {
  if (files == null) return null;
  return fileAt(files);
}

function fileAt(files: FileList): File | null {
  const file = files[0];
  if (file == null) return null;
  return file;
}

async function upload(
  id: number,
  file: File | null,
  setMessage: (message: string) => void,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!file) return;
  const blob = await shrinkPhoto(file);
  const form = new FormData();
  form.set("photo", new File([blob], "photo.jpg", { type: "image/jpeg" }));
  const result = await api(`/api/admin/items/${id}/photos`, { method: "POST", body: form });
  setMessage(savedNote(result.status, "Photo added.", "The photo was not added."));
  await refresh();
}

function ActiveWishes({ item, setMessage, refresh }: {
  item: Item;
  setMessage: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  return <>{item.wishes.filter(isActive).map((wish) => <WishRow key={wish.id} item={item} wish={wish} setMessage={setMessage} refresh={refresh} />)}</>;
}

function isActive(wish: Wish): boolean {
  return wish.status === "active";
}

function WishRow({ item, wish, setMessage, refresh }: {
  item: Item;
  wish: Wish;
  setMessage: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  return (
    <p>
      <button type="button" onClick={() => void acceptFor(item, wish, setMessage, refresh)}>Accept for {wisherLabel(wish)}</button>
      <button className="quiet" type="button" onClick={() => void cancelWish(wish, item.title, setMessage, refresh)}>Cancel wish</button>
    </p>
  );
}

function wisherLabel(wish: Wish): string {
  return wish.kind === "someday" ? `${wish.name} (someday)` : wish.name;
}

async function acceptFor(
  item: Item,
  wish: Wish,
  setMessage: (message: string) => void,
  refresh: () => Promise<void>,
): Promise<void> {
  await acceptWish(item.id, wish.id, acceptPrompt(item, wish), setMessage, refresh);
}

function acceptPrompt(item: Item, wish: Wish): string {
  return `Accept for ${wish.name}? ${apologySentence(otherWishes(item, wish))}`;
}

function otherWishes(item: Item, wish: Wish): number {
  return item.wishes.filter((candidate) => stillActive(candidate, wish.id)).length;
}

function stillActive(candidate: Wish, wishId: number): boolean {
  if (candidate.status !== "active") return false;
  return candidate.id !== wishId;
}

function apologySentence(others: number): string {
  if (others === 1) return "1 other person will get an apology.";
  return `${others} others will get an apology.`;
}

