import { describe, expect, it } from "vitest";
import { checkedBaseUrl } from "../src/http/baseUrl.js";

const SLACK = {
  name: "SLACK_API_BASE_URL",
  realBaseUrl: "https://slack.com/api",
  credential: "SLACK_BOT_TOKEN",
};

describe("checkedBaseUrl", () => {
  it("returns the real API when the variable is unset, blank or already set to it", () => {
    expect(checkedBaseUrl(undefined, SLACK)).toBe("https://slack.com/api");
    expect(checkedBaseUrl("  ", SLACK)).toBe("https://slack.com/api");
    expect(checkedBaseUrl("https://slack.com/api", SLACK)).toBe("https://slack.com/api");
  });

  it("takes a loopback stub, including one on a path", () => {
    expect(checkedBaseUrl("http://localhost:8787/slack", SLACK)).toBe(
      "http://localhost:8787/slack",
    );
    expect(checkedBaseUrl("http://127.0.0.1:8787", SLACK)).toBe("http://127.0.0.1:8787");
    expect(checkedBaseUrl("http://[::1]:8787", SLACK)).toBe("http://[::1]:8787");
  });

  it("drops a trailing slash, so the real API matches and callers can join a path", () => {
    expect(checkedBaseUrl("https://slack.com/api/", SLACK)).toBe("https://slack.com/api");
    expect(checkedBaseUrl("http://localhost:8787/slack//", SLACK)).toBe(
      "http://localhost:8787/slack",
    );
  });

  it("refuses a host that is neither the real API nor loopback", () => {
    expect(() => checkedBaseUrl("https://slack.com.evil.io/api", SLACK)).toThrow(
      /SLACK_BOT_TOKEN would be sent to slack\.com\.evil\.io/,
    );
  });

  it("refuses a subdomain of loopback, which resolves off this machine", () => {
    expect(() => checkedBaseUrl("http://localhost.evil.io", SLACK)).toThrow(
      /would be sent to localhost\.evil\.io/,
    );
  });

  it("names the missing scheme on a bare host and port", () => {
    expect(() => checkedBaseUrl("localhost:8787", SLACK)).toThrow(
      /needs an http:\/\/ or https:\/\/ scheme/,
    );
  });

  it("throws on a value that will not parse", () => {
    expect(() => checkedBaseUrl("not a url", SLACK)).toThrow(/SLACK_API_BASE_URL is not a URL/);
  });

  it("throws on a value that is only slashes, rather than reading it as unset", () => {
    expect(() => checkedBaseUrl("/", SLACK)).toThrow(/SLACK_API_BASE_URL is not a URL: \//);
    expect(() => checkedBaseUrl("///", SLACK)).toThrow(/is not a URL/);
  });
});
