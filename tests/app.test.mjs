import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { NotificationService, EventBus } from "../src/notifications.mjs";
import { signRetellBody } from "../src/retell.mjs";
import { Store } from "../src/store.mjs";
import { formatTelegram } from "../src/telegram.mjs";

const API_KEY = "key_test_fixcall";

async function harness({ allowUnsigned = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "fixcall-test-"));
  const config = {
    ...loadConfig({}),
    port: 0,
    publicBaseUrl: "https://inbox.example.test",
    dataDir: dir,
    retellApiKey: API_KEY,
    retellAgentId: "agent_test",
    telegramBotToken: "",
    telegramChatId: "",
    allowUnsignedRetell: allowUnsigned,
    finalizeOrphans: false,
    webCallRateLimit: 100,
  };
  const store = await new Store({ dataDir: dir }).init();
  const eventBus = new EventBus();
  const notificationService = new NotificationService({
    store,
    config,
    eventBus,
    logger: { error() {}, warn() {} },
  });
  const app = createApp({
    config,
    store,
    notificationService,
    eventBus,
    logger: { error() {}, warn() {} },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(url, options = {}) {
    const response = await fetch(`${base}${url}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { response, json };
  }

  async function signedPost(url, payload) {
    const body = JSON.stringify(payload);
    return request(url, {
      method: "POST",
      body,
      headers: {
        "x-retell-signature": signRetellBody(body, API_KEY),
      },
    });
  }

  return {
    config,
    store,
    base,
    request,
    signedPost,
    async close() {
      eventBus.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function callWith({ id, transcript, from = "+14155550100" }) {
  return {
    call_id: id,
    call_type: "web_call",
    from_number: from,
    start_timestamp: Date.now() - 90_000,
    end_timestamp: Date.now(),
    disconnection_reason: "user_hangup",
    transcript_object: transcript.map(([role, content]) => ({ role, content })),
  };
}

function standardTranscript() {
  return [
    ["agent", "Thanks for calling FixCall Appliance Repair, this is Grace. How can I help?"],
    ["user", "My Whirlpool dishwasher is leaking."],
    ["agent", "What's your name and the best callback number?"],
    ["user", "Jane Miller, 415-555-0138."],
    ["agent", "And the service address?"],
    ["user", "1428 Fulton Street, San Francisco."],
    ["agent", "There's a $99 service call fee for the visit. Does that work for you?"],
    ["user", "Yes, that works."],
  ];
}

function standardArgs(overrides = {}) {
  return {
    customer_name: "Jane Miller",
    phone_number: "415-555-0138",
    service_address: "1428 Fulton Street, San Francisco",
    appliance_type: "dishwasher",
    appliance_brand: "Whirlpool",
    issue_description: "leaking water onto the floor",
    is_warranty: false,
    fee_accepted: true,
    ...overrides,
  };
}

test("health endpoint responds without auth", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const { response, json } = await h.request("/healthz");
  assert.equal(response.status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.agentConfigured, true);
});

test("standard booking requires a clear fee acceptance in the transcript", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_standard_1",
    transcript: standardTranscript(),
  });
  const { response, json } = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs(),
    call,
  });
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.match(json.booking_id, /^FC-/);
  assert.equal(h.store.getBooking(call.call_id).is_warranty, false);
});

test("standard booking is rejected without a clear yes", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_standard_2",
    transcript: [
      ["agent", "There's a $99 service call fee for the visit. Does that work for you?"],
      ["user", "That's more than I expected."],
    ],
  });
  const { json } = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs({ fee_accepted: true }),
    call,
  });
  assert.equal(json.ok, false);
  assert.equal(json.code, "fee_not_accepted");
  assert.equal(h.store.getBooking(call.call_id), null);
});

test("agent cannot claim fee acceptance without the transcript", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_standard_3",
    transcript: [
      ["agent", "What appliance is it?"],
      ["user", "A Whirlpool dishwasher."],
    ],
  });
  const { json } = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs({ fee_accepted: true }),
    call,
  });
  assert.equal(json.ok, false);
  assert.equal(json.code, "fee_not_accepted");
});

test("covered warranty booking succeeds with no fee", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_warranty_1",
    transcript: [
      ["agent", "How can I help?"],
      ["user", "My Samsung refrigerator is warm and it's still under warranty."],
    ],
  });
  const { json } = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs({
      customer_name: "Marcus Chen",
      phone_number: "510-555-0194",
      service_address: "88 Bayview Drive, Oakland",
      appliance_brand: "Samsung",
      appliance_type: "refrigerator",
      issue_description: "refrigerator side is warm",
      is_warranty: true,
      fee_accepted: false,
    }),
    call,
  });
  assert.equal(json.ok, true);
  const booking = h.store.getBooking(call.call_id);
  assert.equal(booking.is_warranty, true);
  assert.equal(booking.fee_accepted, false);
});

test("warranty booking is rejected for non-covered brands", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_warranty_2",
    transcript: [
      ["agent", "How can I help?"],
      ["user", "My Whirlpool oven is under warranty."],
    ],
  });
  const { json } = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs({
      appliance_brand: "Whirlpool",
      appliance_type: "oven",
      is_warranty: true,
      fee_accepted: false,
    }),
    call,
  });
  assert.equal(json.ok, false);
  assert.equal(json.code, "warranty_brand_not_covered");
});

test("warranty rep message is taken and appears in the feed", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_company_1",
    transcript: [
      ["agent", "How can I help?"],
      ["user", "This is Denise from American Home Shield with a work order."],
    ],
  });
  const tool = await h.signedPost(
    "/api/retell/tools/take-warranty-message",
    {
      name: "take_warranty_message",
      args: {
        caller_name: "Denise Walker",
        company: "American Home Shield",
        callback_number: "800-555-0117",
        job_details: "GE wall oven will not heat. Work order 4482190.",
      },
      call,
    },
  );
  assert.equal(tool.json.ok, true);

  const { json } = await h.signedPost("/api/retell/webhook", {
    event: "call_ended",
    call,
  });
  assert.equal(json.ok, true);

  const feed = await h.request("/api/notifications");
  const item = feed.json.notifications.find(
    (notification) => notification.call_id === call.call_id,
  );
  assert.equal(item.type, "warranty_company");
  assert.equal(item.status, "message_taken");
  assert.equal(item.company, "American Home Shield");
  assert.equal(item.serviceAddress, null);
});

test("call ended and call analyzed update one notification without duplicates", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_analysis_1",
    transcript: standardTranscript(),
  });
  await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs(),
    call,
  });

  await h.signedPost("/api/retell/webhook", { event: "call_ended", call });
  const callWithAnalysis = {
    ...call,
    call_analysis: {
      call_summary: "Jane booked a Whirlpool dishwasher repair and accepted the fee.",
      user_sentiment: "positive",
      call_successful: true,
      custom_analysis_data: {
        call_type: "standard",
        caller_name: "Jane Miller",
        callback_number: "415-555-0138",
        service_fee_accepted: true,
        booked: true,
      },
    },
  };
  await h.signedPost("/api/retell/webhook", {
    event: "call_analyzed",
    call: callWithAnalysis,
  });
  await h.signedPost("/api/retell/webhook", {
    event: "call_analyzed",
    call: callWithAnalysis,
  });

  const feed = await h.request("/api/notifications");
  const items = feed.json.notifications.filter(
    (notification) => notification.call_id === call.call_id,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "booked");
  assert.equal(items[0].feeAccepted, true);
  assert.equal(items[0].callerName, "Jane Miller");
  assert.match(items[0].analysisSummary, /Whirlpool dishwasher/);
  assert.equal(feed.json.stats.booked, 1);
});

test("spam call is classified without a booking", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_spam_1",
    transcript: [
      ["agent", "How can I help?"],
      ["user", "I'm calling about a limited-time solar incentive."],
      ["agent", "Sorry, I can't help with that."],
    ],
  });
  await h.signedPost("/api/retell/webhook", {
    event: "call_analyzed",
    call: {
      ...call,
      call_analysis: {
        custom_analysis_data: {
          call_type: "spam",
          call_summary: "Solar sales pitch. Call ended.",
        },
      },
    },
  });
  const feed = await h.request("/api/notifications");
  assert.equal(feed.json.notifications[0].type, "spam");
  assert.equal(feed.json.notifications[0].status, "spam");
  assert.equal(feed.json.stats.spam, 1);
});

test("booking is idempotent per call", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const call = callWith({
    id: "call_idempotent_1",
    transcript: standardTranscript(),
  });
  const first = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs(),
    call,
  });
  const second = await h.signedPost("/api/retell/tools/book-service-call", {
    name: "book_service_call",
    args: standardArgs(),
    call,
  });
  assert.equal(first.json.ok, true);
  assert.equal(second.json.ok, true);
  assert.equal(second.json.booking_id, first.json.booking_id);
});

test("invalid Retell signature is rejected", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const body = JSON.stringify({ event: "call_ended", call: { call_id: "x" } });
  const { response } = await h.request("/api/retell/webhook", {
    method: "POST",
    body,
    headers: { "x-retell-signature": "v=1,d=deadbeef" },
  });
  assert.equal(response.status, 401);
});

test("telegram formatting includes the useful call facts", () => {
  const text = formatTelegram(
    {
      call_id: "call_1",
      type: "standard",
      status: "booked",
      callerName: "Jane Miller",
      callbackNumber: "415-555-0138",
      company: null,
      brand: "Whirlpool",
      appliance: "dishwasher",
      issue: "leaking water",
      jobDetails: null,
      reason: null,
      serviceAddress: "1428 Fulton Street",
      bookingId: "FC-123",
      feeAccepted: true,
      durationMs: 90_000,
      source: "browser",
      analysisSummary: null,
    },
    { publicBaseUrl: "https://inbox.example.test" },
  );
  assert.match(text, /Jane Miller/);
  assert.match(text, /Whirlpool dishwasher/);
  assert.match(text, /FC-123/);
  assert.match(text, /Open call details/);
  assert.doesNotMatch(text, /undefined|null/);
});
