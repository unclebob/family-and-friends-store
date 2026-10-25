import siteConfig from "../site.config.json";
import type { Host } from "./visibility";

export const DOMAIN = siteConfig.domain;

export function requestHost(request: Request, envName: string): Host | null {
  const named = hostFromName(new URL(request.url).hostname);
  if (envName === "dev") return devHost(named);
  return named;
}

function devHost(named: Host | null): Host {
  if (named) return named;
  return "family";
}

function hostFromName(hostname: string): Host | null {
  const name = hostname.toLowerCase();
  if (name === `family.${DOMAIN}`) return "family";
  if (name === `friends.${DOMAIN}`) return "friends";
  return null;
}
