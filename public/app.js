const TYPE_LABELS = {
  standard: "Standard",
  warranty: "Warranty",
  warranty_company: "Warranty rep",
  spam: "Spam",
  other: "Other",
};

const STATUS_LABELS = {
  booked: "Booked",
  message_taken: "Message taken",
  declined_fee: "Declined fee",
  no_booking: "No booking",
  spam: "Spam",
};

const FILTER_LABELS = {
  all: "All calls",
  standard: "Standard",
  warranty: "Warranty",
  warranty_company: "Warranty reps",
  spam: "Spam",
  other: "Other",
};

const state = {
  notifications: [],
  stats: {},
  filter: "all",
  search: "",
  selected: null,
  known: new Set(),
  config: null,
  initialized: false,
  eventSource: null,
  toastTimer: null,
};

const elements = {
  feed: document.getElementById("feed"),
  feedLabel: document.getElementById("feed-label"),
  search: document.getElementById("search"),
  detail: document.getElementById("detail"),
  detailEmpty: document.getElementById("detail-empty"),
  detailContent: document.getElementById("detail-content"),
  refresh: document.getElementById("refresh"),
  pageTitle: document.getElementById("page-title"),
  pageSubtitle: document.getElementById("page-subtitle"),
  connectionDot: document.getElementById("connection-dot"),
  connectionLabel: document.getElementById("connection-label"),
  agentState: document.getElementById("agent-state"),
  toast: document.getElementById("toast"),
  dialog: document.getElementById("call-dialog"),
  callTitle: document.getElementById("call-title"),
  callStatus: document.getElementById("call-status"),
  callTimer: document.getElementById("call-timer"),
  callError: document.getElementById("call-error"),
  callAvatar: document.getElementById("call-avatar"),
  callName: document.getElementById("call-name"),
  callNameWrap: document.getElementById("call-name-wrap"),
  startCall: document.getElementById("start-call"),
  endCall: document.getElementById("end-call"),
  doneCall: document.getElementById("done-call"),
  closeCall: document.getElementById("close-call"),
  openPersona: document.getElementById("open-persona"),
  loginDialog: document.getElementById("login-dialog"),
  loginPassword: document.getElementById("login-password"),
  loginSubmit: document.getElementById("login-submit"),
  loginError: document.getElementById("login-error"),
  loginStatus: document.getElementById("login-status"),
  personaDialog: document.getElementById("persona-dialog"),
  personaWarmth: document.getElementById("persona-warmth"),
  personaTaskFocus: document.getElementById("persona-task-focus"),
  personaFacts: document.getElementById("persona-facts"),
  personaAdditions: document.getElementById("persona-additions"),
  personaPreview: document.getElementById("persona-preview"),
  personaApply: document.getElementById("persona-apply"),
  personaClose: document.getElementById("persona-close"),
  personaError: document.getElementById("persona-error"),
  personaStatus: document.getElementById("persona-status"),
  personaPreviewOutput: document.getElementById("persona-preview-output"),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function initials(name) {
  const parts = String(name || "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function safeText(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function typeLabel(type) {
  return TYPE_LABELS[type] || "Call";
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Call";
}

function formatDate(value, timezone) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone || undefined,
  }).format(date);
}

function formatTime(value, timezone) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.toLocaleDateString(undefined, { timeZone: timezone }) ===
    now.toLocaleDateString(undefined, { timeZone: timezone });
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || undefined,
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: timezone || undefined,
  }).format(date);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function telHref(number) {
  const digits = String(number || "").replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 7 ? `tel:${digits}` : null;
}

function notificationSearchText(item) {
  return [
    item.callerName,
    item.company,
    item.callbackNumber,
    item.fromNumber,
    item.appliance,
    item.brand,
    item.issue,
    item.jobDetails,
    item.reason,
    item.serviceAddress,
    item.bookingId,
    item.summary,
    item.transcriptText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function visibleNotifications() {
  const query = state.search.trim().toLowerCase();
  return state.notifications.filter((item) => {
    if (state.filter !== "all" && item.type !== state.filter) return false;
    if (query && !notificationSearchText(item).includes(query)) return false;
    return true;
  });
}

function computeStats() {
  const stats = {
    all: state.notifications.length,
    standard: 0,
    warranty: 0,
    warranty_company: 0,
    spam: 0,
    other: 0,
    booked: 0,
  };
  for (const item of state.notifications) {
    if (stats[item.type] !== undefined) stats[item.type] += 1;
    if (item.status === "booked") stats.booked += 1;
  }
  return stats;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 4200);
}

function setConnection(online, label) {
  elements.connectionDot.classList.toggle("offline", !online);
  elements.connectionLabel.textContent = label;
}

async function loadConfig() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Unable to load app configuration");
  state.config = await response.json();
  elements.pageTitle.textContent = state.config.dashboardTitle || "Call inbox";
  elements.pageSubtitle.textContent = `${state.config.companyName} · every call, summarized for the office.`;
  elements.agentState.textContent = state.config.agentConfigured
    ? "Ready"
    : "Not provisioned";
  if (!state.config.agentConfigured) {
    elements.agentState.style.color = "#d9a184";
  }
}

async function loadNotifications({ silent = false } = {}) {
  const response = await fetch("/api/notifications");
  if (!response.ok) throw new Error("Unable to load calls");
  const data = await response.json();
  const incoming = Array.isArray(data.notifications) ? data.notifications : [];
  const newItems = state.initialized
    ? incoming.filter((item) => !state.known.has(item.call_id))
    : [];
  state.notifications = incoming;
  state.stats = data.stats || computeStats();
  state.initialized = true;
  state.known = new Set(incoming.map((item) => item.call_id));
  if (!silent && newItems.length) {
    const first = newItems[0];
    showToast(`New call: ${first.callerName} · ${typeLabel(first.type)}`);
  }
  if (state.selected && !incoming.some((item) => item.call_id === state.selected)) {
    closeDetail();
  }
  render();
}

function render() {
  renderStats();
  renderNavCounts();
  renderFeed();
  renderDetail();
}

function renderStats() {
  const stats = { ...computeStats(), ...state.stats };
  for (const key of ["all", "booked", "warranty", "warranty_company"]) {
    const target = document.getElementById(`stat-${key}`);
    if (target) target.textContent = String(stats[key] || 0);
  }
}

function renderNavCounts() {
  const stats = computeStats();
  for (const key of [
    "all",
    "standard",
    "warranty",
    "warranty_company",
    "spam",
    "other",
  ]) {
    const target = document.querySelector(`[data-count="${key}"]`);
    if (target) target.textContent = String(stats[key] || 0);
  }
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === state.filter);
  });
  elements.feedLabel.textContent = FILTER_LABELS[state.filter] || "All calls";
}

function makeChip(label, className) {
  return el("span", `chip ${className || ""}`.trim(), label);
}

function buildCallCard(item) {
  const card = el("button", "call-card");
  card.type = "button";
  card.dataset.callId = item.call_id;
  if (item.call_id === state.selected) card.classList.add("is-selected");
  card.addEventListener("click", () => selectCall(item.call_id));

  const avatar = el("span", `avatar type-${item.type || "other"}`, initials(item.callerName));
  avatar.setAttribute("aria-hidden", "true");

  const main = el("span", "call-main");
  const top = el("span", "call-topline");
  top.append(
    el("span", "call-name", safeText(item.callerName, "Unknown caller")),
    el("span", "call-number", safeText(item.callbackNumber, "No callback number")),
  );
  const summary = el(
    "span",
    "call-summary",
    safeText(item.summary, "No summary available."),
  );
  const chips = el("span", "chips");
  chips.append(makeChip(typeLabel(item.type), `type-${item.type || "other"}`));
  chips.append(makeChip(statusLabel(item.status), `status-${item.status}`));
  if (item.brand || item.appliance) {
    chips.append(
      makeChip(
        [item.brand, item.appliance].filter(Boolean).join(" "),
        "muted-chip",
      ),
    );
  }
  if (item.bookingId) chips.append(makeChip(item.bookingId, "plain-chip"));
  if (item.source === "demo") chips.append(makeChip("Demo", "plain-chip"));
  main.append(top, summary, chips);

  const side = el("span", "call-side");
  side.append(
    el("span", "call-time", formatTime(item.startedAt, state.config?.timezone)),
    el("span", "call-duration", formatDuration(item.durationMs)),
  );

  card.append(avatar, main, side);
  return card;
}

function renderFeed() {
  const items = visibleNotifications();
  const previousScroll = elements.feed.scrollTop;
  elements.feed.replaceChildren();

  if (!items.length) {
    const empty = el("div", "empty-feed");
    if (state.notifications.length === 0) {
      empty.append(
        el("strong", "", "Your first call will land here"),
        el(
          "p",
          "",
          "Start a live browser call to hear Grace handle a real conversation. The summary appears here when the call ends.",
        ),
      );
      const button = el("button", "text-button", "Test the voice agent");
      button.type = "button";
      button.addEventListener("click", openCallDialog);
      empty.append(button);
    } else if (state.search.trim()) {
      empty.append(
        el("strong", "", "No matching calls"),
        el("p", "", "Try a different name, number, or appliance."),
      );
    } else {
      empty.append(
        el("strong", "", "Nothing in this view yet"),
        el("p", "", "Calls from this category will show up here."),
      );
    }
    elements.feed.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(buildCallCard(item));
  elements.feed.append(fragment);
  elements.feed.scrollTop = previousScroll;
}

function field(label, value, { wide = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const wrapper = el("div", `detail-field${wide ? " wide" : ""}`);
  wrapper.append(el("dt", "", label), el("dd", "", String(value)));
  return wrapper;
}

function linkedField(label, value, href) {
  const wrapper = field(label, value);
  if (!wrapper || !href) return wrapper;
  const dd = wrapper.querySelector("dd");
  dd.replaceChildren();
  const link = el("a", "", String(value));
  link.href = href;
  dd.append(link);
  return wrapper;
}

function renderDetail() {
  const item = state.notifications.find(
    (notification) => notification.call_id === state.selected,
  );
  if (!item) {
    elements.detailContent.hidden = true;
    elements.detailEmpty.hidden = false;
    elements.detail.classList.remove("is-open");
    return;
  }

  elements.detailEmpty.hidden = true;
  elements.detailContent.hidden = false;
  elements.detailContent.replaceChildren();

  const head = el("div", "detail-head");
  const avatar = el(
    "span",
    `avatar type-${item.type || "other"}`,
    initials(item.callerName),
  );
  const title = el("div", "detail-title");
  title.append(
    el("h2", "", safeText(item.callerName, "Unknown caller")),
    el(
      "p",
      "detail-subline",
      [
        item.callbackNumber,
        `${typeLabel(item.type)} · ${statusLabel(item.status)}`,
        formatDate(item.startedAt, state.config?.timezone),
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  const close = el("button", "detail-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close call details");
  close.addEventListener("click", closeDetail);
  head.append(avatar, title, close);

  const summarySection = el("section", "detail-section");
  summarySection.append(el("p", "section-label", "Summary"));
  summarySection.append(
    el("p", "summary-text", safeText(item.summary, "No summary captured.")),
  );

  const chips = el("div", "chips");
  chips.append(makeChip(typeLabel(item.type), `type-${item.type || "other"}`));
  chips.append(makeChip(statusLabel(item.status), `status-${item.status}`));
  if (item.source === "demo") chips.append(makeChip("Demo", "plain-chip"));
  if (item.disconnectionReason) {
    chips.append(
      makeChip(
        String(item.disconnectionReason).replaceAll("_", " "),
        "plain-chip",
      ),
    );
  }
  summarySection.append(chips);

  const details = el("section", "detail-section");
  details.append(el("p", "section-label", "Call details"));
  const grid = el("dl", "detail-grid");
  const callback = linkedField(
    "Callback",
    item.callbackNumber,
    telHref(item.callbackNumber),
  );
  if (callback) grid.append(callback);
  if (item.fromNumber) grid.append(field("Caller ID", item.fromNumber));
  grid.append(field("Call type", typeLabel(item.type)));
  grid.append(field("Status", statusLabel(item.status)));
  grid.append(field("Duration", formatDuration(item.durationMs)));
  if (item.company) grid.append(field("Company", item.company, { wide: true }));
  if (item.brand) grid.append(field("Brand", item.brand));
  if (item.appliance) grid.append(field("Appliance", item.appliance));
  if (item.issue) grid.append(field("Issue", item.issue, { wide: true }));
  if (item.jobDetails) {
    grid.append(field("Job details", item.jobDetails, { wide: true }));
  }
  if (item.reason) grid.append(field("Reason", item.reason, { wide: true }));
  if (item.serviceAddress) {
    grid.append(field("Service address", item.serviceAddress, { wide: true }));
  }
  if (item.bookingId) grid.append(field("Booking", item.bookingId));
  if (item.type === "standard") {
    grid.append(
      field(
        "Service fee",
        item.feeAccepted === true
          ? "$99 accepted"
          : item.feeAccepted === false
            ? "$99 declined"
            : "Not confirmed",
      ),
    );
  }
  if (item.type === "warranty") {
    grid.append(field("Service fee", "Waived - covered warranty brand"));
  }
  if (item.recordingUrl) {
    const value = "Open recording";
    const wrapper = field("Recording", value);
    const dd = wrapper.querySelector("dd");
    dd.replaceChildren();
    const link = el("a", "", value);
    link.href = item.recordingUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    dd.append(link);
    grid.append(wrapper);
  }
  details.append(grid);

  const actions = el("div", "detail-actions");
  const callLink = telHref(item.callbackNumber);
  if (callLink) {
    const link = el("a", "action-button", "Call back");
    link.href = callLink;
    actions.append(link);
  }
  if (item.transcriptText) {
    const copy = el("button", "action-button", "Copy transcript");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.transcriptText);
        showToast("Transcript copied");
      } catch {
        showToast("Copy failed. Select the transcript manually.");
      }
    });
    actions.append(copy);
  }
  if (actions.childElementCount) details.append(actions);

  const transcriptSection = el("section", "detail-section");
  transcriptSection.append(
    el("p", "section-label", `Transcript · ${item.transcript?.length || 0} turns`),
  );
  if (item.transcript?.length) {
    const transcript = el("div", "transcript");
    for (const turn of item.transcript) {
      const row = el("div", `turn ${turn.role === "user" ? "user" : "agent"}`);
      row.append(
        el("span", "turn-role", turn.role === "user" ? "Caller" : "Grace"),
        el("span", "turn-bubble", turn.content),
      );
      transcript.append(row);
    }
    transcriptSection.append(transcript);
  } else {
    transcriptSection.append(
      el("p", "summary-text", "No transcript was captured for this call."),
    );
  }

  elements.detailContent.append(head, summarySection, details, transcriptSection);

  if (item.analysisSummary) {
    const noteSection = el("section", "detail-section");
    noteSection.append(el("p", "section-label", "Agent call summary"));
    noteSection.append(el("p", "analysis-note", item.analysisSummary));
    elements.detailContent.append(noteSection);
  }
}

function selectCall(callId) {
  state.selected = callId;
  renderFeed();
  renderDetail();
  elements.detail.classList.add("is-open");
  const url = new URL(window.location.href);
  url.searchParams.set("call", callId);
  window.history.replaceState({}, "", url);
}

function closeDetail() {
  state.selected = null;
  elements.detail.classList.remove("is-open");
  renderFeed();
  renderDetail();
  const url = new URL(window.location.href);
  url.searchParams.delete("call");
  window.history.replaceState({}, "", url);
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource("/api/events");
  state.eventSource = source;
  source.onopen = () => setConnection(true, "Live feed");
  source.onerror = () => setConnection(false, "Reconnecting");
  source.addEventListener("notification", (event) => {
    try {
      const notification = JSON.parse(event.data);
      const index = state.notifications.findIndex(
        (item) => item.call_id === notification.call_id,
      );
      const isNew = index === -1;
      if (index === -1) state.notifications.unshift(notification);
      else state.notifications[index] = notification;
      state.notifications.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      );
      state.stats = computeStats();
      state.known.add(notification.call_id);
      render();
      if (isNew) {
        showToast(
          `New call: ${notification.callerName} · ${typeLabel(notification.type)}`,
        );
      }
      if (state.selected === notification.call_id) renderDetail();
    } catch {
      // Ignore malformed events.
    }
  });
}

function bindUI() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter || "all";
      renderNavCounts();
      renderFeed();
    });
  });

  let searchTimer = null;
  elements.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = elements.search.value;
      renderFeed();
    }, 90);
  });

  elements.refresh.addEventListener("click", async () => {
    elements.refresh.classList.add("is-spinning");
    try {
      await loadNotifications({ silent: true });
      showToast("Calls refreshed");
    } catch {
      showToast("Could not refresh calls");
    } finally {
      elements.refresh.classList.remove("is-spinning");
    }
  });

  document.getElementById("open-call").addEventListener("click", openCallDialog);
  document.getElementById("empty-demo").addEventListener("click", openCallDialog);
  elements.closeCall.addEventListener("click", () => closeCallDialog());
  elements.doneCall.addEventListener("click", () => closeCallDialog());
  elements.startCall.addEventListener("click", startCall);
  elements.endCall.addEventListener("click", endCall);
  elements.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCallDialog();
  });

  window.addEventListener("popstate", () => {
    const callId = new URL(window.location.href).searchParams.get("call");
    if (callId) selectCall(callId);
    else closeDetail();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.dialog.open && state.selected) {
      closeDetail();
    }
  });

  if (elements.openPersona) {
    elements.openPersona.addEventListener("click", openPersonaDialog);
  }
  if (elements.personaClose) {
    elements.personaClose.addEventListener("click", () => elements.personaDialog.close());
  }
  if (elements.personaPreview) {
    elements.personaPreview.addEventListener("click", previewPersona);
  }
  if (elements.personaApply) {
    elements.personaApply.addEventListener("click", applyPersona);
  }
  if (elements.loginSubmit) {
    elements.loginSubmit.addEventListener("click", submitLogin);
  }
  if (elements.loginPassword) {
    elements.loginPassword.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitLogin();
    });
  }
}

let voiceController = null;
let callStartedAt = 0;
let callTimer = null;
let callActive = false;

function setCallUI(mode) {
  const isConnecting = mode === "connecting";
  const isLive = mode === "live";
  const isEnded = mode === "ended";
  elements.startCall.hidden = isLive || isConnecting || isEnded;
  elements.startCall.disabled = isConnecting;
  elements.endCall.hidden = !isLive;
  elements.doneCall.hidden = !isEnded;
  elements.callNameWrap.hidden = isLive || isConnecting || isEnded;
  elements.callAvatar.classList.toggle("is-live", isLive || isConnecting);
  if (!isLive) elements.callAvatar.classList.remove("is-talking");
}

function startTimer() {
  callStartedAt = Date.now();
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - callStartedAt) / 1000);
    elements.callTimer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 500);
}

function stopTimer() {
  clearInterval(callTimer);
  callTimer = null;
}

function resetCallDialog() {
  stopTimer();
  callActive = false;
  voiceController = null;
  elements.callTimer.textContent = "00:00";
  elements.callStatus.textContent = "Start a browser call to test the real agent.";
  elements.callError.textContent = "";
  elements.callAvatar.classList.remove("is-live", "is-talking");
  elements.callNameWrap.hidden = false;
  elements.startCall.hidden = false;
  elements.startCall.disabled = false;
  elements.endCall.hidden = true;
  elements.doneCall.hidden = true;
}

function openCallDialog() {
  resetCallDialog();
  elements.callTitle.textContent = "Call Grace";
  if (state.config && !state.config.agentConfigured) {
    elements.callError.textContent =
      "The voice agent is not provisioned yet. Add RETELL_AGENT_ID and try again.";
    elements.startCall.disabled = true;
  }
  elements.dialog.showModal();
  setTimeout(() => elements.callName.focus(), 50);
}

function closeCallDialog() {
  if (callActive && voiceController) {
    try {
      voiceController.stop();
    } catch {
      // ignore
    }
  }
  callActive = false;
  stopTimer();
  elements.dialog.close();
  resetCallDialog();
}

async function startCall() {
  if (!window.FixCallVoice) {
    elements.callError.textContent =
      "Voice bundle missing. Run npm run build, then reload the page.";
    return;
  }
  elements.callError.textContent = "";
  elements.startCall.disabled = true;
  elements.callStatus.textContent = "Connecting to Grace...";
  setCallUI("connecting");
  try {
    voiceController = await window.FixCallVoice.startVoiceDemo({
      name: elements.callName.value.trim(),
      onStatus: (status) => {
        if (status === "live") {
          elements.callStatus.textContent = "Grace is listening";
        } else if (status === "connecting") {
          elements.callStatus.textContent = "Connecting to Grace...";
        }
      },
      onTalking: (talking) => {
        elements.callAvatar.classList.toggle("is-talking", Boolean(talking));
      },
      onEnd: () => {
        if (!callActive) return;
        callActive = false;
        stopTimer();
        setCallUI("ended");
        elements.callStatus.textContent =
          "Call ended. Saving the summary for the inbox...";
        setTimeout(() => loadNotifications({ silent: true }).catch(() => {}), 1800);
        setTimeout(() => loadNotifications({ silent: true }).catch(() => {}), 6500);
        setTimeout(() => {
          if (elements.dialog.open) elements.dialog.close();
        }, 1500);
      },
      onError: (message) => {
        elements.callError.textContent = message;
      },
    });
    callActive = true;
    setCallUI("live");
    elements.callStatus.textContent = "Grace is listening. Say hello.";
    startTimer();
    setTimeout(() => elements.endCall.focus(), 100);
  } catch (error) {
    callActive = false;
    setCallUI("ended");
    elements.callStatus.textContent = "The call could not start.";
    elements.callError.textContent =
      error?.message || "Something went wrong while starting the call.";
    elements.doneCall.hidden = false;
    voiceController = null;
  }
}

function endCall() {
  if (voiceController) {
    try {
      voiceController.stop();
    } catch {
      // ignore
    }
  }
  callActive = false;
  stopTimer();
  setCallUI("ended");
  elements.callStatus.textContent =
    "Call ended. Saving the summary for the inbox...";
  setTimeout(() => loadNotifications({ silent: true }).catch(() => {}), 1600);
  setTimeout(() => loadNotifications({ silent: true }).catch(() => {}), 6000);
  setTimeout(() => {
    if (elements.dialog.open) elements.dialog.close();
  }, 1500);
}

async function ensureAdmin() {
  try {
    const response = await fetch("/api/auth/status");
    const data = await response.json();
    if (!data.authEnabled || data.admin) return true;
    if (elements.loginDialog && !elements.loginDialog.open) {
      elements.loginDialog.showModal();
    }
    return false;
  } catch {
    return true;
  }
}

async function submitLogin() {
  const password = elements.loginPassword.value;
  elements.loginError.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      elements.loginError.textContent = "Invalid password";
      return;
    }
    elements.loginDialog.close();
    await loadNotifications({ silent: true });
    showToast("Signed in");
  } catch {
    elements.loginError.textContent = "Login failed";
  }
}

async function loadPersona() {
  try {
    const [personaResponse, statusResponse] = await Promise.all([
      fetch("/api/admin/persona"),
      fetch("/api/admin/status"),
    ]);
    if (personaResponse.ok) {
      const data = await personaResponse.json();
      const persona = data.persona || {};
      elements.personaWarmth.value = persona.warmth || "warm";
      elements.personaTaskFocus.value = persona.taskFocus || "task_focused";
      elements.personaFacts.value = JSON.stringify(persona.businessFacts || {}, null, 2);
      elements.personaAdditions.value = persona.promptAdditions || "";
    }
    if (statusResponse.ok) {
      const status = await statusResponse.json();
      elements.personaApply.disabled = !status.applyReady;
      elements.personaStatus.textContent = status.applyReady
        ? "Ready to apply changes."
        : status.reason || "Apply is not available.";
    }
  } catch {
    showToast("Could not load persona");
  }
}

async function personaPayload() {
  let businessFacts = {};
  try {
    businessFacts = JSON.parse(elements.personaFacts.value || "{}");
  } catch {
    throw new Error("Business facts must be valid JSON");
  }
  const csrf = await fetch("/api/auth/csrf").then((r) => r.json()).then((d) => d.token).catch(() => "");
  return {
    csrf,
    body: {
      warmth: elements.personaWarmth.value,
      taskFocus: elements.personaTaskFocus.value,
      businessFacts,
      promptAdditions: elements.personaAdditions.value,
    },
  };
}

async function previewPersona() {
  elements.personaError.textContent = "";
  try {
    const { csrf, body } = await personaPayload();
    const response = await fetch("/api/admin/persona/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!response.ok) throw new Error(data.error || `Preview failed (${response.status})`);
    elements.personaPreviewOutput.textContent = data.prompt || "";
    elements.personaStatus.textContent = "Preview ready";
  } catch (error) {
    elements.personaError.textContent = error.message;
  }
}

async function applyPersona() {
  elements.personaError.textContent = "";
  elements.personaStatus.textContent = "Saving and applying to agent...";
  elements.personaApply.disabled = true;
  try {
    const { csrf, body } = await personaPayload();
    const saveResponse = await fetch("/api/admin/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    const saveText = await saveResponse.text();
    let saveData = {};
    try { saveData = saveText ? JSON.parse(saveText) : {}; } catch { saveData = { error: saveText }; }
    if (!saveResponse.ok) throw new Error(saveData.error || `Save failed (${saveResponse.status})`);
    const applyResponse = await fetch("/api/admin/persona/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    const applyText = await applyResponse.text();
    let applyData = {};
    try { applyData = applyText ? JSON.parse(applyText) : {}; } catch { applyData = { error: applyText }; }
    if (!applyResponse.ok) throw new Error(applyData.error || `Apply failed (${applyResponse.status})`);
    elements.personaStatus.textContent = `Applied as version ${applyData.state?.version ?? ""}`;
    showToast("Persona applied to Grace");
  } catch (error) {
    elements.personaError.textContent = error.message;
    elements.personaStatus.textContent = "Apply failed";
  } finally {
    elements.personaApply.disabled = false;
  }
}

async function openPersonaDialog() {
  const admin = await ensureAdmin();
  if (!admin) {
    if (elements.loginDialog && !elements.loginDialog.open) elements.loginDialog.showModal();
    return;
  }
  await loadPersona();
  if (!elements.personaDialog.open) elements.personaDialog.showModal();
}

async function init() {
  bindUI();
  const admin = await ensureAdmin();
  if (!admin) {
    if (elements.loginDialog && !elements.loginDialog.open) elements.loginDialog.showModal();
    return;
  }
  try {
    await loadConfig();
  } catch {
    showToast("Could not load configuration");
  }
  try {
    await loadNotifications({ silent: true });
  } catch {
    showToast("Could not load calls");
  }
  connectEvents();

  const params = new URL(window.location.href).searchParams;
  const callId = params.get("call");
  if (callId) selectCall(callId);
}

init();
