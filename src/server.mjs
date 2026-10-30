import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { EventBus, NotificationService } from "./notifications.mjs";
import { Store } from "./store.mjs";

const config = loadConfig();
const store = await new Store({ dataDir: config.dataDir }).init();
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

const server = app.listen(config.port, () => {
  console.log(`FixCall inbox listening on ${config.publicBaseUrl}`);
  console.log(`Health check: ${config.publicBaseUrl}/healthz`);
  if (!config.retellAgentId) {
    console.warn("RETELL_AGENT_ID is not set; browser calls are disabled.");
  }
  if (config.finalizeOrphans) {
    notificationService
      .reconcile()
      .catch((error) => console.error("Reconcile failed", error));
  }
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  eventBus.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
