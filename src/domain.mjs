import crypto from "node:crypto";
import { normalizeTranscript } from "./retell.mjs";

export const COVERED_WARRANTY_BRANDS = ["LG", "Samsung", "GE"];
export const CALL_TYPES = [
  "standard",
  "warranty",
  "warranty_company",
  "spam",
  "other",
];

const BRAND_ALIASES = {
  LG: ["lg"],
  Samsung: ["samsung"],
  GE: ["ge", "general electric", "general electrics", "ge appliances"],
};

export function cleanString(value, max = 300) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeBrand(value) {
  const brand = cleanString(value, 80);
  const lower = brand.toLowerCase();
  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    if (aliases.some((alias) => lower === alias || lower.includes(alias))) {
      return canonical;
    }
  }
  if (!brand) return "Unknown";
  return brand
    .split(" ")
    .map((part) =>
      part.length <= 3 && part === part.toUpperCase()
        ? part
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

export function isValidPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

export function detectFeeAcceptance(call) {
  const turns = normalizeTranscript(call);
  let feeIndex = -1;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== "agent") continue;
    if (
      /(\$\s*99\b|ninety[-\s]?nine\b)/i.test(turn.content) &&
      /\b(fee|service call|visit|charge|cost)\b/i.test(turn.content)
    ) {
      feeIndex = index;
    }
  }
  if (feeIndex === -1) {
    return { quoted: false, accepted: false, evidence: null };
  }
  const replies = turns
    .slice(feeIndex + 1)
    .filter((turn) => turn.role === "user");
  if (!replies.length) {
    return { quoted: true, accepted: false, evidence: null };
  }
  const last = replies[replies.length - 1].content;
  const strongNegative =
    /\b(not interested|don'?t want|do not want|won'?t|will not|can'?t afford|too much|too expensive|not paying|no thanks|no thank you)\b/i.test(
      last,
    );
  const positive =
    /\b(yes|yeah|yep|sure|okay|ok|sounds good|that works|that'?s fine|fine|go ahead|absolutely|correct|alright)\b/i.test(
      last,
    );
  const directNo = /^\s*(no|nope|nah)\b/i.test(last);
  if (strongNegative) {
    return { quoted: true, accepted: false, evidence: last };
  }
  if (positive) {
    return { quoted: true, accepted: true, evidence: last };
  }
  if (directNo) {
    return { quoted: true, accepted: false, evidence: last };
  }
  return { quoted: true, accepted: false, evidence: last };
}

export function callMentionsWarranty(call) {
  const text = normalizeTranscript(call)
    .map((turn) => turn.content)
    .join(" ");
  return /\bwarrant(y|ies)\b/i.test(text);
}

export function callMentionsBrand(call, brand) {
  const b = normalizeBrand(brand);
  const aliases = BRAND_ALIASES[b];
  if (!aliases) {
    const needle = b.toLowerCase();
    return needle
      ? normalizeTranscript(call)
          .map((turn) => turn.content.toLowerCase())
          .join(" ")
          .includes(needle)
      : false;
  }
  const text = normalizeTranscript(call)
    .map((turn) => turn.content.toLowerCase())
    .join(" ");
  return aliases.some((alias) =>
    new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
      text,
    ),
  );
}

function failure(code, message) {
  return { ok: false, code, message };
}

function newBookingId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `FC-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export function validateBooking(call, args = {}) {
  const customerName = cleanString(args.customer_name, 120);
  const phoneNumber = cleanString(args.phone_number, 40);
  const serviceAddress = cleanString(args.service_address, 240);
  const applianceType = cleanString(args.appliance_type, 80);
  const brand = normalizeBrand(args.appliance_brand);
  const issueDescription = cleanString(args.issue_description, 500);
  const isWarranty = args.is_warranty === true || args.is_warranty === "true";
  const feeAcceptedArg =
    args.fee_accepted === true || args.fee_accepted === "true";

  if (customerName.length < 2) {
    return failure(
      "missing_name",
      "I still need the caller's name before I can submit this. Ask for their full name, then try again.",
    );
  }
  if (!isValidPhone(phoneNumber)) {
    return failure(
      "invalid_phone",
      "I don't have a usable callback number yet. Ask the caller to repeat the best number to reach them, then try again.",
    );
  }
  if (serviceAddress.length < 5) {
    return failure(
      "missing_address",
      "I still need the full service address before I can submit this. Ask for it, then try again.",
    );
  }
  if (applianceType.length < 2) {
    return failure(
      "missing_appliance",
      "I still need to know what appliance this is for. Ask, then try again.",
    );
  }
  if (issueDescription.length < 3) {
    return failure(
      "missing_issue",
      "I still need a short description of the problem. Ask what the appliance is doing, then try again.",
    );
  }

  if (isWarranty) {
    const covered = COVERED_WARRANTY_BRANDS.includes(brand);
    if (!covered) {
      return failure(
        "warranty_brand_not_covered",
        "That brand is not covered for warranty work. Do not book it as a warranty job. Explain that warranty repairs are only available for LG, Samsung, and General Electric, then offer a standard service call with the $99 fee.",
      );
    }
    if (!callMentionsWarranty(call)) {
      return failure(
        "warranty_not_discussed",
        "The caller has not actually said the appliance is under warranty. Do not book it as a warranty job. If they did not mention a warranty, continue as a standard service call and confirm the $99 fee first.",
      );
    }
    if (!callMentionsBrand(call, brand)) {
      return failure(
        "brand_not_confirmed",
        "The brand was not clear in the conversation. Confirm it is LG, Samsung, or General Electric before booking a warranty job.",
      );
    }
  } else {
    const feeCheck = detectFeeAcceptance(call);
    if (!feeAcceptedArg || !feeCheck.accepted) {
      return failure(
        "fee_not_accepted",
        feeCheck.quoted
          ? "The caller's agreement to the $99 service call fee is not clear yet. Do not book. Ask a direct question such as 'So the $99 service call fee is okay?' and wait for a clear yes, then try again."
          : "Do not book yet. Tell the caller there is a $99 service call fee and ask if that works for them. Wait for a clear yes, then try again.",
      );
    }
  }

  return {
    ok: true,
    booking: {
      booking_id: newBookingId(),
      call_id: call.call_id,
      customer_name: customerName,
      phone_number: phoneNumber,
      service_address: serviceAddress,
      appliance_type: applianceType,
      appliance_brand: brand,
      issue_description: issueDescription,
      is_warranty: isWarranty,
      fee_accepted: isWarranty ? false : true,
      status: "booked",
      created_at: new Date().toISOString(),
    },
  };
}

export function validateWarrantyMessage(call, args = {}) {
  const callerName = cleanString(args.caller_name, 120);
  const company = cleanString(args.company, 160);
  const callbackNumber = cleanString(args.callback_number, 40);
  const jobDetails = cleanString(args.job_details, 600);

  if (callerName.length < 2) {
    return failure(
      "missing_name",
      "I still need the representative's name. Ask for it, then try again.",
    );
  }
  if (company.length < 2) {
    return failure(
      "missing_company",
      "I still need the warranty company's name. Ask for it, then try again.",
    );
  }
  if (!isValidPhone(callbackNumber)) {
    return failure(
      "invalid_phone",
      "I need a usable callback number. Ask them to repeat the best number to reach them, then try again.",
    );
  }
  if (jobDetails.length < 3) {
    return failure(
      "missing_job_details",
      "I still need the job details: the appliance, brand, and what the customer reported. Ask for those, then try again.",
    );
  }

  return {
    ok: true,
    message: {
      message_id: `WM-${Date.now().toString(36).toUpperCase()}`,
      call_id: call.call_id,
      kind: "warranty_company",
      caller_name: callerName,
      company,
      callback_number: callbackNumber,
      job_details: jobDetails,
      created_at: new Date().toISOString(),
    },
  };
}

export function validateMessage(call, args = {}) {
  const callerName = cleanString(args.caller_name, 120);
  const callbackNumber = cleanString(args.callback_number, 40);
  const reason = cleanString(args.reason, 600);

  if (callerName.length < 2) {
    return failure(
      "missing_name",
      "I still need the caller's name. Ask for it, then try again.",
    );
  }
  if (!isValidPhone(callbackNumber)) {
    return failure(
      "invalid_phone",
      "I need a usable callback number. Ask the caller to repeat it, then try again.",
    );
  }
  if (reason.length < 3) {
    return failure(
      "missing_reason",
      "I still need to know what the call is about. Ask for a short reason, then try again.",
    );
  }

  return {
    ok: true,
    message: {
      message_id: `MS-${Date.now().toString(36).toUpperCase()}`,
      call_id: call.call_id,
      kind: "other",
      caller_name: callerName,
      callback_number: callbackNumber,
      reason,
      created_at: new Date().toISOString(),
    },
  };
}

function normalizeType(value) {
  const map = {
    standard_customer: "standard",
    warranty_customer: "warranty",
    warranty_company: "warranty_company",
    spam: "spam",
    other: "other",
    standard: "standard",
    warranty: "warranty",
  };
  return map[String(value || "").toLowerCase()] || null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function ensureSentence(value) {
  const text = cleanString(value, 500);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function deterministicSummary(notification) {
  if (notification.type === "spam") {
    return "Sales or robocall. No service request was taken.";
  }
  if (notification.type === "warranty_company") {
    return `${notification.callerName} from ${
      notification.company || "a warranty company"
    } called about ${ensureSentence(
      notification.jobDetails || "a warranty job",
    )} Message taken for a callback at ${
      notification.callbackNumber || "the number on file"
    }.`;
  }
  if (notification.type === "other") {
    return `${notification.callerName} called with a message: ${ensureSentence(
      notification.reason || "no details captured",
    )} Callback at ${notification.callbackNumber || "the number on file"}.`;
  }
  if (notification.type === "standard" || notification.type === "warranty") {
    const appliance = [notification.brand, notification.appliance]
      .filter((value) => value && value !== "Unknown")
      .join(" ")
      .trim();
    const subject = appliance
      ? `a ${appliance}${
          notification.issue
            ? `. Reported issue: ${ensureSentence(notification.issue)}`
            : "."
        }`
      : notification.issue
        ? ensureSentence(notification.issue)
        : "an appliance problem.";
    if (notification.status === "booked") {
      return `${notification.callerName} reported ${subject} Service call booked${
        notification.type === "warranty"
          ? " as a covered warranty job."
          : notification.feeAccepted
            ? " with the $99 fee accepted."
            : "."
      }`;
    }
    if (notification.feeAccepted === false) {
      return `${notification.callerName} reported ${subject} No service call was booked because the $99 fee was not accepted.`;
    }
    return `${notification.callerName} reported ${subject} No service call was booked.`;
  }
  return "Call ended without a clear service request. Review the transcript for details.";
}

export function buildNotification({
  call,
  records = [],
  booking = null,
  message = null,
  now = new Date(),
}) {
  const analysis = call.call_analysis || {};
  const custom = analysis.custom_analysis_data || {};
  const lastRecord = records[records.length - 1] || null;
  const recordPayload = lastRecord?.record || {};

  let type = null;
  if (booking) type = booking.is_warranty ? "warranty" : "standard";
  else if (message?.kind === "warranty_company") type = "warranty_company";
  else if (message?.kind === "other") type = "other";
  else type = normalizeType(custom.call_type);
  if (!type && records.some((record) => record.kind === "warranty_company")) {
    type = "warranty_company";
  }
  if (!type) type = "other";

  const callerName =
    cleanString(
      firstNonEmpty(
        booking?.customer_name,
        message?.caller_name,
        custom.caller_name,
        call.caller_name,
      ),
      120,
    ) || "Unknown caller";
  const callbackNumber =
    cleanString(
      firstNonEmpty(
        booking?.phone_number,
        message?.callback_number,
        custom.callback_number,
        call.from_number,
        call.to_number,
      ),
      60,
    ) || "Not captured";
  const company = cleanString(
    firstNonEmpty(message?.company, custom.company_name),
    160,
  );
  const appliance = cleanString(
    firstNonEmpty(
      booking?.appliance_type,
      custom.appliance_type,
      custom.appliance,
      call.appliance,
    ),
    160,
  );
  const brand = normalizeBrand(
    firstNonEmpty(booking?.appliance_brand, custom.appliance_brand, custom.brand),
  );
  const issue = cleanString(
    firstNonEmpty(
      booking?.issue_description,
      message?.job_details,
      message?.reason,
      custom.issue_description,
      custom.notes,
    ),
    700,
  );
  const serviceAddress = cleanString(
    firstNonEmpty(booking?.service_address, custom.service_address),
    300,
  );

  let status = "no_booking";
  if (booking) status = "booked";
  else if (message) status = "message_taken";
  else if (type === "spam") status = "spam";
  else if (custom.service_fee_accepted === false && type === "standard") {
    status = "declined_fee";
  }

  const feeAccepted =
    booking?.is_warranty
      ? null
      : booking
        ? Boolean(booking.fee_accepted)
        : typeof custom.service_fee_accepted === "boolean"
          ? custom.service_fee_accepted
          : null;

  const turns = normalizeTranscript(call);
  const startedAt = call.start_timestamp
    ? new Date(call.start_timestamp).toISOString()
    : now.toISOString();
  const endedAt = call.end_timestamp
    ? new Date(call.end_timestamp).toISOString()
    : now.toISOString();
  const durationMs = Math.max(
    0,
    (call.end_timestamp || now.getTime()) -
      (call.start_timestamp || now.getTime()),
  );
  const analysisSummary = cleanString(
    firstNonEmpty(
      custom.call_summary,
      analysis.call_summary,
      analysis.summary,
      recordPayload.summary,
    ),
    1000,
  );
  const notification = {
    call_id: call.call_id || booking?.call_id || message?.call_id,
    type,
    status,
    callerName,
    callbackNumber,
    fromNumber: cleanString(call.from_number, 60) || null,
    company: company || null,
    appliance: appliance || null,
    brand: brand === "Unknown" ? null : brand,
    issue: issue || null,
    jobDetails: cleanString(message?.job_details, 700) || null,
    reason: cleanString(message?.reason, 700) || null,
    serviceAddress: serviceAddress || null,
    feeQuoted: type === "standard",
    feeAccepted,
    bookingId: booking?.booking_id || null,
    messageId: message?.message_id || null,
    summary: "",
    analysisSummary: analysisSummary || null,
    sentiment: analysis.user_sentiment || null,
    callSuccessful:
      typeof analysis.call_successful === "boolean"
        ? analysis.call_successful
        : null,
    transcript: turns,
    transcriptText: turns
      .map(
        (turn) =>
          `${turn.role === "agent" ? "Agent" : "Caller"}: ${turn.content}`,
      )
      .join("\n"),
    recordingUrl: call.recording_url || null,
    disconnectionReason: call.disconnection_reason || null,
    durationMs,
    startedAt,
    endedAt,
    source:
      call.metadata?.source ||
      (call.call_type === "web_call" ? "browser" : "phone"),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    telegramStatus: "pending",
    telegramMessageId: null,
  };
  notification.summary = deterministicSummary(notification);
  return notification;
}

export function mergeNotification(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    createdAt: existing.createdAt,
    telegramStatus: existing.telegramStatus || incoming.telegramStatus,
    telegramMessageId:
      existing.telegramMessageId || incoming.telegramMessageId || null,
    updatedAt: new Date().toISOString(),
  };
}

export const TYPE_LABELS = {
  standard: "Standard",
  warranty: "Warranty",
  warranty_company: "Warranty rep",
  spam: "Spam",
  other: "Other",
};

export const STATUS_LABELS = {
  booked: "Booked",
  message_taken: "Message taken",
  declined_fee: "Declined fee",
  no_booking: "No booking",
  spam: "Spam",
};
