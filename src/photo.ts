import { notFound } from "./http";
import { photoLinkValid } from "./photo-link";
import { canSeeTopic, type Session } from "./visibility";

type PhotoRow = { r2_key: string; status: string; slug: string };

export async function getPhoto(env: Env, session: Session | null, id: number): Promise<Response> {
  if (!session) return notFound();
  return photoFor(env, session, id);
}

async function photoFor(env: Env, session: Session, id: number): Promise<Response> {
  const photo = await loadPhoto(env, id);
  if (!photo) return notFound();
  return visiblePhoto(env, session, photo);
}

async function loadPhoto(env: Env, id: number): Promise<PhotoRow | null> {
  return env.DB.prepare(
    `SELECT p.r2_key, i.status, t.slug
     FROM photos p
     JOIN items i ON i.id = p.item_id
     JOIN topics t ON t.id = i.topic_id
     WHERE p.id = ?`,
  )
    .bind(id)
    .first<PhotoRow>();
}

async function visiblePhoto(env: Env, session: Session, photo: PhotoRow): Promise<Response> {
  if (blocked(session, photo)) return notFound();
  return streamPhoto(env, photo.r2_key);
}

function blocked(session: Session, photo: PhotoRow): boolean {
  if (closedToMember(session, photo)) return true;
  return !canSeeTopic(session, photo.slug);
}

function closedToMember(session: Session, photo: PhotoRow): boolean {
  if (session.group === "admin") return false;
  return photo.status !== "open";
}

// A signed email link: no session, but only for a photo of an open item.
export async function getEmailPhoto(env: Env, id: number, url: URL): Promise<Response> {
  if (!(await photoLinkValid(env, id, url))) return notFound();
  const photo = await loadPhoto(env, id);
  if (photo?.status !== "open") return notFound();
  return streamPhoto(env, photo.r2_key, "public, max-age=86400");
}

async function streamPhoto(env: Env, key: string, caching = "private, max-age=300"): Promise<Response> {
  const object = await env.PHOTOS.get(key);
  if (!object) return notFound();
  return new Response(object.body, { headers: photoHeaders(object, caching) });
}

function photoHeaders(object: R2ObjectBody, caching: string): Headers {
  const headers = new Headers();
  headers.set("content-type", contentType(object));
  headers.set("cache-control", caching);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function contentType(object: R2ObjectBody): string {
  const meta = object.httpMetadata;
  if (!meta) return "image/jpeg";
  return typeOrJpeg(meta.contentType);
}

function typeOrJpeg(value: string | undefined): string {
  if (!value) return "image/jpeg";
  return value;
}
