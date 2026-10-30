import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = () => ({
  version: 1,
  calls: {},
  notifications: {},
  bookings: {},
  messages: {},
  processedEvents: {},
  updatedAt: new Date().toISOString(),
});

export class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "state.json");
    this.state = EMPTY_STATE();
    this.writeChain = Promise.resolve();
    this.ready = false;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        ...EMPTY_STATE(),
        ...parsed,
        calls: parsed.calls || {},
        notifications: parsed.notifications || {},
        bookings: parsed.bookings || {},
        messages: parsed.messages || {},
        processedEvents: parsed.processedEvents || {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Unable to read data store: ${error.message}`);
      }
      await this.persist();
    }
    this.ready = true;
    return this;
  }

  async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, snapshot, "utf8");
      await fs.rename(tempPath, this.filePath);
    });
    return this.writeChain;
  }

  touch() {
    this.state.updatedAt = new Date().toISOString();
  }

  getCall(callId) {
    return this.state.calls[callId] || null;
  }

  async upsertCall(call) {
    if (!call?.call_id) throw new Error("Call is missing call_id");
    const existing = this.state.calls[call.call_id] || {};
    this.state.calls[call.call_id] = {
      ...existing,
      ...call,
      call_analysis: call.call_analysis || existing.call_analysis || null,
      updatedAt: new Date().toISOString(),
    };
    this.touch();
    await this.persist();
    return this.state.calls[call.call_id];
  }

  async addToolRecord(callId, record) {
    const call = this.state.calls[callId] || { call_id: callId };
    if (!call.tool_records) call.tool_records = [];
    call.tool_records.push({
      ...record,
      at: record.at || new Date().toISOString(),
    });
    call.updatedAt = new Date().toISOString();
    this.state.calls[callId] = call;
    this.touch();
    await this.persist();
    return call;
  }

  getBooking(callId) {
    return this.state.bookings[callId] || null;
  }

  async saveBooking(booking) {
    this.state.bookings[booking.call_id] = booking;
    this.touch();
    await this.persist();
    return booking;
  }

  getMessage(callId) {
    return this.state.messages[callId] || null;
  }

  async saveMessage(message) {
    this.state.messages[message.call_id] = message;
    this.touch();
    await this.persist();
    return message;
  }

  getNotification(callId) {
    return this.state.notifications[callId] || null;
  }

  async saveNotification(notification) {
    this.state.notifications[notification.call_id] = notification;
    this.touch();
    await this.persist();
    return notification;
  }

  listNotifications() {
    return Object.values(this.state.notifications).sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  listCalls() {
    return Object.values(this.state.calls);
  }

  isEventProcessed(key) {
    return Boolean(this.state.processedEvents[key]);
  }

  async markEventProcessed(key) {
    this.state.processedEvents[key] = new Date().toISOString();
    this.touch();
    await this.persist();
  }
}

export function statsForNotifications(notifications) {
  const counts = {
    all: notifications.length,
    standard: 0,
    warranty: 0,
    warranty_company: 0,
    spam: 0,
    other: 0,
    booked: 0,
  };
  for (const item of notifications) {
    if (counts[item.type] !== undefined) counts[item.type] += 1;
    if (item.status === "booked") counts.booked += 1;
  }
  return counts;
}
