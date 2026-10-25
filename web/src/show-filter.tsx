// The item filter control, shared by the admin page and an admin's view of
// the browsing page. "With wishes" means at least one active wish.
export type Show = "all" | "wished" | "open" | "accepted" | "staged" | "delivered";

const CHOICES: [Show, string][] = [
  ["all", "All items"],
  ["wished", "Items with wishes"],
  ["open", "Open"],
  ["accepted", "Accepted"],
  ["staged", "Staged"],
  ["delivered", "Delivered"],
];

export function ShowFilter({ show, setShow }: { show: Show; setShow: (show: Show) => void }) {
  return (
    <label>
      Show
      <select value={show} onChange={(event) => setShow(event.currentTarget.value as Show)}>
        {CHOICES.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
    </label>
  );
}

export function matchesShow(show: Show, status: string | undefined, hasWish: boolean): boolean {
  if (show === "all") return true;
  if (show === "wished") return hasWish;
  return status === show;
}
