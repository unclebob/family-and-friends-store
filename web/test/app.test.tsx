import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/app";
import { fakeServer, type Route } from "./fake-server";
import { readFileSync } from "node:fs";

const css = readFileSync("web/src/style.css", "utf8");

const ada = { email: "ada@example.com", firstName: "Ada", group: "family" };
const fran = { email: "fran@example.com", firstName: "Fran", group: "friend" };
const bob = { email: "admin@example.com", firstName: "Bob", group: "admin" };
const signedOut = { status: 401, body: { error: "Sign in." } };

const pin = { id: 1, title: "Brass pin", description: "Old pin", wished: false, priceCents: 1250, alsoWantedBy: [{ name: "Bea", kind: "someday" }, { name: "Cy", kind: "now" }], photos: [{ id: 9, url: "/photo/9" }] };
const mug = { id: 2, title: "Mug", description: "Blue", wished: true, wishKind: "someday", photos: [] };

const pressed = (name: string) => screen.getAllByText(name).map((b) => b.getAttribute("aria-pressed"));

beforeEach(() => history.replaceState({}, "", "/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(me: Route, more: Record<string, Route> = {}, env = "production") {
  return fakeServer({ "GET /api/config": { body: { env } }, "GET /api/me": me, ...more });
}

function browsing(more: Record<string, Route> = {}) {
  return {
    "GET /api/topics": { body: { topics: [{ slug: "pins & mugs", name: "Pins" }, { slug: "art", name: "Art" }] } },
    "GET /api/items?topic=pins%20%26%20mugs": { body: { items: [pin, mug] } },
    "GET /api/items?topic=art": { body: { items: [] } },
    ...more,
  };
}

function typeInto(label: string, value: string) {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

test("shows loading, then the sign-in form when nobody is signed in", async () => {
  serve(signedOut);
  render(<App />);
  expect(screen.getByText("Loading…")).toBeTruthy();
  expect(await screen.findByLabelText("Email or phone number")).toBeTruthy();
  expect(screen.getByRole("heading").textContent).toBe("Family & Friends");
  expect(screen.queryByText("Log off")).toBeNull();
  expect(screen.queryByText("Use the local stand-in for Merit")).toBeNull();
});

test("signs in with an emailed code and then welcomes the person", async () => {
  let me: Route = signedOut;
  const server = fakeServer({
    "GET /api/config": { body: { env: "production" } },
    "GET /api/me": () => (me as { status: number; body: unknown }),
    "POST /login/email": { body: { ok: true } },
    "POST /login/code": () => {
      me = { status: 200, body: ada };
      return { body: { ok: true } };
    },
    ...browsing(),
  });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  typeInto("Email or phone number", "ada@example.com");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  expect(await screen.findByText("Enter the 6-digit code. It expires in 20 minutes.")).toBeTruthy();
  expect(screen.queryByText(/Local sign-in code/)).toBeNull();
  expect(server.sent("POST", "/login/email")[0].body).toEqual({ email: "ada@example.com" });
  typeInto("Code", "123456");
  fireEvent.submit(screen.getByText("Sign in").closest("form")!);
  expect(await screen.findByText("Welcome, Ada!")).toBeTruthy();
  expect(server.sent("POST", "/login/code")[0].body).toEqual({ email: "ada@example.com", code: "123456" });
});

test("signs in with a phone number: the email stays hidden and the code goes with the pending id", async () => {
  let me: Route = signedOut;
  const server = fakeServer({
    "GET /api/config": { body: { env: "production" } },
    "GET /api/me": () => (me as { status: number; body: unknown }),
    "POST /login/email": { body: { ok: true, masked: "a•••@example.com", pending: "p-1" } },
    "POST /login/code": () => {
      me = { status: 200, body: ada };
      return { body: { ok: true } };
    },
    ...browsing(),
  });
  render(<App />);
  const field = (await screen.findByLabelText("Email or phone number")) as HTMLInputElement;
  expect(field.type).toBe("text");
  typeInto("Email or phone number", "(312) 555-0100");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  expect(await screen.findByText("Check your email at a•••@example.com for the 6-digit code. It expires in 20 minutes.")).toBeTruthy();
  expect(server.sent("POST", "/login/email")[0].body).toEqual({ email: "(312) 555-0100" });
  typeInto("Code", "123456");
  fireEvent.submit(screen.getByText("Sign in").closest("form")!);
  expect(await screen.findByText("Welcome, Ada!")).toBeTruthy();
  expect(server.sent("POST", "/login/code")[0].body).toEqual({ pending: "p-1", code: "123456" });
});

test("shows the local code in dev", async () => {
  serve(signedOut, { "POST /login/email": { body: { ok: true, devCode: "654321" } } }, "dev");
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  expect((await screen.findByText(/Local sign-in code/)).textContent).toBe("Local sign-in code: 654321");
});

test("a test login signs in at once, with no code step", async () => {
  let me: Route = signedOut;
  fakeServer({
    "GET /api/config": { body: { env: "production" } },
    "GET /api/me": () => (me as { status: number; body: unknown }),
    "POST /login/email": () => {
      me = { status: 200, body: fran };
      return { body: { ok: true, signedIn: true } };
    },
    ...browsing(),
  });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  typeInto("Email or phone number", "fran@friendtest");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  expect(await screen.findByText("Welcome, Fran!")).toBeTruthy();
  expect(screen.queryByLabelText("Code")).toBeNull();
});

test("a refused email shows the reason, or a fallback, and stays on the email step", async () => {
  const server = serve(signedOut, { "POST /login/email": { body: { ok: false, message: "Not on the list." } } });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  expect(await screen.findByText("Not on the list.")).toBeTruthy();
  server.routes["POST /login/email"] = { body: { ok: false } };
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  expect(await screen.findByText("Try again.")).toBeTruthy();
  expect(screen.getByLabelText("Email or phone number")).toBeTruthy();
});

test("a wrong code shows the reason, or a fallback", async () => {
  const server = serve(signedOut, {
    "POST /login/email": { body: { ok: true } },
    "POST /login/code": { body: { ok: false, message: "That code expired." } },
  });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  await screen.findByLabelText("Code");
  fireEvent.submit(screen.getByText("Sign in").closest("form")!);
  expect(await screen.findByText("That code expired.")).toBeTruthy();
  server.routes["POST /login/code"] = { body: { ok: false } };
  fireEvent.submit(screen.getByText("Sign in").closest("form")!);
  expect(await screen.findByText("That code doesn't work.")).toBeTruthy();
  expect(screen.queryByText(/Welcome/)).toBeNull();
});

test("a double press on Sign in sends the code only once", async () => {
  let answer: (reply: { body: unknown }) => void = () => {};
  const server = serve(signedOut, {
    "POST /login/email": { body: { ok: true } },
    "POST /login/code": () => new Promise((resolve) => (answer = resolve)),
  });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  await screen.findByLabelText("Code");
  const button = screen.getByText("Sign in") as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(true));
  fireEvent.click(button);
  answer({ body: { ok: false } });
  expect(await screen.findByText("That code doesn't work.")).toBeTruthy();
  expect(server.sent("POST", "/login/code")).toHaveLength(1);
  expect(button.disabled).toBe(false);
});

test("a good code that the browser does not keep says so, not that the code failed", async () => {
  serve(signedOut, {
    "POST /login/email": { body: { ok: true } },
    "POST /login/code": { body: { ok: true } },
  });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  await screen.findByLabelText("Code");
  fireEvent.submit(screen.getByText("Sign in").closest("form")!);
  expect(
    await screen.findByText("You're signed in, but this browser didn't keep the sign-in. Open the site in Safari or Chrome, or allow cookies."),
  ).toBeTruthy();
  expect(screen.queryByText(/That code doesn't work/)).toBeNull();
  expect(screen.queryByText(/Welcome/)).toBeNull();
});

function pending() {
  let answer: (reply: { body: unknown }) => void = () => {};
  const route = () => new Promise<{ body: unknown }>((resolve) => (answer = resolve));
  return { route, answer: (body: unknown) => answer({ body }) };
}

async function toCodeStep(code: Route) {
  serve(signedOut, { "POST /login/email": { body: { ok: true } }, "POST /login/code": code });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  fireEvent.submit(screen.getByText("Continue").closest("form")!);
  await screen.findByLabelText("Code");
}

test("Sign in reads Checking… and is disabled while the code is checked, then comes back after an error", async () => {
  const code = pending();
  await toCodeStep(code.route);
  const button = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.textContent).toBe("Checking…"));
  expect(button.disabled).toBe(true);
  code.answer({ ok: false });
  await waitFor(() => expect(button.textContent).toBe("Sign in"));
  expect(button.disabled).toBe(false);
});

test("Sign in comes back after a good code that the browser did not keep", async () => {
  const code = pending();
  await toCodeStep(code.route);
  const button = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.textContent).toBe("Checking…"));
  code.answer({ ok: true });
  await screen.findByText(/didn't keep the sign-in/);
  expect(button.textContent).toBe("Sign in");
  expect(button.disabled).toBe(false);
});

test("Continue reads Sending… and is disabled while the code is sent, then comes back", async () => {
  const email = pending();
  const server = serve(signedOut, { "POST /login/email": email.route });
  render(<App />);
  await screen.findByLabelText("Email or phone number");
  const button = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.textContent).toBe("Sending…"));
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  email.answer({ ok: false, message: "Not on the list." });
  await screen.findByText("Not on the list.");
  expect(button.textContent).toBe("Continue");
  expect(button.disabled).toBe(false);
  expect(server.sent("POST", "/login/email")).toHaveLength(1);
});

test("a disabled button looks gray, even on iOS Safari", () => {
  const rule = css.match(/button:disabled\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toMatch(/opacity:\s*0?\.5/);
  expect(rule).toMatch(/cursor:\s*default/);
  expect(rule).toMatch(/-webkit-appearance:\s*none/);
});

test("in dev, the Merit stand-in button seeds data and lists the people", async () => {
  const server = serve(signedOut, {
    "POST /dev/merit": { body: { people: ["ada@example.com", "bea@example.com"] } },
    "POST /dev/seed": { body: {} },
  }, "dev");
  render(<App />);
  fireEvent.click(await screen.findByText("Use the local stand-in for Merit"));
  expect(await screen.findByText("ada@example.com bea@example.com")).toBeTruthy();
  expect(server.calls.map((call) => `${call.method} ${call.path}`).slice(-2)).toEqual(["POST /dev/merit", "POST /dev/seed"]);
});

test("the Merit stand-in tolerates an answer with no people", async () => {
  serve(signedOut, { "POST /dev/merit": { body: {} }, "POST /dev/seed": { body: {} } }, "dev");
  render(<App />);
  fireEvent.click(await screen.findByText("Use the local stand-in for Merit"));
  await waitFor(() => expect(screen.getByText("Use the local stand-in for Merit")).toBeTruthy());
});

test("log off signs out and returns to the sign-in form", async () => {
  const server = serve({ body: ada }, { ...browsing(), "POST /logout": { body: { ok: true } } });
  render(<App />);
  fireEvent.click(await screen.findByText("Log off"));
  expect(await screen.findByText("Family & Friends")).toBeTruthy();
  expect(server.sent("POST", "/logout")).toHaveLength(1);
});

test("family members browse the first topic with prices, photos, and other wishers", async () => {
  serve({ body: ada }, browsing());
  render(<App />);
  expect(await screen.findByText("Brass pin")).toBeTruthy();
  expect(screen.getByText("Pins").className).toBe("on");
  expect(screen.getByText("Art").className).toBe("");
  expect(screen.getByText("$12.50")).toBeTruthy();
  expect(screen.getByText("Also wanted by: Bea (someday), Cy")).toBeTruthy();
  expect(screen.queryByText(/want this/)).toBeNull();
  expect(document.querySelector("img")?.getAttribute("src")).toBe("/photo/9");
  expect(screen.queryByLabelText("I would like this")).toBeNull();
  expect(pressed("Want it now")).toEqual(["false", "false"]);
  expect(pressed("Someday")).toEqual(["false", "true"]);
  expect(screen.queryByText("Admin")).toBeNull();
  expect(screen.queryByText("Nothing in this topic yet.")).toBeNull();
  expect([...document.querySelectorAll("article")].map((a) => a.id)).toEqual(["item-1", "item-2"]);
});

test("friends see how many others want an item, never who", async () => {
  serve({ body: fran }, browsing({
    "GET /api/items?topic=pins%20%26%20mugs": { body: { items: [{ ...pin, alsoWantedBy: undefined, othersWishing: 1 }, { ...mug, othersWishing: 2 }] } },
  }));
  render(<App />);
  expect(await screen.findByText("1 other person wants this.")).toBeTruthy();
  expect(screen.getByText("2 others want this.")).toBeTruthy();
  expect(screen.queryByText(/Also wanted by/)).toBeNull();
  expect(screen.queryByText(/Bea/)).toBeNull();
});

test("a friend sees no line when nobody else wants the item", async () => {
  serve({ body: fran }, browsing({
    "GET /api/items?topic=pins%20%26%20mugs": { body: { items: [{ ...pin, alsoWantedBy: undefined, othersWishing: 0 }] } },
  }));
  render(<App />);
  await screen.findByText("Brass pin");
  expect(screen.queryByText(/want this/)).toBeNull();
});

test("an item with an empty wisher list shows no wisher line", async () => {
  serve({ body: ada }, browsing({ "GET /api/items?topic=pins%20%26%20mugs": { body: { items: [{ ...pin, alsoWantedBy: [] }] } } }));
  render(<App />);
  await screen.findByText("Brass pin");
  expect(screen.queryByText(/Also wanted by/)).toBeNull();
});

test("choosing another topic loads it and says when it is empty", async () => {
  serve({ body: ada }, browsing());
  render(<App />);
  await screen.findByText("Brass pin");
  fireEvent.click(screen.getByText("Art"));
  expect(await screen.findByText("Nothing in this topic yet.")).toBeTruthy();
  expect(screen.queryByText("Brass pin")).toBeNull();
  expect(screen.getByText("Art").className).toBe("on");
});

test("a topic the server refuses shows as empty", async () => {
  serve({ body: ada }, browsing({ "GET /api/items?topic=pins%20%26%20mugs": { status: 404, body: { items: [pin] } } }));
  render(<App />);
  expect(await screen.findByText("Nothing in this topic yet.")).toBeTruthy();
});

test("with no topics shared, says so and loads no items", async () => {
  const server = serve({ body: ada }, { "GET /api/topics": { body: {} } });
  render(<App />);
  expect(await screen.findByText("Nothing has been shared with you yet.")).toBeTruthy();
  expect(screen.queryByText("Nothing in this topic yet.")).toBeNull();
  expect(server.calls.filter((call) => call.path.startsWith("/api/items"))).toHaveLength(0);
});

test("a friend ticking a wish shows at once and is sent to the server", async () => {
  const server = serve({ body: fran }, browsing({ "POST /api/items/1/wish": { body: { wished: true } } }));
  render(<App />);
  await screen.findByText("Brass pin");
  const [box] = screen.getAllByLabelText("I would like this") as HTMLInputElement[];
  box.checked = true;
  fireEvent.change(box);
  await waitFor(() => expect(server.sent("POST", "/api/items/1/wish")).toHaveLength(1));
  expect(server.sent("POST", "/api/items/1/wish")[0].body).toEqual({ wished: true });
  expect((screen.getAllByLabelText("I would like this") as HTMLInputElement[]).map((b) => b.checked)).toEqual([true, true]);
});

test("a friend's refused wish change is put back", async () => {
  const server = serve({ body: fran }, browsing({ "POST /api/items/2/wish": { status: 409, body: {} } }));
  render(<App />);
  await screen.findByText("Mug");
  const box = (screen.getAllByLabelText("I would like this") as HTMLInputElement[])[1];
  box.checked = false;
  fireEvent.change(box);
  await waitFor(() => expect(server.sent("POST", "/api/items/2/wish")).toHaveLength(1));
  await waitFor(() =>
    expect((screen.getAllByLabelText("I would like this") as HTMLInputElement[]).map((b) => b.checked)).toEqual([false, true]),
  );
  expect(server.sent("POST", "/api/items/2/wish")[0].body).toEqual({ wished: false });
});

test("family choose now or someday, can switch, and pressing the chosen one withdraws", async () => {
  const server = serve({ body: ada }, browsing({
    "POST /api/items/1/wish": { body: { wished: true, kind: "now" } },
    "POST /api/items/2/wish": { body: { wished: true, kind: "now" } },
  }));
  render(<App />);
  await screen.findByText("Brass pin");
  fireEvent.click(screen.getAllByText("Want it now")[0]);
  await waitFor(() => expect(server.sent("POST", "/api/items/1/wish")).toHaveLength(1));
  expect(server.sent("POST", "/api/items/1/wish")[0].body).toEqual({ wished: true, kind: "now" });
  expect(pressed("Want it now")).toEqual(["true", "false"]);
  fireEvent.click(screen.getAllByText("Want it now")[1]);
  await waitFor(() => expect(server.sent("POST", "/api/items/2/wish")).toHaveLength(1));
  expect(server.sent("POST", "/api/items/2/wish")[0].body).toEqual({ wished: true, kind: "now" });
  expect(pressed("Someday")).toEqual(["false", "false"]);
  fireEvent.click(screen.getAllByText("Want it now")[0]);
  await waitFor(() => expect(server.sent("POST", "/api/items/1/wish")).toHaveLength(2));
  expect(server.sent("POST", "/api/items/1/wish")[1].body).toEqual({ wished: false });
  expect(pressed("Want it now")).toEqual(["false", "true"]);
});

function ackIn(title: string): HTMLElement {
  const item = screen.getByText(title).closest("article")!;
  return item.querySelector("[aria-live]") as HTMLElement;
}

test("a family wish is acknowledged in one polite line near the item for 5 seconds", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve({ body: ada }, browsing({ "POST /api/items/1/wish": { body: { wished: true } } }));
    render(<App />);
    await screen.findByText("Brass pin");
    expect(ackIn("Brass pin").getAttribute("aria-live")).toBe("polite");
    expect(ackIn("Brass pin").textContent).toBe("");
    fireEvent.click(screen.getAllByText("Want it now")[0]);
    await waitFor(() => expect(ackIn("Brass pin").textContent).toBe("Wish saved: want it now."));
    expect(ackIn("Mug").textContent).toBe("");
    await vi.advanceTimersByTimeAsync(4900);
    expect(ackIn("Brass pin").textContent).toBe("Wish saved: want it now.");
    await vi.advanceTimersByTimeAsync(200);
    expect(ackIn("Brass pin").textContent).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

test("switching and withdrawing say so, and each new action restarts the 5 seconds", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve({ body: ada }, browsing({ "POST /api/items/2/wish": { body: { wished: true } } }));
    render(<App />);
    await screen.findByText("Mug");
    fireEvent.click(screen.getAllByText("Want it now")[1]);
    await waitFor(() => expect(ackIn("Mug").textContent).toBe("Wish saved: want it now."));
    await vi.advanceTimersByTimeAsync(3000);
    fireEvent.click(screen.getAllByText("Someday")[1]);
    await waitFor(() => expect(ackIn("Mug").textContent).toBe("Wish saved: someday."));
    await vi.advanceTimersByTimeAsync(3000);
    expect(ackIn("Mug").textContent).toBe("Wish saved: someday.");
    fireEvent.click(screen.getAllByText("Someday")[1]);
    await waitFor(() => expect(ackIn("Mug").textContent).toBe("Wish withdrawn."));
    await vi.advanceTimersByTimeAsync(4900);
    expect(ackIn("Mug").textContent).toBe("Wish withdrawn.");
    await vi.advanceTimersByTimeAsync(200);
    expect(ackIn("Mug").textContent).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

test("a friend's box says Wish saved. or Wish withdrawn.", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve({ body: fran }, browsing({ "POST /api/items/1/wish": { body: { wished: true } } }));
    render(<App />);
    await screen.findByText("Brass pin");
    const [box] = screen.getAllByLabelText("I would like this") as HTMLInputElement[];
    box.checked = true;
    fireEvent.change(box);
    await waitFor(() => expect(ackIn("Brass pin").textContent).toBe("Wish saved."));
    box.checked = false;
    fireEvent.change(box);
    await waitFor(() => expect(ackIn("Brass pin").textContent).toBe("Wish withdrawn."));
  } finally {
    vi.useRealTimers();
  }
});

test("a refused wish shows no acknowledgement", async () => {
  const server = serve({ body: ada }, browsing({ "POST /api/items/1/wish": { status: 409, body: {} } }));
  render(<App />);
  await screen.findByText("Brass pin");
  fireEvent.click(screen.getAllByText("Want it now")[0]);
  await waitFor(() => expect(server.sent("POST", "/api/items/1/wish")).toHaveLength(1));
  await waitFor(() => expect(pressed("Want it now")).toEqual(["false", "false"]));
  expect(ackIn("Brass pin").textContent).toBe("");
});

test("a family wish the server refuses goes back to how it was", async () => {
  const server = serve({ body: ada }, browsing({ "POST /api/items/2/wish": { status: 409, body: {} } }));
  render(<App />);
  await screen.findByText("Mug");
  fireEvent.click(screen.getAllByText("Someday")[1]);
  await waitFor(() => expect(server.sent("POST", "/api/items/2/wish")).toHaveLength(1));
  expect(server.sent("POST", "/api/items/2/wish")[0].body).toEqual({ wished: false });
  await waitFor(() => expect(pressed("Someday")).toEqual(["false", "true"]));
});

test("an admin browsing sees an Admin link but no Browse link", async () => {
  serve({ body: bob }, browsing());
  render(<App />);
  expect((await screen.findByText("Admin")).getAttribute("href")).toBe("/admin");
  expect(screen.getByText("All wishes").getAttribute("href")).toBe("/admin/wishes");
  expect(screen.queryByText("Browse")).toBeNull();
  expect(await screen.findByText("Brass pin")).toBeTruthy();
});

test("an admin on /admin gets the admin screen and Browse and All wishes links", async () => {
  history.replaceState({}, "", "/admin");
  serve({ body: bob }, { "GET /api/admin/topics": { body: { topics: [] } }, "GET /api/admin/items": { body: { items: [] } } });
  render(<App />);
  expect(await screen.findByText("Topics and items")).toBeTruthy();
  expect(screen.getByText("Browse").getAttribute("href")).toBe("/");
  expect(screen.getByText("All wishes").getAttribute("href")).toBe("/admin/wishes");
});

test("an admin on /admin/wishes gets the all-wishes page", async () => {
  history.replaceState({}, "", "/admin/wishes");
  serve({ body: bob }, { "GET /api/admin/wishes?status=&sort=created": { body: { wishes: [] } } });
  render(<App />);
  expect(await screen.findByText("No wishes match.")).toBeTruthy();
  expect(screen.queryByText("Topics and items")).toBeNull();
  expect(screen.getByText("Browse").getAttribute("href")).toBe("/");
  expect(screen.getByText("Admin").getAttribute("href")).toBe("/admin");
});

test("a non-admin on /admin/wishes sees nothing", async () => {
  history.replaceState({}, "", "/admin/wishes");
  const server = serve({ body: ada }, browsing());
  render(<App />);
  expect(await screen.findByText("Welcome, Ada!")).toBeTruthy();
  expect(screen.queryByText("All wishes")).toBeNull();
  expect(server.calls.filter((call) => call.path.startsWith("/api/admin"))).toHaveLength(0);
});

test("a non-admin on /admin sees neither the catalog nor the admin screen", async () => {
  history.replaceState({}, "", "/admin");
  const server = serve({ body: ada }, browsing());
  render(<App />);
  expect(await screen.findByText("Welcome, Ada!")).toBeTruthy();
  expect(screen.queryByText("Topics and items")).toBeNull();
  expect(screen.queryByText("Browse")).toBeNull();
  expect(server.calls.filter((call) => call.path.startsWith("/api/topics"))).toHaveLength(0);
});

test("topic buttons show how many items the server says the viewer can get, zero included", async () => {
  // The count comes from /api/topics, which leaves out closed items and topics the viewer can't see.
  const topics = [{ slug: "pins & mugs", name: "Pins", available: 2 }, { slug: "art", name: "Art", available: 0 }];
  serve({ body: ada }, browsing({ "GET /api/topics": { body: { topics } } }));
  render(<App />);
  expect(await screen.findByText("Pins (2)")).toBeTruthy();
  expect(screen.getByText("Art (0)")).toBeTruthy();
});

// pin has other wishers, mug has only the viewer's own wish, plate has none.
const plate = { id: 3, title: "Plate", description: "White", wished: false, alsoWantedBy: [], photos: [] };
const threeItems = () => browsing({ "GET /api/items?topic=pins%20%26%20mugs": { body: { items: [pin, mug, plate] } } });
const titles = () => [...document.querySelectorAll("article h2, article h3")].map((h) => h.textContent);

test("an admin browsing can filter items by active wishes or item state", async () => {
  const acceptedVase = { ...plate, id: 4, title: "Vase", status: "accepted" };
  const stagedBowl = { ...plate, id: 5, title: "Bowl", status: "staged" };
  const deliveredCup = { ...plate, id: 6, title: "Cup", status: "delivered" };
  serve(
    { body: bob },
    browsing({
      "GET /api/items?topic=pins%20%26%20mugs": {
        body: { items: [{ ...pin, status: "open" }, { ...mug, status: "open" }, { ...plate, status: "open" }, acceptedVase, stagedBowl, deliveredCup] },
      },
    }),
  );
  render(<App />);
  expect(await screen.findByText("Plate")).toBeTruthy();
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
  expect(titles()).toEqual(["Brass pin", "Mug", "Plate", "Vase", "Bowl", "Cup"]);
  for (const [choice, expected] of [
    ["wished", ["Brass pin", "Mug"]],
    ["open", ["Brass pin", "Mug", "Plate"]],
    ["accepted", ["Vase"]],
    ["staged", ["Bowl"]],
    ["delivered", ["Cup"]],
    ["all", ["Brass pin", "Mug", "Plate", "Vase", "Bowl", "Cup"]],
  ] as const) {
    fireEvent.change(show, { target: { value: choice } });
    await waitFor(() => expect(titles()).toEqual(expected));
  }
});

test.each([["family", ada], ["friend", fran]])(
  "%s browsing sees no Show filter and every item",
  async (_group, who) => {
    const server = serve({ body: who }, threeItems());
    render(<App />);
    expect(await screen.findByText("Plate")).toBeTruthy();
    expect(screen.queryByLabelText("Show")).toBeNull();
    expect(screen.queryByText("Items with wishes")).toBeNull();
    expect(titles()).toEqual(["Brass pin", "Mug", "Plate"]);
    expect(server.sent("GET", "/api/items?topic=pins%20%26%20mugs")).toHaveLength(1);
  },
);

const wishedPin = { ...pin, activeWishes: [{ id: 21, name: "Bob", kind: "now" }, { id: 22, name: "Bea", kind: "someday" }] };
const wishedRoutes = (more: Record<string, Route> = {}) =>
  browsing({ "GET /api/items?topic=pins%20%26%20mugs": { body: { items: [wishedPin, plate] } }, ...more });

test("an admin browsing gets a Cancel wish button for each active wish, own included", async () => {
  serve({ body: bob }, wishedRoutes());
  render(<App />);
  await screen.findByText("Plate");
  expect(screen.getAllByText("Cancel wish")).toHaveLength(2);
  expect(screen.getAllByText("Cancel wish").map((b) => b.closest("p")?.textContent)).toEqual(["BobCancel wish", "Bea (someday)Cancel wish"]);
});

test("an admin's cancel on browsing asks first, posts to the admin route, notes it, and reloads", async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  const server = serve({ body: bob }, wishedRoutes({ "POST /api/admin/wishes/22/cancel": { body: { ok: true, mail: "email" } } }));
  render(<App />);
  await screen.findByText("Plate");
  fireEvent.click(screen.getAllByText("Cancel wish")[1]);
  expect(confirm).toHaveBeenCalledWith("Cancel Bea's wish for Brass pin? Bea will get a short email saying the wish was cancelled.");
  expect(await screen.findByText("Wish cancelled. Bea was emailed.")).toBeTruthy();
  expect(server.sent("POST", "/api/admin/wishes/22/cancel")).toHaveLength(1);
  await waitFor(() => expect(server.sent("GET", "/api/items?topic=pins%20%26%20mugs")).toHaveLength(2));
});

test("an admin who declines the prompt posts nothing", async () => {
  vi.stubGlobal("confirm", () => false);
  const server = serve({ body: bob }, wishedRoutes());
  render(<App />);
  await screen.findByText("Plate");
  fireEvent.click(screen.getAllByText("Cancel wish")[0]);
  expect(server.sent("POST", "/api/admin/wishes/21/cancel")).toHaveLength(0);
});

test.each([["family", ada], ["friend", fran]])("%s browsing never sees Cancel wish", async (_group, who) => {
  serve({ body: who }, wishedRoutes());
  render(<App />);
  await screen.findByText("Plate");
  expect(screen.queryByText("Cancel wish")).toBeNull();
});

test("opening an #item-<id> link selects that item's topic and scrolls the item into view", async () => {
  const scrolled: string[] = [];
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    scrolled.push(this.id);
  });
  const painting = { ...plate, id: 5, title: "Oil painting" };
  history.replaceState({}, "", "/#item-5");
  serve(
    { body: ada },
    browsing({
      "GET /api/items/5": { body: { item: { ...painting, topic: "art" } } },
      "GET /api/items?topic=art": { body: { items: [plate, painting] } },
    }),
  );
  render(<App />);
  expect(await screen.findByText("Oil painting")).toBeTruthy();
  expect(screen.getByText("Art").className).toBe("on");
  expect(screen.getByText("Pins").className).toBe("");
  await waitFor(() => expect(scrolled).toEqual(["item-5"]));
});

test.each(["/#item-99", "/#other-section"])(
  "opening %s falls back to the first topic without scrolling",
  async (url) => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.id);
    });
    history.replaceState({}, "", url);
    serve(
      { body: ada },
      browsing({
        "GET /api/items/99": { status: 404, body: { error: "Not found" } },
      }),
    );
    render(<App />);
    expect(await screen.findByText("Brass pin")).toBeTruthy();
    expect(screen.getByText("Pins").className).toBe("on");
    expect(scrolled).toEqual([]);
  },
);
