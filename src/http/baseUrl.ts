/** Hostnames that can only be this machine, in the forms `new URL` reports. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface BaseUrlCheck {
  /** The environment variable being read, named in every rejection. */
  name: string;
  /** The real API, returned when the variable is unset or already names it. */
  realBaseUrl: string;
  /** The credential that would travel to whatever host the variable names. */
  credential: string;
}

/**
 * The base URL to send a credential to, or a throw.
 *
 * Both TYPEFULLY_BASE_URL and SLACK_API_BASE_URL exist to point a run at a
 * local stub, and both carry a bearer credential to whatever host they name.
 * Anything that is neither the real API nor a loopback address is refused, so
 * neither credential can be redirected to a third party by setting one
 * environment variable. A trailing slash is dropped, because callers join the
 * result to a path.
 */
export function checkedBaseUrl(value: string | undefined, check: BaseUrlCheck): string {
  const trimmed = value?.trim();
  if (!trimmed) return check.realBaseUrl;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${check.name} is not a URL: ${trimmed}`);
  }
  // "localhost:8787" parses, as a URL whose scheme is "localhost" and whose
  // host is empty, so check the scheme before the host to name that typo.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${check.name} needs an http:// or https:// scheme; got ${trimmed}.`);
  }
  // Dropped after the parse, so a value of "/" is still a throw rather than an
  // empty string that reads as unset.
  const base = trimmed.replace(/\/+$/, "");
  if (base === check.realBaseUrl) return check.realBaseUrl;
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${check.name} is ${trimmed}, and ${check.credential} would be sent to ` +
        `${url.hostname}. It only takes a loopback address, for the local stub, or ` +
        `${check.realBaseUrl}. Leave it unset in production.`,
    );
  }
  return base;
}
