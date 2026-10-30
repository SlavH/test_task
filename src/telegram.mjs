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

async function telegramCall(config, method, body) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }
  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

export async function sendTelegram(notification, config, { attempt = 0 } = {}) {
  const text = formatTelegram(notification, {
    publicBaseUrl: config.publicBaseUrl,
  });
  const result = await telegramCall(config, "sendMessage", {
    chat_id: config.telegramChatId,
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
  });
  if (!result.ok && !result.skipped && attempt < 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return sendTelegram(notification, config, { attempt: attempt + 1 });
  }
  return result;
}

export async function editTelegram(notification, config) {
  if (!notification.telegramMessageId) return { ok: false, reason: "no_message" };
  const text = formatTelegram(notification, {
    publicBaseUrl: config.publicBaseUrl,
  });
  const result = await telegramCall(config, "editMessageText", {
    chat_id: config.telegramChatId,
    message_id: notification.telegramMessageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  if (!result.ok && /not modified/i.test(result.reason || "")) {
    return { ok: true, unchanged: true };
  }
  return result;
}
