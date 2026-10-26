import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { AllWishes } from "../src/wishes";
import { fakeServer, type Route } from "./fake-server";

const rows = [
  { id: 1, name: "Fran Friend", email: "fran@example.com", itemId: 4, itemTitle: "Brass pin", topicName: "Jewelry", status: "active", kind: "now", createdAt: "2026-10-20T11:00:00", acceptedAt: null },
  { id: 2, name: "Ada Family", email: "ada@example.com", itemId: 4, itemTitle: "Brass pin", topicName: "Jewelry", status: "accepted", kind: "someday", createdAt: "2026-10-20T10:00:00", acceptedAt: "2026-10-20T20:02:03" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const cells = () => [...document.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

test("lists every wish with wisher, item, topic, status and Central times", async () => {
  fakeServer({ "GET /api/admin/wishes?status=&sort=created": { body: { wishes: rows } } });
  render(<AllWishes />);
  await screen.findByText("Fran Friend");
  expect(cells()).toEqual([
    ["Fran Friend", "fran@example.com", "Brass pin", "Jewelry", "active", "now", "2026-10-20 11:00", "", ""],
    ["Ada Family", "ada@example.com", "Brass pin", "Jewelry", "accepted", "someday", "2026-10-20 10:00", "2026-10-20 20:02", "Stage"],
  ]);
  expect(screen.getAllByText("Brass pin").map((a) => a.getAttribute("href"))).toEqual(["/admin#item-4", "/admin#item-4"]);
  expect(screen.getByText("Download CSV").getAttribute("href")).toBe("/api/admin/wishes.csv?status=&sort=created");
});

test("filtering and sorting reload the list and the CSV link", async () => {
  const server = fakeServer({
    "GET /api/admin/wishes?status=&sort=created": { body: { wishes: rows } },
    "GET /api/admin/wishes?status=accepted&sort=created": { body: { wishes: [rows[1]] } },
    "GET /api/admin/wishes?status=accepted&sort=wisher": { body: { wishes: [rows[1]] } },
  });
  render(<AllWishes />);
  await screen.findByText("Fran Friend");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "accepted" } });
  await waitFor(() => expect(screen.queryByText("Fran Friend")).toBeNull());
  fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "wisher" } });
  await waitFor(() => expect(server.calls.map((c) => c.path)).toContain("/api/admin/wishes?status=accepted&sort=wisher"));
  expect(screen.getByText("Download CSV").getAttribute("href")).toBe("/api/admin/wishes.csv?status=accepted&sort=wisher");
  expect([...(screen.getByLabelText("Status") as HTMLSelectElement).options].map((o) => [o.value, o.textContent])).toEqual([
    ["", "All"],
    ["active", "Active"],
    ["accepted", "Accepted"],
    ["staged", "Staged"],
    ["delivered", "Delivered"],
    ["declined", "Declined"],
    ["withdrawn", "Withdrawn"],
  ]);
  expect([...(screen.getByLabelText("Sort by") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["created", "wisher", "item", "status"]);
});

test("says so when there are no wishes, and survives a refused request", async () => {
  fakeServer({ "GET /api/admin/wishes?status=&sort=created": { status: 403, body: { error: "Not allowed." } } });
  render(<AllWishes />);
  expect(await screen.findByText("No wishes match.")).toBeTruthy();
});

test("a wish an admin cancelled reads as cancelled by admins", async () => {
  const cancelled = { ...rows[0], id: 9, status: "withdrawn", cancelledBy: "admin@example.com" };
  const plain = { ...rows[0], id: 10, name: "Gil", status: "withdrawn", cancelledBy: null };
  fakeServer({ "GET /api/admin/wishes?status=&sort=created": { body: { wishes: [cancelled, plain] } } });
  render(<AllWishes />);
  expect(await screen.findByText("cancelled by admins")).toBeTruthy();
  expect(screen.getByText("withdrawn")).toBeTruthy();
});

const openActive = { ...rows[0], id: 31, itemId: 4, itemTitle: "Brass pin", itemStatus: "open", status: "active", name: "Fran Friend" };
const closedActive = { ...rows[0], id: 32, itemId: 5, itemTitle: "Lamp", itemStatus: "accepted", status: "active", name: "Gil" };
const done = { ...rows[1], id: 33, itemStatus: "accepted", status: "accepted" };
const lapsed = { ...rows[0], id: 34, itemStatus: "open", status: "withdrawn", cancelledBy: null, name: "Hal" };
const listing = (more: Record<string, Route> = {}) =>
  fakeServer({ "GET /api/admin/wishes?status=&sort=created": { body: { wishes: [openActive, closedActive, done, lapsed] } }, ...more });

test("Accept and Cancel wish appear only for active wishes on open items", async () => {
  listing();
  render(<AllWishes />);
  await screen.findByText("Gil");
  expect(screen.getAllByText("Accept")).toHaveLength(1);
  expect(screen.getAllByText("Cancel wish")).toHaveLength(1);
  expect(screen.getByText("Accept").closest("tr")?.textContent).toContain("Fran Friend");
});

test("Accept on the wish list asks first, posts the existing accept route, notes it, and reloads", async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  const server = listing({ "POST /api/admin/items/4/accept": { body: { ok: true, mail: "email" } } });
  render(<AllWishes />);
  fireEvent.click(await screen.findByText("Accept"));
  expect(confirm).toHaveBeenCalledWith("Accept Brass pin for Fran Friend? Anyone else who wished for it will get an apology.");
  expect(await screen.findByText("Accepted. The notes were emailed.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/4/accept")[0].body).toEqual({ wishId: 31 });
  await waitFor(() => expect(server.sent("GET", "/api/admin/wishes?status=&sort=created")).toHaveLength(2));
});

test("Cancel wish on the wish list asks first, posts the cancel route, notes it, and reloads", async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  const server = listing({ "POST /api/admin/wishes/31/cancel": { body: { ok: true, mail: "outbox" } } });
  render(<AllWishes />);
  fireEvent.click(await screen.findByText("Cancel wish"));
  expect(confirm).toHaveBeenCalledWith("Cancel Fran Friend's wish for Brass pin? Fran Friend will get a short email saying the wish was cancelled.");
  expect(await screen.findByText("Wish cancelled. The note is in the local mailbox.")).toBeTruthy();
  await waitFor(() => expect(server.sent("GET", "/api/admin/wishes?status=&sort=created")).toHaveLength(2));
});

test("declining either prompt posts nothing", async () => {
  vi.stubGlobal("confirm", () => false);
  const server = listing();
  render(<AllWishes />);
  fireEvent.click(await screen.findByText("Accept"));
  fireEvent.click(screen.getByText("Cancel wish"));
  expect(server.sent("POST", "/api/admin/items/4/accept")).toHaveLength(0);
  expect(server.sent("POST", "/api/admin/wishes/31/cancel")).toHaveLength(0);
});

test("Stage, Deliver, Unstage, and Undeliver move an accepted wish through delivery statuses", async () => {
  const stagedRow = { ...done, id: 35, itemId: 6, itemTitle: "Mug", itemStatus: "staged", status: "staged" };
  const deliveredRow = { ...done, id: 36, itemId: 7, itemTitle: "Vase", itemStatus: "delivered", status: "delivered" };
  const server = fakeServer({
    "GET /api/admin/wishes?status=&sort=created": { body: { wishes: [openActive, closedActive, done, stagedRow, deliveredRow, lapsed] } },
    "POST /api/admin/items/4/status": { body: { ok: true, status: "staged" } },
    "POST /api/admin/items/6/status": { body: { ok: true, status: "delivered" } },
    "POST /api/admin/items/7/status": { body: { ok: true, status: "staged" } },
  });
  render(<AllWishes />);
  fireEvent.click(await screen.findByText("Stage"));
  expect(await screen.findByText("Marked staged.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/4/status")[0].body).toEqual({ status: "staged" });

  fireEvent.click(screen.getByText("Deliver"));
  expect(await screen.findByText("Marked delivered.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/6/status")[0].body).toEqual({ status: "delivered" });

  fireEvent.click(screen.getByText("Unstage"));
  expect(await screen.findByText("Marked accepted.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/6/status")[1].body).toEqual({ status: "accepted" });

  fireEvent.click(screen.getByText("Undeliver"));
  expect(await screen.findByText("Marked staged.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/items/7/status")[0].body).toEqual({ status: "staged" });
});
