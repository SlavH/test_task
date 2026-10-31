import express from "express";
import { loadConfig } from "./config.mjs";
import { createPool } from "./db.mjs";
import { Store } from "./store.mjs";
import { createApp } from "./httpApp.mjs";
import { EventBus, NotificationService } from "./notifications.mjs";

void express;

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

async function registerTelegramWebhook(config) {
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
    if (!data?.ok) {
      console.warn(`Telegram webhook registration failed: ${data?.description || "unknown"}`);
    }
  } catch {
    // ignore
  }
}

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = createServerApp().then(async (app) => {
      try {
        const { loadConfig } = await import("./config.mjs");
        const cfg = loadConfig();
        await registerTelegramWebhook(cfg);
      } catch {
        // ignore
      }
      return app;
    });
  }
  const app = await appPromise;
  return app(req, res);
}
