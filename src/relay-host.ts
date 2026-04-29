export function slugFromRelayHostname(hostname: string, baseHostname: string): string | null {
  const host = normalizeHostname(hostname);
  const base = normalizeHostname(baseHostname);
  if (!host.endsWith(`.${base}`)) {
    return null;
  }
  const slug = host.slice(0, -(base.length + 1));
  return isRelaySlugHostnameLabel(slug) ? slug : null;
}

export function isRelayTlsDomainAllowed(
  domain: string,
  baseHostname: string,
  isKnownSlug: (slug: string) => boolean,
): boolean {
  const host = normalizeHostname(domain);
  const base = normalizeHostname(baseHostname);
  if (host === base) {
    return true;
  }
  const slug = slugFromRelayHostname(host, base);
  return slug !== null && isKnownSlug(slug);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function isRelaySlugHostnameLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}
