// Move an item card to another topic, shared by the admin page and an admin's
// view of the browsing page.
import { useState } from "preact/hooks";
import { firstField, orValue } from "./api";
import { moveItem } from "./wish-actions";

export type MoveOption = { id: number; name: string };

export function MoveTopic({ itemId, topics, say, reload }: {
  itemId: number;
  topics: MoveOption[];
  say: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const topicId = orValue(picked, firstField(topics, 0, (topic) => topic.id));
  if (!topicId) return null;
  return (
    <p>
      <select aria-label="Move to topic" value={String(topicId)} onChange={(event) => setPicked(Number(event.currentTarget.value))}>
        {topics.map((topic) => (
          <option key={topic.id} value={topic.id}>{topic.name}</option>
        ))}
      </select>
      <button type="button" onClick={() => void moveItem(itemId, topicId, say, reload)}>Move to</button>
    </p>
  );
}
