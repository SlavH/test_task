import crypto from "node:crypto";

const SESSION_COOKIE = "fixcall_admin";
const CSRF_COOKIE = "fixcall_csrf";

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function sign(value, secret) {
  return base64Url(crypto.createHmac("sha256", secret).update(value).digest());
}

export function createSessionToken(secret) {
  const payload = base64Url(
    JSON.stringify({ iat: Date.now(), v: 1 }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload, secret);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return Boolean(data?.v === 1 && data?.iat);
  } catch {
    return false;
  }
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(value.join("="));
  }
  return cookies;
}

export function sessionCookie(token, { secure = false } = {}) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function csrfCookie() {
  const token = base64Url(crypto.randomBytes(24));
  return { token, cookie: `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=2592000` };
}

export function readSession(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE], secret);
}

export function readCsrf(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[CSRF_COOKIE] || "";
}

export function constantTimePasswordMatch(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export { SESSION_COOKIE, CSRF_COOKIE };
