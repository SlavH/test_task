import crypto from "node:crypto";

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export async function retellRequest(
  config,
  method,
  path,
  body,
  { timeoutMs = 20000 } = {},
) {
  if (!config.retellApiKey) {
    throw new Error("RETELL_API_KEY is not configured");
  }
  const response = await fetch(`${config.retellApiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.retellApiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail =
      typeof data === "string" ? data : data?.message || JSON.stringify(data);
    throw new Error(`Retell ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return data;
}

export function signRetellBody(rawBody, apiKey, timestamp = Date.now()) {
  const digest = crypto
    .createHmac("sha256", apiKey)
    .update(`${rawBody}${timestamp}`)
    .digest("hex");
  return `v=${timestamp},d=${digest}`;
}

export function verifyRetellBody({
  rawBody,
  apiKey,
  signature,
  now = Date.now(),
  toleranceMs = SIGNATURE_WINDOW_MS,
}) {
  if (!signature || typeof signature !== "string") {
    return { ok: false, reason: "missing_signature" };
  }
  const match = /^v=(\d+),d=([0-9a-f]+)$/i.exec(signature.trim());
  if (!match) return { ok: false, reason: "malformed_signature" };
  const timestamp = Number(match[1]);
  const provided = Buffer.from(match[2], "hex");
  if (!Number.isSafeInteger(timestamp) || provided.length !== 32) {
    return { ok: false, reason: "malformed_signature" };
  }
  if (Math.abs(now - timestamp) > toleranceMs) {
    return { ok: false, reason: "stale_signature" };
  }
  const expected = crypto
    .createHmac("sha256", apiKey)
    .update(`${rawBody}${timestamp}`)
    .digest();
  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

export function sanitizeCall(call) {
  if (!call || typeof call !== "object") return call;
  const copy = JSON.parse(JSON.stringify(call));
  delete copy.access_token;
  return copy;
}

export function normalizeTranscript(call) {
  if (!call) return [];
  const object = call.transcript_object || call.transcript_with_tool_calls;
  if (Array.isArray(object)) {
    return object
      .map((item) => {
        const role = String(item.role || item.speaker || "").toLowerCase();
        if (!["agent", "assistant", "user", "customer"].includes(role)) {
          return null;
        }
        const text = String(item.content || item.text || "").trim();
        if (!text) return null;
        return {
          role: role === "assistant" ? "agent" : role === "customer" ? "user" : role,
          content: text,
          at: item.start_timestamp || item.timestamp || null,
        };
      })
      .filter(Boolean);
  }

  const text = String(call.transcript || "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*(agent|assistant|user|customer|caller)\s*:\s*(.*)$/i.exec(
        line,
      );
      if (!match) return null;
      const role = match[1].toLowerCase();
      const content = match[2].trim();
      if (!content) return null;
      return {
        role: role === "assistant" ? "agent" : role === "caller" ? "user" : role,
        content,
      };
    })
    .filter(Boolean);
}

export function transcriptText(call) {
  const turns = normalizeTranscript(call);
  if (turns.length) {
    return turns
      .map((turn) => `${turn.role === "agent" ? "Agent" : "Caller"}: ${turn.content}`)
      .join("\n");
  }
  return String(call?.transcript || "").trim();
}
