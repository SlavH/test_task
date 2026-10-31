import { runMigrations } from "./db.mjs";

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export class Store {
  constructor({ pool }) {
    this.pool = pool;
    this.ready = false;
  }

  async init() {
    await runMigrations(this.pool);
    await this.pool.query(`
      INSERT INTO persona_config (id, warmth, task_focus, business_facts, prompt_additions)
      VALUES (1, 'warm', 'task_focused', '{}'::jsonb, '')
      ON CONFLICT (id) DO NOTHING
    `);
    this.ready = true;
    return this;
  }

  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCall(callId) {
    const result = await this.pool.query(
      "SELECT payload FROM calls WHERE call_id = $1",
      [callId],
    );
    return result.rows[0]?.payload || null;
  }

  async upsertCall(call) {
    if (!call?.call_id) throw new Error("Call is missing call_id");
    const existing = await this.getCall(call.call_id);
    const merged = {
      ...(existing || {}),
      ...call,
      call_analysis: call.call_analysis || existing?.call_analysis || null,
      updatedAt: new Date().toISOString(),
    };
    const createdAt = existing?.createdAt || new Date().toISOString();
    await this.pool.query(
      `INSERT INTO calls (
        call_id, agent_id, call_type, call_status, from_number, to_number,
        start_timestamp, end_timestamp, duration_ms, transcript, transcript_json,
        recording_url, disconnection_reason, call_analysis, webhook_last_event,
        metadata, source, payload, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18::jsonb,$19,$20
      )
      ON CONFLICT (call_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        call_type = EXCLUDED.call_type,
        call_status = EXCLUDED.call_status,
        from_number = EXCLUDED.from_number,
        to_number = EXCLUDED.to_number,
        start_timestamp = EXCLUDED.start_timestamp,
        end_timestamp = EXCLUDED.end_timestamp,
        duration_ms = EXCLUDED.duration_ms,
        transcript = EXCLUDED.transcript,
        transcript_json = EXCLUDED.transcript_json,
        recording_url = EXCLUDED.recording_url,
        disconnection_reason = EXCLUDED.disconnection_reason,
        call_analysis = EXCLUDED.call_analysis,
        webhook_last_event = EXCLUDED.webhook_last_event,
        metadata = EXCLUDED.metadata,
        source = EXCLUDED.source,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at`,
      [
        merged.call_id,
        merged.agent_id || null,
        merged.call_type || null,
        merged.call_status || null,
        merged.from_number || null,
        merged.to_number || null,
        merged.start_timestamp || null,
        merged.end_timestamp || null,
        merged.durationMs || merged.duration_ms || null,
        merged.transcript || null,
        json(merged.transcript_object || merged.transcript_with_tool_calls || null),
        merged.recording_url || null,
        merged.disconnection_reason || null,
        json(merged.call_analysis || null),
        merged.webhook_last_event || null,
        json(merged.metadata || null),
        merged.source || null,
        json(merged),
        createdAt,
        merged.updatedAt,
      ],
    );
    return merged;
  }

  async addToolRecord(callId, record) {
    const call = (await this.getCall(callId)) || { call_id: callId };
    if (!Array.isArray(call.tool_records)) call.tool_records = [];
    call.tool_records.push({
      ...record,
      at: record.at || new Date().toISOString(),
    });
    call.updatedAt = new Date().toISOString();
    await this.upsertCall(call);
    return call;
  }

  async getBooking(callId) {
    const result = await this.pool.query(
      "SELECT payload FROM bookings WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1",
      [callId],
    );
    return result.rows[0]?.payload || null;
  }

  async getBookingById(bookingId) {
    const result = await this.pool.query(
      "SELECT payload FROM bookings WHERE booking_id = $1",
      [bookingId],
    );
    return result.rows[0]?.payload || null;
  }

  async saveBooking(booking) {
    await this.pool.query(
      `INSERT INTO bookings (
        booking_id, call_id, customer_name, phone_number, service_address,
        appliance_type, appliance_brand, issue_description, is_warranty,
        fee_accepted, status, payload, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13
      )
      ON CONFLICT (booking_id) DO UPDATE SET
        call_id = EXCLUDED.call_id,
        customer_name = EXCLUDED.customer_name,
        phone_number = EXCLUDED.phone_number,
        service_address = EXCLUDED.service_address,
        appliance_type = EXCLUDED.appliance_type,
        appliance_brand = EXCLUDED.appliance_brand,
        issue_description = EXCLUDED.issue_description,
        is_warranty = EXCLUDED.is_warranty,
        fee_accepted = EXCLUDED.fee_accepted,
        status = EXCLUDED.status,
        payload = EXCLUDED.payload`,
      [
        booking.booking_id,
        booking.call_id,
        booking.customer_name,
        booking.phone_number,
        booking.service_address,
        booking.appliance_type,
        booking.appliance_brand,
        booking.issue_description,
        Boolean(booking.is_warranty),
        Boolean(booking.fee_accepted),
        booking.status || "booked",
        json(booking),
        booking.created_at || new Date().toISOString(),
      ],
    );
    return booking;
  }

  async getMessage(callId) {
    const result = await this.pool.query(
      "SELECT payload FROM messages WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1",
      [callId],
    );
    return result.rows[0]?.payload || null;
  }

  async saveMessage(message) {
    await this.pool.query(
      `INSERT INTO messages (
        message_id, call_id, kind, caller_name, company, callback_number,
        job_details, reason, status, payload, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11
      )
      ON CONFLICT (message_id) DO UPDATE SET
        call_id = EXCLUDED.call_id,
        kind = EXCLUDED.kind,
        caller_name = EXCLUDED.caller_name,
        company = EXCLUDED.company,
        callback_number = EXCLUDED.callback_number,
        job_details = EXCLUDED.job_details,
        reason = EXCLUDED.reason,
        status = EXCLUDED.status,
        payload = EXCLUDED.payload`,
      [
        message.message_id,
        message.call_id,
        message.kind,
        message.caller_name,
        message.company || null,
        message.callback_number,
        message.job_details || null,
        message.reason || null,
        message.status || "message_taken",
        json(message),
        message.created_at || new Date().toISOString(),
      ],
    );
    return message;
  }

  async getNotification(callId) {
    const result = await this.pool.query(
      "SELECT payload FROM notifications WHERE call_id = $1",
      [callId],
    );
    return result.rows[0]?.payload || null;
  }

  async saveNotification(notification) {
    await this.pool.query(
      `INSERT INTO notifications (
        call_id, type, status, caller_name, callback_number, from_number,
        company, appliance, brand, issue, job_details, reason, service_address,
        fee_quoted, fee_accepted, booking_id, message_id, summary,
        analysis_summary, sentiment, call_successful, transcript, transcript_text,
        recording_url, disconnection_reason, duration_ms, started_at, ended_at,
        source, payload, created_at, updated_at, telegram_status, telegram_message_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31,$32,$33,$34
      )
      ON CONFLICT (call_id) DO UPDATE SET
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        caller_name = EXCLUDED.caller_name,
        callback_number = EXCLUDED.callback_number,
        from_number = EXCLUDED.from_number,
        company = EXCLUDED.company,
        appliance = EXCLUDED.appliance,
        brand = EXCLUDED.brand,
        issue = EXCLUDED.issue,
        job_details = EXCLUDED.job_details,
        reason = EXCLUDED.reason,
        service_address = EXCLUDED.service_address,
        fee_quoted = EXCLUDED.fee_quoted,
        fee_accepted = EXCLUDED.fee_accepted,
        booking_id = EXCLUDED.booking_id,
        message_id = EXCLUDED.message_id,
        summary = EXCLUDED.summary,
        analysis_summary = EXCLUDED.analysis_summary,
        sentiment = EXCLUDED.sentiment,
        call_successful = EXCLUDED.call_successful,
        transcript = EXCLUDED.transcript,
        transcript_text = EXCLUDED.transcript_text,
        recording_url = EXCLUDED.recording_url,
        disconnection_reason = EXCLUDED.disconnection_reason,
        duration_ms = EXCLUDED.duration_ms,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        source = EXCLUDED.source,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at,
        telegram_status = EXCLUDED.telegram_status,
        telegram_message_id = EXCLUDED.telegram_message_id`,
      [
        notification.call_id,
        notification.type,
        notification.status,
        notification.callerName,
        notification.callbackNumber,
        notification.fromNumber || null,
        notification.company || null,
        notification.appliance || null,
        notification.brand || null,
        notification.issue || null,
        notification.jobDetails || null,
        notification.reason || null,
        notification.serviceAddress || null,
        Boolean(notification.feeQuoted),
        notification.feeAccepted ?? null,
        notification.bookingId || null,
        notification.messageId || null,
        notification.summary,
        notification.analysisSummary || null,
        notification.sentiment || null,
        notification.callSuccessful ?? null,
        json(notification.transcript || []),
        notification.transcriptText || "",
        notification.recordingUrl || null,
        notification.disconnectionReason || null,
        Number(notification.durationMs || 0),
        notification.startedAt,
        notification.endedAt,
        notification.source || "phone",
        json(notification),
        notification.createdAt || new Date().toISOString(),
        notification.updatedAt || new Date().toISOString(),
        notification.telegramStatus || "pending",
        notification.telegramMessageId || null,
      ],
    );
    return notification;
  }

  async listNotifications() {
    const result = await this.pool.query(
      "SELECT payload FROM notifications ORDER BY created_at DESC",
    );
    return result.rows.map((row) => row.payload);
  }

  async listCalls() {
    const result = await this.pool.query(
      "SELECT payload FROM calls ORDER BY created_at DESC",
    );
    return result.rows.map((row) => row.payload);
  }

  async isEventProcessed(key) {
    const result = await this.pool.query(
      "SELECT 1 FROM processed_events WHERE event_key = $1",
      [key],
    );
    return Boolean(result.rowCount);
  }

  async markEventProcessed(key) {
    await this.pool.query(
      `INSERT INTO processed_events (event_key, processed_at)
       VALUES ($1, NOW())
       ON CONFLICT (event_key) DO NOTHING`,
      [key],
    );
  }

  async getPersonaConfig() {
    const result = await this.pool.query(
      "SELECT warmth, task_focus, business_facts, prompt_additions, updated_at, applied_agent_version, applied_at FROM persona_config WHERE id = 1",
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      warmth: row.warmth,
      taskFocus: row.task_focus,
      businessFacts: parse(row.business_facts) || {},
      promptAdditions: row.prompt_additions || "",
      updatedAt: row.updated_at,
      appliedAgentVersion: row.applied_agent_version,
      appliedAt: row.applied_at,
    };
  }

  async savePersonaConfig(config) {
    await this.pool.query(
      `INSERT INTO persona_config (id, warmth, task_focus, business_facts, prompt_additions, updated_at)
       VALUES (1, $1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         warmth = EXCLUDED.warmth,
         task_focus = EXCLUDED.task_focus,
         business_facts = EXCLUDED.business_facts,
         prompt_additions = EXCLUDED.prompt_additions,
         updated_at = EXCLUDED.updated_at`,
      [
        config.warmth,
        config.taskFocus,
        json(config.businessFacts || {}),
        config.promptAdditions || "",
      ],
    );
    return this.getPersonaConfig();
  }

  async markPersonaApplied(agentVersion) {
    await this.pool.query(
      `UPDATE persona_config
       SET applied_agent_version = $1, applied_at = NOW(), updated_at = NOW()
       WHERE id = 1`,
      [agentVersion],
    );
  }

  async addCallNote(callId, note, author = "admin") {
    const result = await this.pool.query(
      `INSERT INTO call_notes (call_id, note, author)
       VALUES ($1, $2, $3)
       RETURNING id, call_id, note, author, created_at`,
      [callId, note, author],
    );
    return result.rows[0];
  }

  async listCallNotes(callId) {
    const result = await this.pool.query(
      "SELECT id, call_id, note, author, created_at FROM call_notes WHERE call_id = $1 ORDER BY created_at DESC",
      [callId],
    );
    return result.rows;
  }

  async addCallTag(callId, tag) {
    await this.pool.query(
      `INSERT INTO call_tags (call_id, tag)
       VALUES ($1, $2)
       ON CONFLICT (call_id, tag) DO NOTHING`,
      [callId, tag],
    );
    return this.listCallTags(callId);
  }

  async removeCallTag(callId, tag) {
    await this.pool.query(
      "DELETE FROM call_tags WHERE call_id = $1 AND tag = $2",
      [callId, tag],
    );
    return this.listCallTags(callId);
  }

  async listCallTags(callId) {
    const result = await this.pool.query(
      "SELECT tag FROM call_tags WHERE call_id = $1 ORDER BY tag",
      [callId],
    );
    return result.rows.map((row) => row.tag);
  }

  async addAudit(action, details = {}) {
    await this.pool.query(
      "INSERT INTO admin_audit (action, details) VALUES ($1, $2::jsonb)",
      [action, json(details)],
    );
  }

  async listActiveTelegramSubscribers() {
    const result = await this.pool.query(
      "SELECT chat_id, username, first_name, last_name FROM telegram_subscribers WHERE active = TRUE ORDER BY subscribed_at ASC",
    );
    return result.rows.map((row) => ({
      chatId: row.chat_id,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
    }));
  }

  async upsertTelegramSubscriber({ chatId, username, firstName, lastName }) {
    if (!chatId) return null;
    await this.pool.query(
      `INSERT INTO telegram_subscribers (chat_id, username, first_name, last_name, active, subscribed_at, unsubscribed_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), NULL, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         active = TRUE,
         unsubscribed_at = NULL,
         updated_at = NOW()`,
      [String(chatId), username || null, firstName || null, lastName || null],
    );
    return { chatId: String(chatId) };
  }

  async deactivateTelegramSubscriber(chatId) {
    if (!chatId) return null;
    await this.pool.query(
      `UPDATE telegram_subscribers
       SET active = FALSE, unsubscribed_at = NOW(), updated_at = NOW()
       WHERE chat_id = $1`,
      [String(chatId)],
    );
    return { chatId: String(chatId) };
  }

  async markTelegramSubscriberInactive(chatId) {
    if (!chatId) return null;
    await this.pool.query(
      `UPDATE telegram_subscribers
       SET active = FALSE, unsubscribed_at = COALESCE(unsubscribed_at, NOW()), updated_at = NOW()
       WHERE chat_id = $1 AND active = TRUE`,
      [String(chatId)],
    );
    return { chatId: String(chatId) };
  }

  async exportData() {
    const [calls, bookings, messages, notifications, notes, tags, persona] =
      await Promise.all([
        this.listCalls(),
        this.pool.query("SELECT payload FROM bookings").then((r) => r.rows.map((x) => x.payload)),
        this.pool.query("SELECT payload FROM messages").then((r) => r.rows.map((x) => x.payload)),
        this.listNotifications(),
        this.pool.query("SELECT * FROM call_notes ORDER BY created_at").then((r) => r.rows),
        this.pool.query("SELECT * FROM call_tags ORDER BY created_at").then((r) => r.rows),
        this.getPersonaConfig(),
      ]);
    return { calls, bookings, messages, notifications, notes, tags, persona };
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
