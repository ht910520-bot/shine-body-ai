import { createHash, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "shine_auth";

// Same SHA-256 hex digest the login route stores in the shine_auth cookie.
export function sessionTokenFor(accessCode: string) {
  return createHash("sha256").update(accessCode).digest("hex");
}

export function readCookie(cookieHeader: string, name: string) {
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      try {
        return decodeURIComponent(value.slice(prefix.length));
      } catch {
        return value.slice(prefix.length);
      }
    }
  }
  return "";
}

function headerText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join("; ");
  return value || "";
}

export function isValidSession(cookieHeader: string | string[] | undefined, accessCode = process.env.APP_ACCESS_CODE || "") {
  if (!accessCode) return false;
  const expected = sessionTokenFor(accessCode);
  const actual = readCookie(headerText(cookieHeader), COOKIE_NAME);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
