import "dotenv/config";
import { loadConfig } from "../src/config.mjs";
import { retellRequest } from "../src/retell.mjs";

const config = loadConfig();
const agentId = config.retellAgentId;
if (!agentId) throw new Error("RETELL_AGENT_ID is required");

const scenarios = {
  standard: [
    "Hi, my Whirlpool dishwasher is leaking water onto the floor.",
    "Whirlpool.",
    "Jane Miller. 415-555-0138.",
    "1428 Fulton Street, San Francisco.",
    "Yes, that's correct.",
    "Yes, the $99 service call fee is fine.",
    "No, that's everything.",
  ],
  warranty: [
    "My Samsung refrigerator is warm on the bottom and it's still under warranty.",
    "Marcus Chen. 510-555-0194.",
    "88 Bayview Drive, Oakland.",
    "Yes, that's correct.",
    "No, thank you.",
  ],
  warranty_company: [
    "Hi, this is Denise from American Home Shield calling in a work order.",
    "Denise Walker, callback 800-555-0117.",
    "GE wall oven, work order 4482190. Customer Elena Ruiz at 2210 Cedar Avenue in San Leandro. The oven won't heat.",
    "That's everything, thanks.",
  ],
  spam: [
    "I'm calling about a limited-time solar incentive for your business.",
  ],
};

const name = process.argv[2] || "standard";
const lines = scenarios[name];
if (!lines) {
  throw new Error(
    `Unknown scenario "${name}". Choose one of: ${Object.keys(scenarios).join(", ")}`,
  );
}

const messages = [];
let ended = false;
for (const line of lines) {
  if (ended) break;
  messages.push({ role: "user", content: line });
  console.log(`\nCaller: ${line}`);
  const result = await retellRequest(
    config,
    "POST",
    `/agent-playground-completion/${agentId}`,
    { messages },
  );
  const generated = result.messages || [];
  for (const message of generated) {
    messages.push(message);
    if (message.role === "agent") {
      console.log(`Grace: ${message.content}`);
    } else if (message.role === "tool_call_invocation") {
      console.log(
        `  [tool] ${message.name} ${message.arguments || ""}`.trim(),
      );
    } else if (message.role === "tool_call_result") {
      console.log(
        `  [tool result] ${String(message.content || "").slice(0, 500)}`,
      );
    }
  }
  if (result.call_ended) ended = true;
}

console.log(
  `\nSimulation finished${ended ? " (agent ended the call)" : ""}. This playground run does not create a Retell call webhook.`,
);
