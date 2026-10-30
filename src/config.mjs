import "dotenv/config";
import path from "node:path";

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const port = number(env.PORT, 3000);
  const publicBaseUrl = String(
    env.PUBLIC_BASE_URL ||
      env.RENDER_EXTERNAL_URL ||
      `http://localhost:${port}`,
  ).replace(/\/+$/, "");

  return {
    port,
    publicBaseUrl,
    databaseUrl: env.DATABASE_URL || "",
    companyName: env.COMPANY_NAME || "FixCall Appliance Repair",
    timezone: env.TIMEZONE || "America/Los_Angeles",
    dashboardTitle: env.DASHBOARD_TITLE || "FixCall Inbox",
    dashboardUser: env.DASHBOARD_USER || "admin",
    dashboardPassword: env.DASHBOARD_PASSWORD || "",
    adminSessionSecret:
      env.ADMIN_SESSION_SECRET ||
      env.DASHBOARD_PASSWORD ||
      "fixcall-local-session-secret",
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    retellApiKey: env.RETELL_API_KEY || "",
    retellAgentId: env.RETELL_AGENT_ID || "",
    retellPhoneNumber: env.RETELL_PHONE_NUMBER || "",
    retellApiBase: (env.RETELL_API_BASE || "https://api.retellai.com").replace(
      /\/+$/,
      "",
    ),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
    allowUnsignedRetell: bool(env.ALLOW_UNSIGNED_RETELL),
    webCallRateLimit: number(env.WEB_CALL_RATE_LIMIT, 5),
    finalizeOrphans: bool(env.FINALIZE_ORPHANS, true),
    maxWebCallNameLength: 80,
  };
}

export function safeConfigSummary(config) {
  return {
    companyName: config.companyName,
    timezone: config.timezone,
    agentConfigured: Boolean(config.retellApiKey && config.retellAgentId),
    telegramConfigured: Boolean(
      config.telegramBotToken && config.telegramChatId,
    ),
  };
}
