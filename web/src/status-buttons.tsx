import { setItemStatus, type DeliveryStatus } from "./wish-actions";

type ButtonSpec = { label: string; next: DeliveryStatus; className?: string };

const BUTTONS: Record<string, ButtonSpec[]> = {
  accepted: [{ label: "Stage", next: "staged" }],
  staged: [
    { label: "Deliver", next: "delivered" },
    { label: "Unstage", next: "accepted", className: "quiet" },
  ],
  delivered: [{ label: "Undeliver", next: "staged", className: "quiet" }],
};

export function StatusButtons({ itemId, status, say, reload }: {
  itemId: number;
  status: string;
  say: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const buttons = BUTTONS[status];
  if (!buttons) return null;
  return (
    <>
      {buttons.map((button) => (
        <button
          key={button.next}
          className={button.className}
          type="button"
          onClick={() => void setItemStatus(itemId, button.next, say, reload)}
        >
          {button.label}
        </button>
      ))}
    </>
  );
}
