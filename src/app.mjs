import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
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

function constantEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function basicAuth(config) {
  return (req, res, next) => {
    if (!config.dashboardPassword) return next();
    if (
      req.path === "/healthz" ||
      req.path.startsWith("/api/retell/") ||
      req.path === "/favicon.ico" ||
      req.path === "/favicon.svg"
    ) {
      return next();
    }
    const header = req.headers.authorization || "";
    const match = /^Basic\s+(.+)$/i.exec(header);
    if (match) {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      if (
        constantEqual(user, config.dashboardUser) &&
        constantEqual(password, config.dashboardPassword)
      ) {
        return next();
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="FixCall Inbox"');
    return res.status(401).send("Authentication required");
  };
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
  app.use(basicAuth(config));

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
      const all = store.listNotifications();
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
      const notification = store.getNotification(req.params.callId);
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

    const existingCall = store.getCall(callId) || {};
    const callSnapshot = {
      ...existingCall,
      ...call,
      call_id: callId,
      tool_records: existingCall.tool_records || [],
    };
    await store.upsertCall(callSnapshot);

    const existingBooking = store.getBooking(callId);
    const existingMessage = store.getMessage(callId);
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
      if (store.isEventProcessed(eventKey)) {
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
