import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { Admin } from "../src/admin";
import { fakeServer, type Route } from "./fake-server";

vi.mock("../src/api", async (original) => ({
  ...(await original<typeof import("../src/api")>()),
  shrinkPhoto: vi.fn(async () => new Blob(["small"], { type: "image/jpeg" })),
}));

const topics = [{ id: 3, slug: "pins", name: "Pins" }, { id: 4, slug: "art", name: "Art" }];
const ada = { id: 11, email: "ada@example.com", name: "Ada", status: "active" };
const bea = { id: 12, email: "bea@example.com", name: "Bea", status: "active", kind: "someday" };
const cy = { id: 13, email: "cy@example.com", name: "Cy", status: "declined" };
const pin = {
  id: 1, topicId: 3, topicName: "Pins", title: "Brass pin", description: "Old pin", priceCents: 1250,
  status: "open", photos: [{ id: 9, url: "/photo/9" }], wishes: [ada, bea, cy],
};
const vase = { ...pin, id: 2, title: "Vase", priceCents: null, status: "accepted", photos: [], wishes: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(more: Record<string, Route> = {}, items: unknown[] = [pin, vase]) {
  return fakeServer({
    "GET /api/admin/topics": { body: { topics } },
    "GET /api/admin/items": { body: { items } },
    ...more,
  });
}

const typeInto = (label: string, value: string) => fireEvent.input(screen.getByLabelText(label), { target: { value } });
const submit = (button: string) => fireEvent.submit(screen.getByText(button).closest("form")!);
const loads = (server: ReturnType<typeof serve>) => server.sent("GET", "/api/admin/items").length;

test("lists items with topic, status, price, and photos", async () => {
  serve();
  render(<Admin />);
  expect(await screen.findByText("Brass pin")).toBeTruthy();
  expect(screen.getAllByText("Pins · open")).toHaveLength(1);
  expect(screen.getByText("Pins · accepted")).toBeTruthy();
  // The pin has a price; the vase has none.
  expect(screen.getAllByText(/^\$/).map((p) => p.textContent)).toEqual(["$12.50"]);
  expect([...document.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["/photo/9"]);
  expect([...(screen.getByLabelText("Topic") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Pins", "Art"]);
  expect([...document.querySelectorAll("article")].map((a) => a.id)).toEqual(["item-1", "item-2"]);
  expect(screen.queryByText("Remove item")).toBeNull();
});

test("tolerates empty lists from the server", async () => {
  serve({ "GET /api/admin/topics": { body: {} }, "GET /api/admin/items": { body: {} } });
  render(<Admin />);
  expect(await screen.findByText("Topics and items")).toBeTruthy();
  await waitFor(() => expect((screen.getByLabelText("Topic") as HTMLSelectElement).options).toHaveLength(0));
});

test("adding a topic posts the name, clears it, notes success, and reloads", async () => {
  const server = serve({ "POST /api/admin/topics": { status: 201, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  typeInto("New topic", "Quilts");
  submit("Add topic");
  expect(await screen.findByText("Topic added.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/topics")[0].body).toEqual({ name: "Quilts" });
  expect((screen.getByLabelText("New topic") as HTMLInputElement).value).toBe("");
  await waitFor(() => expect(loads(server)).toBe(2));
});

test("a refused topic says so and keeps the typed name", async () => {
  serve({ "POST /api/admin/topics": { status: 400, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  typeInto("New topic", "Quilts");
  submit("Add topic");
  expect(await screen.findByText("The topic was not added.")).toBeTruthy();
  expect((screen.getByLabelText("New topic") as HTMLInputElement).value).toBe("Quilts");
});

test("adding an item sends the chosen topic and the price in cents, then clears the form", async () => {
  const server = serve({ "POST /api/admin/items": { status: 201, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "4" } });
  typeInto("Title", "Quilt");
  typeInto("Description", "Warm");
  typeInto("Price in dollars, if a friend might buy it", "12.345");
  submit("Add item");
  expect(await screen.findByText("Item added.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items")[0].body).toEqual({ topicId: 4, title: "Quilt", description: "Warm", priceCents: 1235 });
  for (const label of ["Title", "Description", "Price in dollars, if a friend might buy it"]) {
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
  }
  await waitFor(() => expect(loads(server)).toBe(2));
  expect((screen.getByLabelText("Topic") as HTMLSelectElement).value).toBe("4");
});

test("an item with a blank price defaults to the first topic and sends no price", async () => {
  const server = serve({ "POST /api/admin/items": { status: 201, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  typeInto("Price in dollars, if a friend might buy it", "  ");
  submit("Add item");
  await screen.findByText("Item added.");
  expect(server.sent("POST", "/api/admin/items")[0].body).toEqual({ topicId: 3, title: "", description: "", priceCents: null });
});

test("a refused item keeps what was typed", async () => {
  serve({ "POST /api/admin/items": { status: 400, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  typeInto("Title", "Quilt");
  submit("Add item");
  expect(await screen.findByText("The item was not added.")).toBeTruthy();
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Quilt");
});

test("only open items take photos; an upload is shrunk, sent as photo.jpg, and noted", async () => {
  const server = serve({ "POST /api/admin/items/1/photos": { status: 201, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  const inputs = screen.getAllByLabelText("Add a photo") as HTMLInputElement[];
  expect(inputs).toHaveLength(1);
  const file = new File(["big"], "big.png", { type: "image/png" });
  fireEvent.change(inputs[0], { target: { files: [file] } });
  expect(await screen.findByText("Photo added.")).toBeTruthy();
  const sent = server.sent("POST", "/api/admin/items/1/photos")[0].body as FormData;
  const photo = sent.get("photo") as File;
  expect([photo.name, photo.type, await photo.text()]).toEqual(["photo.jpg", "image/jpeg", "small"]);
  await waitFor(() => expect(loads(server)).toBe(2));
});

test("a refused photo says so, and choosing no file sends nothing", async () => {
  const server = serve({ "POST /api/admin/items/1/photos": { status: 413, body: {} } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  const input = screen.getByLabelText("Add a photo") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [] } });
  await new Promise((done) => setTimeout(done, 20));
  expect(server.sent("POST", "/api/admin/items/1/photos")).toHaveLength(0);
  fireEvent.change(input, { target: { files: [new File(["x"], "x.png")] } });
  expect(await screen.findByText("The photo was not added.")).toBeTruthy();
});

test("accept buttons appear only for active wishes", async () => {
  serve();
  render(<Admin />);
  await screen.findByText("Brass pin");
  expect(screen.getAllByText(/^Accept for/).map((b) => b.textContent)).toEqual(["Accept for Ada", "Accept for Bea (someday)"]);
});

test("accepting asks first, naming how many others get an apology", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const server = serve();
  render(<Admin />);
  fireEvent.click(await screen.findByText("Accept for Ada"));
  expect(confirm).toHaveBeenCalledWith("Accept for Ada? 1 other person will get an apology.");
  expect(server.sent("POST", "/api/admin/items/1/accept")).toHaveLength(0);
});

test("the apology count is plural for zero or several others", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const dee = { ...bea, id: 14, name: "Dee" };
  serve({}, [{ ...pin, wishes: [ada, bea, dee] }, { ...pin, id: 6, title: "Solo", wishes: [ada] }]);
  render(<Admin />);
  await screen.findByText("Solo");
  const buttons = screen.getAllByText("Accept for Ada");
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(confirm.mock.calls).toEqual([["Accept for Ada? 2 others will get an apology."], ["Accept for Ada? 0 others will get an apology."]]);
});

test("a confirmed accept posts the wish and says the notes were emailed", async () => {
  vi.stubGlobal("confirm", () => true);
  const server = serve({ "POST /api/admin/items/1/accept": { body: { ok: true, mail: "email" } } });
  render(<Admin />);
  fireEvent.click(await screen.findByText("Accept for Bea (someday)"));
  expect(await screen.findByText("Accepted. The notes were emailed.")).toBeTruthy();
  expect(screen.queryByText(/local mailbox/)).toBeNull();
  expect(server.sent("POST", "/api/admin/items/1/accept")[0].body).toEqual({ wishId: 12 });
  await waitFor(() => expect(loads(server)).toBe(2));
});

test("in dev, an accept points to the local mailbox", async () => {
  vi.stubGlobal("confirm", () => true);
  serve({ "POST /api/admin/items/1/accept": { body: { ok: true, mail: "outbox" } } });
  render(<Admin />);
  fireEvent.click(await screen.findByText("Accept for Bea (someday)"));
  expect(await screen.findByText("Accepted. The notes are in the local mailbox.")).toBeTruthy();
});

test("an accept answer that does not say where mail went never claims the local mailbox", async () => {
  vi.stubGlobal("confirm", () => true);
  serve({ "POST /api/admin/items/1/accept": { body: { ok: true } } });
  render(<Admin />);
  fireEvent.click(await screen.findByText("Accept for Bea (someday)"));
  expect(await screen.findByText("Accepted. The notes were emailed.")).toBeTruthy();
});

test("a failed accept shows the server's reason, or a fallback", async () => {
  vi.stubGlobal("confirm", () => true);
  const server = serve({ "POST /api/admin/items/1/accept": { status: 409, body: { error: "Already accepted." } } });
  render(<Admin />);
  fireEvent.click(await screen.findByText("Accept for Bea (someday)"));
  expect(await screen.findByText("Already accepted.")).toBeTruthy();
  server.routes["POST /api/admin/items/1/accept"] = { status: 500, body: {} };
  fireEvent.click(screen.getByText("Accept for Bea (someday)"));
  expect(await screen.findByText("Accept failed.")).toBeTruthy();
});

test("the item list starts on All items and can filter by wishes or item state", async () => {
  const lapsed = { ...pin, id: 7, title: "Lapsed", wishes: [cy, { ...ada, status: "withdrawn" }] };
  const staged = { ...vase, id: 8, title: "Mug", status: "staged" };
  const delivered = { ...vase, id: 9, title: "Plate", status: "delivered" };
  serve({}, [pin, vase, lapsed, staged, delivered]);
  render(<Admin />);
  await screen.findByText("Brass pin");
  const show = screen.getByLabelText("Show") as HTMLSelectElement;
  expect([...show.options].map((o) => [o.value, o.textContent])).toEqual([
    ["all", "All items"],
    ["wished", "Items with wishes"],
    ["open", "Open"],
    ["accepted", "Accepted"],
    ["staged", "Staged"],
    ["delivered", "Delivered"],
  ]);
  expect(show.value).toBe("all");
  const ids = () => [...document.querySelectorAll("article")].map((a) => a.id);
  expect(ids()).toEqual(["item-1", "item-2", "item-7", "item-8", "item-9"]);
  for (const [choice, expected] of [
    ["wished", ["item-1"]],
    ["open", ["item-1", "item-7"]],
    ["accepted", ["item-2"]],
    ["staged", ["item-8"]],
    ["delivered", ["item-9"]],
    ["all", ["item-1", "item-2", "item-7", "item-8", "item-9"]],
  ] as const) {
    fireEvent.change(show, { target: { value: choice } });
    await waitFor(() => expect(ids()).toEqual(expected));
  }
});

test("each active wish has a Cancel wish button beside its Accept button", async () => {
  serve();
  render(<Admin />);
  await screen.findByText("Brass pin");
  expect(screen.getAllByText("Cancel wish")).toHaveLength(2);
  expect(screen.getByText("Accept for Ada").closest("p")?.textContent).toBe("Accept for AdaCancel wish");
});

test("cancelling a wish asks first and posts nothing when declined", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const server = serve();
  render(<Admin />);
  await screen.findByText("Brass pin");
  fireEvent.click(screen.getAllByText("Cancel wish")[1]);
  expect(confirm).toHaveBeenCalledWith("Cancel Bea's wish for Brass pin? Bea will get a short email saying the wish was cancelled.");
  expect(server.sent("POST", "/api/admin/wishes/12/cancel")).toHaveLength(0);
});

test.each([
  [{ ok: true, mail: "email" }, "Wish cancelled. Bea was emailed."],
  [{ ok: true, mail: "outbox" }, "Wish cancelled. The note is in the local mailbox."],
  [{ ok: true, already: true }, "That wish was already cancelled."],
  [{ error: "That wish can no longer be cancelled." }, "That wish can no longer be cancelled."],
  [{}, "Cancel failed."],
])("a confirmed cancel posts the wish, reloads, and says %j", async (reply, note) => {
  vi.stubGlobal("confirm", () => true);
  const server = serve({ "POST /api/admin/wishes/12/cancel": { body: reply } });
  render(<Admin />);
  await screen.findByText("Brass pin");
  fireEvent.click(screen.getAllByText("Cancel wish")[1]);
  expect(await screen.findByText(note)).toBeTruthy();
  expect(server.sent("POST", "/api/admin/wishes/12/cancel")).toHaveLength(1);
  await waitFor(() => expect(loads(server)).toBe(2));
});

test("admin cards for accepted, staged, and delivered items show status buttons and report errors", async () => {
  const staged = { ...vase, id: 8, title: "Mug", status: "staged" };
  const delivered = { ...vase, id: 9, title: "Plate", status: "delivered" };
  const server = serve(
    {
      "POST /api/admin/items/2/status": { body: { ok: true, status: "staged" } },
      "POST /api/admin/items/8/status": { status: 409, body: { error: "That item has not been accepted." } },
      "POST /api/admin/items/9/status": { status: 500, body: {} },
    },
    [pin, vase, staged, delivered],
  );
  render(<Admin />);
  expect(await screen.findByText("Pins · staged")).toBeTruthy();
  expect(screen.getByText("Pins · delivered")).toBeTruthy();

  fireEvent.click(screen.getByText("Stage"));
  expect(await screen.findByText("Marked staged.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/2/status")[0].body).toEqual({ status: "staged" });
  await waitFor(() => expect(loads(server)).toBe(2));

  fireEvent.click(screen.getByText("Deliver"));
  expect(await screen.findByText("That item has not been accepted.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/8/status")[0].body).toEqual({ status: "delivered" });

  fireEvent.click(screen.getByText("Undeliver"));
  expect(await screen.findByText("Status change failed.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/9/status")[0].body).toEqual({ status: "staged" });
});
