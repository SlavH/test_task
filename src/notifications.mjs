import {
  buildNotification,
  mergeNotification,
} from "./domain.mjs";
import { editTelegram, sendTelegram } from "./telegram.mjs";

export class EventBus {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(": ping\n\n");
        } catch {
          this.clients.delete(client);
        }
      }
    }, 20000);
    this.heartbeat.unref?.();
  }

  add(response) {
    this.clients.add(response);
    response.write("retry: 3000\n\n");
  }

  remove(response) {
    this.clients.delete(response);
  }

  broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

export class NotificationService {
  constructor({ store, config, eventBus, logger = console }) {
    this.store = store;
    this.config = config;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async finalizeCall(call) {
    if (!call?.call_id) return null;
    const existingCall = this.store.getCall(call.call_id) || {};
    const mergedCall = {
      ...existingCall,
      ...call,
      call_analysis:
        call.call_analysis || existingCall.call_analysis || null,
    };
    await this.store.upsertCall(mergedCall);

    const booking = this.store.getBooking(call.call_id);
    const message = this.store.getMessage(call.call_id);
    const records = mergedCall.tool_records || [];
    const incoming = buildNotification({
      call: mergedCall,
      records,
      booking,
      message,
    });
    const existing = this.store.getNotification(call.call_id);
    const notification = mergeNotification(existing, incoming);
    await this.store.saveNotification(notification);
    this.eventBus.broadcast("notification", notification);

    await this.deliverTelegram(notification, Boolean(existing));
    return this.store.getNotification(call.call_id);
  }

  async deliverTelegram(notification, hadExisting) {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      notification.telegramStatus = "skipped";
      await this.store.saveNotification(notification);
      return;
    }

    let result;
    if (hadExisting && notification.telegramMessageId) {
      result = await editTelegram(notification, this.config);
      notification.telegramStatus = result.ok ? "sent" : "edit_failed";
    } else {
      result = await sendTelegram(notification, this.config);
      if (result.ok) {
        notification.telegramStatus = "sent";
        notification.telegramMessageId = result.result?.message_id || null;
      } else {
        notification.telegramStatus = "failed";
      }
    }
    await this.store.saveNotification(notification);
    this.eventBus.broadcast("notification", notification);
    if (!result.ok && !result.skipped) {
      this.logger.error(
        `Telegram delivery failed for ${notification.call_id}: ${result.reason}`,
      );
    }
  }

  async processWebhookEvent({ event, call, analysis }) {
    if (!call?.call_id) return null;
    const existing = this.store.getCall(call.call_id) || {};
    const merged = {
      ...existing,
      ...call,
      call_analysis:
        analysis || call.call_analysis || existing.call_analysis || null,
      webhook_last_event: event,
    };
    await this.store.upsertCall(merged);
    if (event === "call_started") return null;
    return this.finalizeCall(merged);
  }

  async reconcile() {
    if (!this.config.finalizeOrphans) return;
    const calls = this.store.listCalls();
    for (const call of calls) {
      if (
        call.end_timestamp &&
        !this.store.getNotification(call.call_id) &&
        call.webhook_last_event !== "call_started"
      ) {
        await this.finalizeCall(call);
      }
    }
  }
}
