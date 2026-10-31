import { STATUS_LABELS, TYPE_LABELS } from "./domain.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function line(label, value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return `<b>${escapeHtml(label)}:</b> ${escapeHtml(text)}`;
}

function durationLabel(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function formatTelegram(notification, { publicBaseUrl } = {}) {
  const type = TYPE_LABELS[notification.type] || "Call";
  const status = STATUS_LABELS[notification.status] || notification.status;
  const lines = [
    `<b>[${escapeHtml(type)}] ${escapeHtml(notification.callerName)}</b>`,
    line("Status", status),
    line("Callback", notification.callbackNumber),
  ];

  if (notification.company) lines.push(line("Company", notification.company));
  if (notification.brand || notification.appliance) {
    lines.push(
      line(
        "Appliance",
        [notification.brand, notification.appliance].filter(Boolean).join(" "),
      ),
    );
  }
  if (notification.issue) lines.push(line("Issue", notification.issue));
  if (notification.jobDetails) {
    lines.push(line("Job", notification.jobDetails));
  }
  if (notification.reason) lines.push(line("Reason", notification.reason));
  if (notification.serviceAddress) {
    lines.push(line("Address", notification.serviceAddress));
  }
  if (notification.bookingId) {
    lines.push(line("Booking", notification.bookingId));
  } else if (notification.type === "standard") {
    lines.push(
      line(
        "Fee",
        notification.feeAccepted === true
          ? "$99 accepted"
          : notification.feeAccepted === false
            ? "$99 declined"
            : "Not confirmed",
      ),
    );
  } else if (notification.type === "warranty") {
    lines.push(line("Fee", "Waived - covered warranty brand"));
  }

  lines.push(line("Call", `${durationLabel(notification.durationMs)} · ${notification.source}`));
  if (notification.analysisSummary) {
    lines.push(`<i>${escapeHtml(notification.analysisSummary.slice(0, 600))}</i>`);
  }
  if (publicBaseUrl && notification.call_id) {
    lines.push(
      `<a href="${escapeHtml(`${publicBaseUrl}/?call=${encodeURIComponent(notification.call_id)}`)}">Open call details</a>`,
    );
  }
  return lines.filter(Boolean).join("\n").slice(0, 4000);
}

function getChatIds(config) {
  if (Array.isArray(config.telegramChatIds) && config.telegramChatIds.length) {
    return config.telegramChatIds;
  }
  if (config.telegramChatId) {
    return String(config.telegramChatId)
      .split(/[\s,;]+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }
  return [];
}

async function telegramCallForChat(config, method, body, chatId) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, chat_id: chatId }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    return {
      ok: false,
      reason: data?.description || `HTTP ${response.status}`,
    };
  }
  return { ok: true, result: data.result };
}

async function telegramCall(config, method, body) {
  const chatIds = getChatIds(config);
  if (!config.telegramBotToken || chatIds.length === 0) {
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }
  const results = [];
  for (const chatId of chatIds) {
    results.push(await telegramCallForChat(config, method, body, chatId));
  }
  const success = results.find((r) => r.ok);
  return {
    ok: results.some((r) => r.ok),
    result: success?.result || null,
    results,
  };
}

export async function sendTelegram(notification, config, { attempt = 0 } = {}) {
  const chatIds = getChatIds(config);
  if (!config.telegramBotToken || chatIds.length === 0) {
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }
  const text = formatTelegram(notification, {
    publicBaseUrl: config.publicBaseUrl,
  });
  const body = {
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: config.publicBaseUrl
      ? {
          inline_keyboard: [
            [
              {
                text: "Open call details",
                url: `${config.publicBaseUrl}/?call=${encodeURIComponent(notification.call_id)}`,
              },
            ],
          ],
        }
      : undefined,
  };
  const results = [];
  for (const chatId of chatIds) {
    results.push(await telegramCallForChat(config, "sendMessage", body, chatId));
  }
  const success = results.find((r) => r.ok);
  if (success?.result?.message_id && !notification.telegramMessageId) {
    notification.telegramMessageId = success.result.message_id;
  }
  const result = {
    ok: results.some((r) => r.ok),
    result: success?.result || null,
    results,
  };
  if (!result.ok && attempt < 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return sendTelegram(notification, config, { attempt: attempt + 1 });
  }
  return result;
}

export async function editTelegram(notification, config) {
  if (!notification.telegramMessageId) return { ok: false, reason: "no_message" };
  const chatIds = getChatIds(config);
  if (!config.telegramBotToken || chatIds.length === 0) {
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }
  const text = formatTelegram(notification, {
    publicBaseUrl: config.publicBaseUrl,
  });
  const body = {
    message_id: notification.telegramMessageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const results = [];
  for (const chatId of chatIds) {
    const res = await telegramCallForChat(config, "editMessageText", body, chatId);
    if (!res.ok && /not modified/i.test(res.reason || "")) {
      results.push({ ok: true, unchanged: true, chatId });
      continue;
    }
    results.push({ ok: res.ok, chatId, reason: res.reason });
  }
  return { ok: results.some((r) => r.ok), results };
}
