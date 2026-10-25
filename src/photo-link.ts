import { DOMAIN } from "./hosts";
import { secretsMatch } from "./secret";

// Photos normally need a session. Email clients have none, so the new-items
// email links each photo with an expiring HMAC signature instead. A link
// shows that one photo, only while its item is open, until it expires.
export const PHOTO_LINK_TTL_S = 30 * 24 * 3600;

export async function signedPhotoUrl(env: Env, photoId: number, now = Date.now()): Promise<string | null> {
  const key = env.PHOTO_LINK_KEY;
  if (!key) return null;
  const exp = Math.floor(now / 1000) + PHOTO_LINK_TTL_S;
  return `https://family.${DOMAIN}/photo/${photoId}/email?exp=${exp}&sig=${await signature(key, photoId, exp)}`;
}

export async function photoLinkValid(env: Env, photoId: number, url: URL, now = Date.now()): Promise<boolean> {
  const key = env.PHOTO_LINK_KEY;
  const exp = Number(url.searchParams.get("exp"));
  if (!key || !Number.isInteger(exp) || exp * 1000 < now) return false;
  return secretsMatch(url.searchParams.get("sig") ?? "", await signature(key, photoId, exp));
}

async function signature(key: string, photoId: number, exp: number): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", hmac, encoder.encode(`photo:${photoId}:${exp}`));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
