import { canSeeOtherWishers, canSeePrice, canSeeTopic, type Session } from "./visibility";

export type ItemStatus = "open" | "accepted" | "staged" | "delivered";
export type WishStatus = "active" | "withdrawn" | "accepted";
export type WishKind = "now" | "someday";

export type RawWish = {
  id?: number;
  email: string;
  name: string;
  status: WishStatus;
  kind: WishKind;
};

export type RawItem = {
  id: number;
  topicSlug: string;
  title: string;
  description: string;
  priceCents: number | null;
  status: ItemStatus;
  photos: { id: number }[];
  wishes: RawWish[];
};

export type MemberItem = {
  id: number;
  topic: string;
  title: string;
  description: string;
  wished: boolean;
  photos: { id: number; url: string }[];
  priceCents?: number;
  wishKind?: WishKind;
  alsoWantedBy?: { name: string; kind: WishKind }[];
  othersWishing?: number;
  activeWishes?: { id: number; name: string; kind: WishKind }[];
  status?: ItemStatus;
  acceptedFor?: string;
};

function photoUrl(id: number): string {
  return `/photo/${id}`;
}

// One serializer for member responses. Null means the viewer must get a 404.
// Price and other wishers are omitted as keys, not sent as null or zero.
export function serializeMemberItem(viewer: Session, item: RawItem): MemberItem | null {
  if (!canSeeItem(viewer, item)) return null;

  const view: MemberItem = {
    id: item.id,
    topic: item.topicSlug,
    title: item.title,
    description: item.description,
    wished: false,
    photos: item.photos.map((photo) => ({ id: photo.id, url: photoUrl(photo.id) })),
  };

  const own = item.wishes.find((wish) => wish.email === viewer.email && wish.status === "active");
  if (own) {
    view.wished = true;
    view.wishKind = own.kind;
  }

  if (canSeePrice(viewer) && item.priceCents != null) {
    view.priceCents = item.priceCents;
  }

  addWishers(viewer, item, view);
  return view;
}

function canSeeItem(viewer: Session, item: RawItem): boolean {
  if (!canSeeStatus(viewer, item.status)) return false;
  return canSeeTopic(viewer, item.topicSlug);
}

function canSeeStatus(viewer: Session, status: ItemStatus): boolean {
  if (viewer.group === "admin") return true;
  return status === "open";
}

function addWishers(viewer: Session, item: RawItem, view: MemberItem): void {
  // Family and admins see who else wishes; a friend sees only how many.
  const others = item.wishes.filter((wish) => wish.status === "active" && wish.email !== viewer.email);
  if (canSeeOtherWishers(viewer)) view.alsoWantedBy = others.map((wish) => ({ name: wish.name, kind: wish.kind }));
  else view.othersWishing = others.length;
  // Admins act on wishes and filter by state from the browsing page.
  if (viewer.group === "admin") {
    view.activeWishes = activeWishes(item.wishes);
    view.status = item.status;
    addAcceptedFor(item.wishes, view);
  }
}

function addAcceptedFor(wishes: RawWish[], view: MemberItem): void {
  const accepted = wishes.find((wish) => wish.status === "accepted");
  if (accepted) view.acceptedFor = accepted.name;
}

function activeWishes(wishes: RawWish[]): { id: number; name: string; kind: WishKind }[] {
  return wishes.filter((wish) => wish.status === "active").map((wish) => ({ id: Number(wish.id), name: wish.name, kind: wish.kind }));
}
