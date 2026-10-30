import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createSessionToken, verifySessionToken, parseCookies, sessionCookie, clearSessionCookie, csrfCookie, readCsrf, constantTimePasswordMatch, CSRF_COOKIE } from "./auth.mjs";
import { provisionAgent } from "./provision.mjs";
import {
  cleanString,
  validateBooking,
  validateMessage,
  validateWarrantyMessage,
} from "./domain.mjs";
import {
  retellRequest,
  sanitizeCall,
  verifyRetellBody,
} from "./retell.mjs";
import { statsForNotifications } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function setSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "microphone=(self), camera=(), geolocation=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self' https: wss:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  next();
}

function verifyWebhook(req, config, rawBody) {
  const signature = req.get("x-retell-signature");
  if (!signature && config.allowUnsignedRetell) {
    return { ok: true, unsigned: true };
  }
  if (!config.retellApiKey) {
    return { ok: false, reason: "api_key_missing" };
  }
  return verifyRetellBody({
    rawBody,
    apiKey: config.retellApiKey,
    signature,
  });
}

function parseJson(rawBody) {
  try {
    return { ok: true, value: JSON.parse(rawBody || "{}") };
  } catch {
    return { ok: false };
  }
}

function createRateLimiter(limit, windowMs = 60_000) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const list = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (list.length >= limit) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many demo calls. Please wait a minute and try again.",
      });
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

const TOOL_DEFINITIONS = {
  "book-service-call": validateBooking,
  "take-warranty-message": validateWarrantyMessage,
  "take-message": validateMessage,
};

export function createApp({
  config,
  store,
  notificationService,
  eventBus,
  logger = console,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(setSecurityHeaders);

  function isAdmin(req) {
    if (!config.dashboardPassword) return true;
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionToken(cookies.fixcall_admin, config.adminSessionSecret);
  }

  function requireAdmin(req, res, next) {
    if (isAdmin(req)) return next();
    return res.status(401).json({ error: "admin_required" });
  }

  function requireCsrf(req, res, next) {
    if (!config.dashboardPassword) return next();
    const cookies = parseCookies(req.headers.cookie);
    const header = req.get("x-csrf-token") || "";
    if (cookies.fixcall_csrf && cookies.fixcall_csrf === header) return next();
    return res.status(403).json({ error: "csrf_failed" });
  }

  function validatePersona(body) {
    const warmth = ["warm", "professional", "casual"].includes(body?.warmth)
      ? body.warmth
      : "warm";
    const taskFocus = ["task_focused", "balanced", "conversational"].includes(body?.taskFocus)
      ? body.taskFocus
      : "task_focused";
    let businessFacts = {};
    if (body?.businessFacts && typeof body.businessFacts === "object" && !Array.isArray(body.businessFacts)) {
      businessFacts = body.businessFacts;
    } else if (typeof body?.businessFacts === "string") {
      try {
        const parsed = JSON.parse(body.businessFacts || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) businessFacts = parsed;
      } catch {
        return { ok: false, error: "invalid_business_facts" };
      }
    } else if (body?.businessFacts !== undefined && body?.businessFacts !== null) {
      return { ok: false, error: "invalid_business_facts" };
    }
    const promptAdditions = String(body?.promptAdditions || "").slice(0, 4000);
    return { ok: true, persona: { warmth, taskFocus, businessFacts, promptAdditions } };
  }

  app.get("/healthz", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      agentConfigured: Boolean(config.retellAgentId),
      storeReady: store.ready,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/retell/tools", express.raw({ type: "application/json", limit: "2mb" }));
  app.use("/api/retell", express.raw({ type: "application/json", limit: "2mb" }));
  app.use("/api/retell-proxy", express.raw({ type: "*/*", limit: "2mb" }));
  app.use(express.json({ limit: "128kb" }));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.get(
    "/api/notifications",
    asyncRoute(async (req, res) => {
      const q = cleanString(req.query.q, 200).toLowerCase();
      const type = cleanString(req.query.type, 40);
      const status = cleanString(req.query.status, 40);
      const source = cleanString(req.query.source, 40);
      const all = await store.listNotifications();
      const notifications = all.filter((item) => {
        if (type && type !== "all" && item.type !== type) return false;
        if (status && status !== "all" && item.status !== status) return false;
        if (source && source !== "all" && item.source !== source) return false;
        if (!q) return true;
        return [
          item.callerName,
          item.company,
          item.callbackNumber,
          item.fromNumber,
          item.appliance,
          item.brand,
          item.issue,
          item.jobDetails,
          item.reason,
          item.serviceAddress,
          item.bookingId,
          item.summary,
          item.transcriptText,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
      res.json({
        notifications,
        stats: statsForNotifications(all),
        updatedAt: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/notifications/:callId",
    asyncRoute(async (req, res) => {
      const notification = await store.getNotification(req.params.callId);
      if (!notification) {
        return res.status(404).json({ error: "not_found" });
      }
      return res.json({ notification });
    }),
  );

  app.get("/api/config", (req, res) => {
    res.json({
      companyName: config.companyName,
      dashboardTitle: config.dashboardTitle,
      timezone: config.timezone,
      agentConfigured: Boolean(config.retellAgentId),
      telegramConfigured: Boolean(
        config.telegramBotToken && config.telegramChatId,
      ),
    });
  });

  app.get("/api/auth/status", (req, res) => {
    res.json({ admin: isAdmin(req), authEnabled: Boolean(config.dashboardPassword) });
  });

  app.get("/api/auth/csrf", (req, res) => {
    const { token, cookie } = csrfCookie();
    res.setHeader("Set-Cookie", cookie);
    res.json({ token });
  });

  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    if (!config.dashboardPassword) return res.json({ ok: true, admin: true });
    const password = String(req.body?.password || "");
    if (!constantTimePasswordMatch(password, config.dashboardPassword)) {
      return res.status(401).json({ error: "invalid_password" });
    }
    const token = createSessionToken(config.adminSessionSecret);
    const { token: csrf, cookie: csrfCookieValue } = csrfCookie();
    res.setHeader("Set-Cookie", [sessionCookie(token), csrfCookieValue]);
    return res.json({ ok: true, admin: true, csrf });
  }));

  app.post("/api/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", [clearSessionCookie(), `${CSRF_COOKIE}=; Path=/; Max-Age=0`]);
    return res.json({ ok: true });
  });

  app.get("/api/admin/persona", requireAdmin, asyncRoute(async (req, res) => {
    const persona = await store.getPersonaConfig();
    res.json({ persona });
  }));

  app.put("/api/admin/persona", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const validated = validatePersona(req.body || {});
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const persona = await store.savePersonaConfig(validated.persona);
    await store.addAudit("persona_updated", { warmth: persona.warmth, taskFocus: persona.taskFocus });
    res.json({ persona });
  }));

  app.post("/api/admin/persona/preview", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const validated = validatePersona(req.body || {});
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const { renderPersonaPrompt } = await import("./provision.mjs");
    const prompt = await renderPersonaPrompt(validated.persona);
    res.json({ ok: true, persona: validated.persona, prompt });
  }));

  app.post("/api/admin/persona/apply", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const validated = validatePersona(req.body || {});
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    await store.savePersonaConfig(validated.persona);
    await store.addAudit("persona_updated", { warmth: validated.persona.warmth, taskFocus: validated.persona.taskFocus });
    const state = await provisionAgent({ config, store });
    res.json({ ok: true, state });
  }));

  app.get("/api/admin/export", requireAdmin, asyncRoute(async (req, res) => {
    const data = await store.exportData();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=fixcall-export.json");
    res.send(JSON.stringify(data, null, 2));
  }));

  app.post("/api/admin/calls/:callId/notes", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    if (note.length < 2) return res.status(400).json({ error: "note_too_short" });
    const saved = await store.addCallNote(req.params.callId, note, config.dashboardUser || "admin");
    await store.addAudit("note_added", { callId: req.params.callId });
    res.status(201).json({ note: saved });
  }));

  app.get("/api/admin/calls/:callId/notes", requireAdmin, asyncRoute(async (req, res) => {
    const notes = await store.listCallNotes(req.params.callId);
    res.json({ notes });
  }));

  app.post("/api/admin/calls/:callId/tags", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const tag = String(req.body?.tag || "").trim().slice(0, 40);
    if (tag.length < 1) return res.status(400).json({ error: "tag_required" });
    const tags = await store.addCallTag(req.params.callId, tag);
    await store.addAudit("tag_added", { callId: req.params.callId, tag });
    res.json({ tags });
  }));

  app.delete("/api/admin/calls/:callId/tags/:tag", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const tags = await store.removeCallTag(req.params.callId, req.params.tag);
    await store.addAudit("tag_removed", { callId: req.params.callId, tag: req.params.tag });
    res.json({ tags });
  }));

  app.post("/api/admin/calls/:callId/resend-telegram", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
    const notification = await store.getNotification(req.params.callId);
    if (!notification) return res.status(404).json({ error: "not_found" });
    const result = await notificationService.deliverTelegram(notification, true);
    res.json({ ok: Boolean(result?.ok), result });
  }));

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write("event: ready\ndata: {}\n\n");
    eventBus.add(res);
    req.on("close", () => eventBus.remove(res));
    res.setTimeout?.(0);
  });

  app.post("/api/retell/tools/:toolName", asyncRoute(async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body || "");
    const verification = verifyWebhook(req, config, rawBody);
    if (!verification.ok) {
      return res.status(401).json({ error: "invalid_signature" });
    }
    const body = parseJson(rawBody);
    if (!body.ok) return res.status(400).json({ error: "invalid_json" });
    const payload = body.value;
    const args = payload.args || payload;
    const call = sanitizeCall(payload.call || {});
    const callId = call.call_id || payload.call_id;
    if (!callId) return res.status(400).json({ error: "missing_call_id" });

    const toolName = req.params.toolName;
    const validator = TOOL_DEFINITIONS[toolName];
    if (!validator) {
      return res.status(404).json({ error: "unknown_tool" });
    }

    const existingCall = (await store.getCall(callId)) || {};
    const callSnapshot = {
      ...existingCall,
      ...call,
      call_id: callId,
      tool_records: existingCall.tool_records || [],
    };
    await store.upsertCall(callSnapshot);

    const existingBooking = await store.getBooking(callId);
    const existingMessage = await store.getMessage(callId);
    if (
      toolName === "book-service-call" &&
      existingBooking
    ) {
      await store.addToolRecord(callId, {
        kind: "booking",
        tool: toolName,
        ok: true,
        duplicate: true,
        record: existingBooking,
      });
      return res.json({
        ok: true,
        booking_id: existingBooking.booking_id,
        status: existingBooking.status,
        message:
          "That service request is already saved. Tell the caller the office will call to confirm the appointment time.",
      });
    }
    if (
      (toolName === "take-warranty-message" || toolName === "take-message") &&
      existingMessage?.message_id
    ) {
      return res.json({
        ok: true,
        message_id: existingMessage.message_id,
        status: "message_taken",
        message:
          "That message is already saved. Tell the caller the team will call them back.",
      });
    }

    const result = validator(callSnapshot, args);
    if (!result.ok) {
      await store.addToolRecord(callId, {
        kind: `${toolName}:rejected`,
        tool: toolName,
        ok: false,
        code: result.code,
        args,
      });
      logger.warn(`Tool ${toolName} rejected for ${callId}: ${result.code}`);
      return res.json({
        ok: false,
        code: result.code,
        message: result.message,
      });
    }

    if (toolName === "book-service-call") {
      const booking = result.booking;
      await store.saveBooking(booking);
      await store.addToolRecord(callId, {
        kind: "booking",
        tool: toolName,
        ok: true,
        record: booking,
      });
      return res.json({
        ok: true,
        booking_id: booking.booking_id,
        status: "booked",
        message:
          "The service request is saved. Tell the caller the office will call to confirm the appointment time. Do not promise a specific time.",
      });
    }

    const message = result.message;
    await store.saveMessage(message);
    await store.addToolRecord(callId, {
      kind:
        toolName === "take-warranty-message" ? "warranty_company" : "message",
      tool: toolName,
      ok: true,
      record: message,
    });
    return res.json({
      ok: true,
      message_id: message.message_id,
      status: "message_taken",
      message:
        "The message is saved. Tell the caller the team will call them back. Do not promise a specific time.",
    });
  }));

  app.post(
    "/api/retell/webhook",
    asyncRoute(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : String(req.body || "");
      const verification = verifyWebhook(req, config, rawBody);
      if (!verification.ok) {
        return res.status(401).json({ error: "invalid_signature" });
      }
      const body = parseJson(rawBody);
      if (!body.ok) return res.status(400).json({ error: "invalid_json" });
      const payload = body.value;
      const event = cleanString(payload.event, 80);
      const call = sanitizeCall(payload.call || {});
      if (!call.call_id) {
        return res.status(400).json({ error: "missing_call_id" });
      }
      if (
        !["call_started", "call_ended", "call_analyzed"].includes(event)
      ) {
        return res.json({ ok: true, ignored: true });
      }
      const eventKey = `${event}:${call.call_id}`;
      if (await store.isEventProcessed(eventKey)) {
        return res.json({ ok: true, duplicate: true });
      }
      const analysis =
        payload.call_analysis ||
        payload.call?.call_analysis ||
        call.call_analysis ||
        null;
      await notificationService.processWebhookEvent({
        event,
        call,
        analysis,
      });
      await store.markEventProcessed(eventKey);
      return res.json({ ok: true });
    }),
  );

  app.post(
    "/api/web-call",
    createRateLimiter(config.webCallRateLimit),
    asyncRoute(async (req, res) => {
      if (!config.retellAgentId || !config.retellApiKey) {
        return res.status(503).json({
          error: "agent_not_configured",
          message: "The voice agent is not provisioned yet.",
        });
      }
      const name = cleanString(req.body?.name, config.maxWebCallNameLength);
      const data = await retellRequest(
        config,
        "POST",
        "/v3/create-web-call",
        {
          agent_id: config.retellAgentId,
          metadata: { source: "browser_demo", requested_name: name || null },
          retell_llm_dynamic_variables: {
            caller_name: name || "there",
            current_date: new Date().toISOString().slice(0, 10),
          },
        },
        { timeoutMs: 15000 },
      );
      return res.json({
        call_id: data.call_id,
        access_token: data.access_token,
        transport: data.transport,
        ice_servers: data.ice_servers,
        url: data.url,
        sample_rate: data.sample_rate,
      });
    }),
  );

  app.all(
    "/api/retell-proxy/*",
    asyncRoute(async (req, res) => {
      const upstreamPath = req.originalUrl.slice("/api/retell-proxy".length);
      if (!/^\/webrtc-proxy\/[^/?]+\//.test(upstreamPath)) {
        return res.status(400).json({ error: "unsupported_proxy_path" });
      }
      const headers = {};
      for (const key of [
        "authorization",
        "content-type",
        "accept",
        "x-retell-client-js-sdk-version",
      ]) {
        if (req.headers[key]) headers[key] = req.headers[key];
      }
      const response = await fetch(
        `https://api.retellai.com${upstreamPath}`,
        {
          method: req.method,
          headers,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : req.body,
          signal: AbortSignal.timeout(30000),
        },
      );
      const payload = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      return res.status(response.status).send(payload);
    }),
  );

  app.use(
    express.static(publicDir, {
      dotfiles: "deny",
      etag: true,
      maxAge: "1h",
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  app.get("/", (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.status(404).send("Not found");
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    logger.error("Request failed", error);
    if (req.path.startsWith("/api/")) {
      return res.status(500).json({ error: "internal_error" });
    }
    return res.status(500).send("Internal server error");
  });

  return app;
}
