export type Group = "admin" | "family" | "friend";
export type Host = "family" | "friends";

export type Session = {
  email: string;
  name: string;
  firstName: string;
  group: Group;
  topics: "all" | string[];
  host: Host;
};

export function isGroup(value: string): value is Group {
  return value === "admin" || value === "family" || value === "friend";
}

// Admins and family carry "all"; a friend carries their granted topics.
export function canSeeTopic(session: Session, topicSlug: string): boolean {
  if (session.topics === "all") return true;
  return session.topics.includes(topicSlug);
}

// Family never sees prices. Admins and friends do.
export function canSeePrice(session: Session): boolean {
  return session.group !== "family";
}

export function canSeeOtherWishers(session: Session): boolean {
  return session.group !== "friend";
}
