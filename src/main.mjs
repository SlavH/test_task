import { createApp } from "./httpApp.mjs";
import { loadConfig } from "./config.mjs";
import { createPool, closePool } from "./db.mjs";
import { EventBus, NotificationService } from "./notifications.mjs";
import { Store } from "./store.mjs";

const config = loadConfig();
const pool = createPool(config);
const store = await new Store({ pool }).init();
const eventBus = new EventBus();
const notificationService = new NotificationService({
  store,
  config,
  eventBus,
});

const app = createApp({
  config,
  store,
  notificationService,
  eventBus,
});

async function registerTelegramWebhook() {
  try {
    if (!config.telegramBotToken) return;
    if (!config.publicBaseUrl || !config.publicBaseUrl.startsWith("https://")) return;
    const url = `${config.publicBaseUrl.replace(/\/+$/, "")}/api/telegram/webhook`;
    const body = { url };
    if (config.telegramWebhookSecret) {
      body.secret_token = config.telegramWebhookSecret;
    }
    const response = await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await response.json().catch(() => null);
    if (data?.ok) {
      console.log("Telegram webhook registered");
    } else if (data) {
      console.warn(`Telegram webhook registration failed: ${data.description || "unknown"}`);
    }
  } catch (error) {
    console.warn("Telegram webhook registration error:", error.message);
  }
}

const server = app.listen(config.port, () => {
  console.log(`FixCall inbox listening on ${config.publicBaseUrl}`);
  console.log(`Health check: ${config.publicBaseUrl}/healthz`);
  if (!config.retellAgentId) {
    console.warn("RETELL_AGENT_ID is not set; browser calls are disabled.");
  }
  if (!config.databaseUrl) {
    console.warn("DATABASE_URL is not set.");
  }
  if (config.finalizeOrphans) {
    notificationService
      .reconcile()
      .catch((error) => console.error("Reconcile failed", error));
  }
  registerTelegramWebhook();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  eventBus.close();
  server.close(() => {
    closePool(pool).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
