import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retellRequest } from "./retell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function customTool({ name, description, path: toolPath, properties, required, executionMessage }) {
  return {
    type: "custom",
    name,
    description,
    url: `${toolPath.startsWith("http") ? "" : ""}${toolPath}`,
    method: "POST",
    speak_during_execution: true,
    speak_after_execution: true,
    execution_message_description: executionMessage,
    timeout_ms: 15000,
    parameters: { type: "object", properties, required },
  };
}

// placeholder, buildTools below uses baseUrl
function buildTools(baseUrl) {
  return [
    {
      type: "end_call",
      name: "end_call",
      description:
        "End the call immediately after a warm goodbye, after a spam refusal, or when the caller is finished and has no more questions. Call this in the same turn as the final goodbye; do not leave the line open.",
    },
    customTool({
      name: "book_service_call",
      description:
        "Book a repair service request after collecting all required customer and appliance details. For standard calls, only call this after the caller clearly accepts the $99 service call fee. For warranty calls, only use when the caller said the appliance is under warranty and the brand is LG, Samsung, or General Electric. After the booking succeeds, ask if there is anything else, then give a short goodbye and call end_call.",
      path: `${baseUrl}/api/retell/tools/book-service-call`,
      executionMessage: "A short, natural line like 'Okay, give me one sec to get that in for you.'",
      properties: {
        customer_name: { type: "string", description: "Customer's full name." },
        phone_number: { type: "string", description: "Best callback number, with area code." },
        service_address: { type: "string", description: "Full service address, including city." },
        appliance_type: { type: "string", description: "Appliance type, such as refrigerator, dryer, or dishwasher." },
        appliance_brand: { type: "string", description: "Appliance brand exactly as stated by the caller." },
        issue_description: { type: "string", description: "What the appliance is doing or what is wrong." },
        is_warranty: { type: "boolean", description: "True only when the caller said the appliance is under warranty and the brand is LG, Samsung, or General Electric. Otherwise false." },
        fee_accepted: { type: "boolean", description: "True only for a standard call after the caller clearly agreed to the $99 service call fee. False for warranty calls." },
      },
      required: ["customer_name", "phone_number", "service_address", "appliance_type", "appliance_brand", "issue_description", "is_warranty", "fee_accepted"],
    }),
    customTool({
      name: "take_warranty_message",
      description: "Take a message from a home warranty company representative handing off a job. Do not book a service call and do not quote a fee.",
      path: `${baseUrl}/api/retell/tools/take-warranty-message`,
      executionMessage: "A short, natural line like 'Okay, let me get that down for the team.'",
      properties: {
        caller_name: { type: "string", description: "Representative's name." },
        company: { type: "string", description: "Home warranty company name." },
        callback_number: { type: "string", description: "Best callback number." },
        job_details: { type: "string", description: "Job details: customer name and address if provided, appliance, brand, reported problem, and any work order number." },
      },
      required: ["caller_name", "company", "callback_number", "job_details"],
    }),
    customTool({
      name: "take_message",
      description: "Take a legitimate message for the FixCall team when the call is not a repair booking or a warranty company handoff. Do not use for spam or sales calls.",
      path: `${baseUrl}/api/retell/tools/take-message`,
      executionMessage: "A short, natural line like 'Okay, let me write that down for the team.'",
      properties: {
        caller_name: { type: "string", description: "Caller's name." },
        callback_number: { type: "string", description: "Best callback number." },
        reason: { type: "string", description: "Short reason for the call." },
      },
      required: ["caller_name", "callback_number", "reason"],
    }),
  ];
}

function personaInstructions(persona) {
  const warmth = {
    warm: "Sound warm, calm, and genuinely helpful. Use natural acknowledgments such as \"I'm sorry to hear that,\" \"Got it,\" and \"Thanks.\"",
    professional: "Sound professional, clear, and efficient. Keep empathy brief and businesslike.",
    casual: "Sound relaxed and conversational, like a friendly local receptionist.",
  }[persona.warmth] || "Sound warm, calm, and genuinely helpful.";
  const focus = {
    task_focused: "Stay focused on the repair intake. Avoid small talk unless the caller starts it.",
    balanced: "Be friendly, but keep the call moving toward the needed information.",
    conversational: "Allow brief natural small talk, then gently guide back to the intake.",
  }[persona.taskFocus] || "Stay focused on the repair intake.";
  const facts = persona.businessFacts || {};
  const factsLines = Object.entries(facts)
    .filter(([, value]) => String(value || "").trim())
    .map(([key, value]) => `- ${key}: ${value}`);
  return [
    "## Persona configuration",
    warmth,
    focus,
    factsLines.length ? "Business facts you may share:" : "Only share business facts explicitly listed here; otherwise say you do not have that information.",
    ...factsLines,
    persona.promptAdditions ? `Additional instructions:\n${persona.promptAdditions}` : "",
    "If the caller asks for a human operator, explain that FixCall does not currently have live operators available, then offer to take a message or book a callback.",
  ].filter(Boolean).join("\n");
}

async function optionalRequest(config, method, endpoint, body) {
  try {
    return await retellRequest(config, method, endpoint, body);
  } catch (error) {
    if (/\(404\)/.test(error.message)) return null;
    throw error;
  }
}

export async function renderPersonaPrompt(persona = {}) {
  const basePrompt = await fs.readFile(path.join(root, "agent", "system-prompt.md"), "utf8");
  return `${basePrompt}\n\n${personaInstructions(persona)}`;
}


async function configurePhoneNumber(config, agentId, version, baseUrl) {
  const phoneNumber = (config.retellPhoneNumber || "").trim();
  if (!phoneNumber) return null;
  const agents = [{ agent_id: agentId, agent_version: version, weight: 1 }];
  return retellRequest(config, "PATCH", `/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
    inbound_agents: agents,
    outbound_agents: agents,
    nickname: "FixCall Receptionist",
  });
}

export async function provisionAgent({ config, store = null, baseUrl = null }) {
  const resolvedBaseUrl = (baseUrl || config.publicBaseUrl).replace(/\/+$/, "");
  if (!config.retellApiKey) throw new Error("RETELL_API_KEY is required");
  if (!resolvedBaseUrl.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must be a public HTTPS URL so Retell can call the tools and webhook.");
  }

  const basePrompt = await fs.readFile(path.join(root, "agent", "system-prompt.md"), "utf8");
  const agentConfig = JSON.parse(await fs.readFile(path.join(root, "agent", "agent.config.json"), "utf8"));
  const persona = store ? await store.getPersonaConfig() : {
    warmth: "warm",
    taskFocus: "task_focused",
    businessFacts: {},
    promptAdditions: "",
  };

  const prompt = `${basePrompt}\n\n${personaInstructions(persona)}`;
  const {
    llm: llmSettings,
    post_call_analysis_data: postCallAnalysisData,
    post_call_analysis_model: postCallAnalysisModel,
    analysis_summary_prompt: analysisSummaryPrompt,
    ...agentSettings
  } = agentConfig;

  const llmPayload = {
    general_prompt: prompt,
    general_tools: buildTools(resolvedBaseUrl),
    ...llmSettings,
  };
  const agentPayload = {
    ...agentSettings,
    webhook_url: `${resolvedBaseUrl}/api/retell/webhook`,
    post_call_analysis_data: postCallAnalysisData,
    post_call_analysis_model: postCallAnalysisModel,
    analysis_summary_prompt: analysisSummaryPrompt,
  };

  const lockClient = store ? await store.pool.connect() : null;
  if (lockClient) await lockClient.query("SELECT pg_advisory_lock(424242)");
  try {
  const existing = await (async () => {
    if (config.retellAgentId) {
      const agent = await optionalRequest(config, "GET", `/get-agent/${config.retellAgentId}`);
      if (agent) return agent;
    }
    let paginationKey = null;
    for (let page = 0; page < 20; page += 1) {
      const suffix = paginationKey ? `?limit=100&pagination_key=${encodeURIComponent(paginationKey)}` : "?limit=100";
      const result = await retellRequest(config, "POST", `/v2/list-agents${suffix}`, {
        filter_criteria: { channel: { type: "string", op: "eq", value: "voice" } },
      });
      const match = (result.items || []).find((agent) => agent.agent_name === "FixCall - Grace");
      if (match) return retellRequest(config, "GET", `/get-agent/${match.agent_id}`);
      if (!result.has_more) break;
      paginationKey = result.pagination_key;
    }
    return null;
  })();

  let agent;
  let llmId;
  let action;

  if (existing) {
    action = "updated";
    llmId = existing.response_engine?.llm_id;
    if (!llmId) throw new Error("Existing agent has no Retell LLM response engine");
    const baseVersion = Number(existing.version ?? 0);
    const draft = await retellRequest(config, "POST", `/create-agent-version/${existing.agent_id}`, { base_version: baseVersion });
    const draftVersion = Number(draft.version);
    await retellRequest(config, "PATCH", `/update-retell-llm/${llmId}?version=${draftVersion}`, llmPayload);
    agent = await retellRequest(config, "PATCH", `/update-agent/${existing.agent_id}?version=${draftVersion}`, {
      ...agentPayload,
      response_engine: { type: "retell-llm", llm_id: llmId, version: draftVersion },
    });
    agent = { ...draft, ...agent, version: draftVersion };
  } else {
    action = "created";
    const llm = await retellRequest(config, "POST", "/create-retell-llm", llmPayload);
    llmId = llm.llm_id;
    agent = await retellRequest(config, "POST", "/create-agent", {
      ...agentPayload,
      response_engine: { type: "retell-llm", llm_id: llmId },
    });
  }

  const version = Number(agent.version ?? 0);
  await retellRequest(config, "POST", `/publish-agent-version/${agent.agent_id}`, { version });

  let phoneConfiguration = null;
  if (config.retellPhoneNumber) {
    phoneConfiguration = await configurePhoneNumber(config, agent.agent_id, version, resolvedBaseUrl);
  }

  const state = {
    agent_id: agent.agent_id,
    llm_id: llmId,
    agent_name: agentSettings.agent_name,
    base_url: resolvedBaseUrl,
    action,
    provisioned_at: new Date().toISOString(),
    phone_number: config.retellPhoneNumber || null,
    phone_configured: Boolean(phoneConfiguration),
  };
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(path.join(config.dataDir, "retell-provisioning.json"), JSON.stringify(state, null, 2));

  if (store) {
    await store.markPersonaApplied(version);
    await store.addAudit("agent_provisioned", { agent_id: agent.agent_id, version, action, phone_number: config.retellPhoneNumber || null });
  }

  return { ...state, version };
} finally {
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(424242)");
    lockClient.release();
  }
}
}
