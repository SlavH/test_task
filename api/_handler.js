import { loadConfig } from "../src/config.mjs";
import { createPool } from "../src/db.mjs";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/httpApp.mjs";
import { EventBus, NotificationService } from "../src/notifications.mjs";

let appPromise;

export async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
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
    })();
  }
  return appPromise;
}

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};
