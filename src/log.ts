export type AcceptLog = {
  log_id: number;
  timestamp_ct: string;
  item_id: number;
  title: string;
  topic: string;
  winner_email: string;
  winner_name: string;
  winner_group: string;
  accepted_by: string;
  winner_wish: "now" | "someday";
};
