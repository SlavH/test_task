import "dotenv/config";
import { loadConfig } from "../src/config.mjs";
import { buildNotification } from "../src/domain.mjs";
import { Store } from "../src/store.mjs";

const config = loadConfig();
const store = await new Store({ dataDir: config.dataDir }).init();

const now = Date.now();
const minute = 60_000;

const demos = [
  {
    call_id: "demo-standard-miller",
    minutesAgo: 7,
    duration: 186_000,
    caller: "Jane Miller",
    phone: "(415) 555-0138",
    address: "1428 Fulton Street, San Francisco, CA 94117",
    brand: "Whirlpool",
    appliance: "dishwasher",
    issue: "water pooling at the bottom and not draining",
    type: "standard",
    status: "booked",
    feeAccepted: true,
    language: [
      ["agent", "Thanks for calling FixCall Appliance Repair, this is Grace. How can I help?"],
      ["user", "Hi, my dishwasher is leaking water all over the kitchen floor."],
      ["agent", "Oh no, I'm sorry to hear that. What brand is the dishwasher?"],
      ["user", "It's a Whirlpool."],
      ["agent", "Got it, a Whirlpool. Is it not draining at all, or is the water coming from somewhere else?"],
      ["user", "There's standing water in the bottom and it won't drain."],
      ["agent", "Okay. Can I get your full name and the best number to call you back?"],
      ["user", "Jane Miller. 415-555-0138."],
      ["agent", "And the service address?"],
      ["user", "1428 Fulton Street, San Francisco."],
      ["agent", "Perfect. There's a $99 service call fee for the visit. Does that work for you?"],
      ["user", "Yes, that's fine."],
      ["agent", "Great, let me get that in for you."],
      ["agent", "You're all set, Jane. The office will call you to confirm the appointment time."],
      ["user", "Thank you."],
      ["agent", "You're welcome. Have a good day."],
    ],
    summary:
      "Whirlpool dishwasher with standing water and a draining failure. Standard service call booked with the $99 fee accepted.",
    analysis:
      "Jane Miller called about a Whirlpool dishwasher that is not draining and has standing water in the bottom. She accepted the $99 service call fee and a service request was booked for the San Francisco address.",
  },
  {
    call_id: "demo-warranty-chen",
    minutesAgo: 42,
    duration: 224_000,
    caller: "Marcus Chen",
    phone: "(510) 555-0194",
    address: "88 Bayview Drive, Oakland, CA 94607",
    brand: "Samsung",
    appliance: "refrigerator",
    issue: "freezer is cold but the refrigerator side is warm",
    type: "warranty",
    status: "booked",
    feeAccepted: null,
    language: [
      ["agent", "Thanks for calling FixCall Appliance Repair, this is Grace. How can I help?"],
      ["user", "My Samsung fridge isn't cooling. The freezer is fine but the bottom is warm."],
      ["agent", "I'm sorry, that's frustrating. Is the refrigerator still under warranty?"],
      ["user", "Yes, it's covered under my home warranty."],
      ["agent", "Okay. Since it's a Samsung, that's one of the brands we cover for warranty work. There's no service call fee for this."],
      ["user", "Great."],
      ["agent", "Can I get your full name, best callback number, and the service address?"],
      ["user", "Marcus Chen, 510-555-0194. 88 Bayview Drive in Oakland."],
      ["agent", "Let me read that back: Marcus Chen, 510-555-0194, 88 Bayview Drive, Oakland. Is that right?"],
      ["user", "Yes."],
      ["agent", "Okay, let me get the warranty request in."],
      ["agent", "You're all set. The office will call you to confirm the appointment time."],
      ["user", "Perfect, thanks."],
      ["agent", "You're welcome. Goodbye."],
    ],
    summary:
      "Samsung refrigerator not cooling on the fresh-food side. Covered warranty service request booked with no fee.",
    analysis:
      "Marcus Chen called about a Samsung refrigerator that is warm on the refrigerator side while the freezer still works. He confirmed it is under warranty. The Samsung brand is covered, so a warranty service request was booked with no service fee.",
  },
  {
    call_id: "demo-warranty-rep",
    minutesAgo: 128,
    duration: 141_000,
    caller: "Denise Walker",
    phone: "(800) 555-0117",
    company: "American Home Shield",
    brand: "GE",
    appliance: "oven",
    issue: "oven will not heat; customer reports no error code",
    type: "warranty_company",
    status: "message_taken",
    language: [
      ["agent", "Thanks for calling FixCall Appliance Repair, this is Grace. How can I help?"],
      ["user", "Hi, this is Denise from American Home Shield. I'm calling in a work order."],
      ["agent", "Hi Denise. I can take the details for the team. What's the best callback number for you?"],
      ["user", "800-555-0117, extension 204."],
      ["agent", "And what's the job?"],
      ["user", "It's a GE wall oven, work order 4482190. The customer says it won't heat at all. No error code."],
      ["agent", "Do you have the customer name and address?"],
      ["user", "Elena Ruiz, 2210 Cedar Avenue, San Leandro."],
      ["agent", "Okay, I have the work order, the GE oven, and the callback number. I'll get that to the team."],
      ["user", "Thanks. They should call the customer to schedule."],
      ["agent", "Understood. The team will call you back if they need anything else. Have a good day."],
    ],
    summary:
      "American Home Shield work order for a GE wall oven that will not heat. Message taken for the office; no service call booked.",
    analysis:
      "Denise Walker from American Home Shield called with work order 4482190 for Elena Ruiz at 2210 Cedar Avenue in San Leandro. The GE wall oven will not heat and there is no error code. A warranty company message was taken for the office.",
  },
  {
    call_id: "demo-spam-solar",
    minutesAgo: 305,
    duration: 22_000,
    caller: "Unknown caller",
    phone: "(888) 555-0166",
    type: "spam",
    status: "spam",
    language: [
      ["agent", "Thanks for calling FixCall Appliance Repair, this is Grace. How can I help?"],
      ["user", "Hi, I'm calling about a limited-time solar incentive for your business."],
      ["agent", "Sorry, I can't help with that."],
      ["agent", "Goodbye."],
    ],
    summary: "Solar sales robocall. No service request was taken.",
    analysis:
      "A caller pitched a limited-time solar incentive. The receptionist declined and ended the call. No service request was taken.",
  },
  {
    call_id: "demo-declined-priya",
    minutesAgo: 1515,
    duration: 97_000,
    caller: "Priya Shah",
    phone: "(650) 555-0129",
    address: "711 Laurel Street, San Mateo, CA 94401",
    brand: "Maytag",
    appliance: "dryer",
    issue: "takes two cycles to dry a normal load",
    type: "standard",
    status: "declined_fee",
    feeAccepted: false,
    language: [
      ["agent", "Thanks for calling FixCall Appliance Repair, this is Grace. How can I help?"],
      ["user", "My dryer is taking forever to dry clothes. It's a Maytag."],
      ["agent", "How many cycles does it usually take now?"],
      ["user", "Two or three. It used to be one."],
      ["agent", "Okay. I can get your name, number, and address, but I should mention there's a $99 service call fee for the visit."],
      ["user", "Oh, I was hoping for a free estimate. That's more than I wanted to spend."],
      ["agent", "I understand. The $99 is the service call fee, and the technician would go over any repair cost after diagnosing it. Would you like to go ahead?"],
      ["user", "No, not right now. Thanks anyway."],
      ["agent", "No problem. Thanks for calling, and have a good day."],
    ],
    summary:
      "Maytag dryer taking multiple cycles to dry. Caller declined the $99 service call fee, so no service request was booked.",
    analysis:
      "Priya Shah called about a Maytag dryer that takes two or three cycles to dry a load. She declined the $99 service call fee, so no booking was made.",
  },
];

for (const demo of demos) {
  const started = now - demo.minutesAgo * minute - demo.duration;
  const ended = now - demo.minutesAgo * minute;
  const callerName = demo.caller;
  const transcript = demo.language.map(([role, content]) => ({ role, content }));
  const call = {
    call_id: demo.call_id,
    call_type: "web_call",
    from_number: demo.phone,
    start_timestamp: started,
    end_timestamp: ended,
    disconnection_reason: "user_hangup",
    transcript_object: transcript,
    metadata: { source: "demo" },
    call_analysis: {
      call_summary: demo.analysis,
      custom_analysis_data: {
        call_summary: demo.analysis,
        call_type: demo.type,
        caller_name: demo.caller,
        callback_number: demo.phone,
        company_name: demo.company || null,
        service_address: demo.address || null,
        appliance_type: demo.appliance || null,
        brand: demo.brand || null,
        issue_description: demo.issue || null,
        service_fee_accepted:
          demo.feeAccepted === undefined ? null : demo.feeAccepted,
        booked: demo.status === "booked",
      },
    },
  };
  const booking =
    demo.status === "booked"
      ? {
          booking_id: `FC-DEMO-${demo.call_id.slice(-4).toUpperCase()}`,
          call_id: demo.call_id,
          customer_name: demo.caller,
          phone_number: demo.phone,
          service_address: demo.address,
          appliance_type: demo.appliance,
          appliance_brand: demo.brand,
          issue_description: demo.issue,
          is_warranty: demo.type === "warranty",
          fee_accepted: demo.type === "warranty" ? false : demo.feeAccepted,
          status: "booked",
          created_at: new Date(ended).toISOString(),
        }
      : null;
  const message =
    demo.type === "warranty_company"
      ? {
          message_id: `WM-DEMO`,
          call_id: demo.call_id,
          kind: "warranty_company",
          caller_name: demo.caller,
          company: demo.company,
          callback_number: demo.phone,
          job_details: demo.issue,
          created_at: new Date(ended).toISOString(),
        }
      : null;
  const notification = buildNotification({
    call,
    records: booking
      ? [{ kind: "booking", ok: true, record: booking }]
      : message
        ? [{ kind: "warranty_company", ok: true, record: message }]
        : [],
    booking,
    message,
    now: new Date(ended),
  });
  notification.call_id = demo.call_id;
  notification.callerName = callerName;
  notification.summary = demo.summary;
  notification.analysisSummary = demo.analysis;
  notification.source = "demo";
  notification.createdAt = new Date(ended).toISOString();
  notification.updatedAt = new Date(ended).toISOString();
  notification.telegramStatus = "skipped";
  await store.saveNotification(notification);
}

console.log(`Seeded ${demos.length} demo calls into ${store.filePath}`);
