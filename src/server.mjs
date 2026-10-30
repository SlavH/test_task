import { loadConfig } from "./config.mjs";
import { createPool } from "./db.mjs";
import { Store } from "./store.mjs";
import { createApp } from "./httpApp.mjs";
import { EventBus, NotificationService } from "./notifications.mjs";

export const config = {
  maxDuration: 60,
};

let appPromise;

async function createServerApp() {
  const config = loadConfig();
  const pool = createPool(config);
  const store = await new Store({ pool }).init();
  const eventBus = new EventBus();
  const notificationService = new NotificationService({
    store,
    config,
    eventBus,
    logger: console,
  });
  return createApp({ config, store, notificationService, eventBus, logger: console });
}

export default async function handler(req, res) {
  if (!appPromise) appPromise = createServerApp();
  const app = await appPromise;
  return app(req, res);
}
