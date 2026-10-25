import { cleanup, render } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { Note } from "../src/note";

afterEach(cleanup);

test("an empty note renders nothing", () => {
  const { container } = render(<Note text="" label="Code:" />);
  expect(container.innerHTML).toBe("");
});

test("a note shows its text with its class", () => {
  const { container } = render(<Note text="Saved." className="note" />);
  expect(container.innerHTML).toBe('<p class="note">Saved.</p>');
});

test("a labeled note puts the label and a space before the text", () => {
  const { container } = render(<Note text="123456" label="Code:" />);
  expect(container.textContent).toBe("Code: 123456");
});
