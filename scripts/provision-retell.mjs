import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { loadConfig } from "../src/config.mjs";
import { retellRequest } from "../src/retell.mjs";

const config = loadConfig();
const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
const root = path.resolve(import.meta.dirname, "..");

async function optionalRequest(method, endpoint, body) {
  try {
    return await retellRequest(config, method, endpoint, body);
  } catch (error) {
    if (/\(404\)/.test(error.message)) return null;
    throw error;
  }
}

function customTool({ name, description, path: toolPath, properties, required, executionMessage }) {
  return {
    type: "custom",
    name,
    description,
    url: `${baseUrl}${toolPath}`,
    method: "POST",
    speak_during_execution: true,
    speak_after_execution: true,
    execution_message_description: executionMessage,
    timeout_ms: 15000,
    parameters: {
      type: "object",
      properties,
      required,
    },
  };
}

function buildTools() {
  return [
    {
      type: "end_call",
      name: "end_call",
      description:
        "End the call after a warm goodbye, after a spam refusal, or when the caller is finished and has no more questions.",
    },
    customTool({
      name: "book_service_call",
      description:
        "Book a repair service request after collecting all required customer and appliance details. For standard calls, only call this after the caller clearly accepts the $99 service call fee. For warranty calls, only use when the caller said the appliance is under warranty and the brand is LG, Samsung, or General Electric.",
      path: "/api/retell/tools/book-service-call",
      executionMessage:
        "A short, natural line like 'Okay, give me one sec to get that in for you.'",
      properties: {
        customer_name: {
          type: "string",
          description: "Customer's full name.",
        },
        phone_number: {
          type: "string",
          description: "Best callback number, with area code.",
        },
        service_address: {
          type: "string",
          description: "Full service address, including city.",
        },
        appliance_type: {
          type: "string",
          description: "Appliance type, such as refrigerator, dryer, or dishwasher.",
        },
        appliance_brand: {
          type: "string",
          description: "Appliance brand exactly as stated by the caller.",
        },
        issue_description: {
          type: "string",
          description: "What the appliance is doing or what is wrong.",
        },
        is_warranty: {
          type: "boolean",
          description:
            "True only when the caller said the appliance is under warranty and the brand is LG, Samsung, or General Electric. Otherwise false.",
        },
        fee_accepted: {
          type: "boolean",
          description:
            "True only for a standard call after the caller clearly agreed to the $99 service call fee. False for warranty calls.",
        },
      },
      required: [
        "customer_name",
        "phone_number",
        "service_address",
        "appliance_type",
        "appliance_brand",
        "issue_description",
        "is_warranty",
        "fee_accepted",
      ],
    }),
    customTool({
      name: "take_warranty_message",
      description:
        "Take a message from a home warranty company representative handing off a job. Do not book a service call and do not quote a fee.",
      path: "/api/retell/tools/take-warranty-message",
      executionMessage:
        "A short, natural line like 'Okay, let me get that down for the team.'",
      properties: {
        caller_name: {
          type: "string",
          description: "Representative's name.",
        },
        company: {
          type: "string",
          description: "Home warranty company name.",
        },
        callback_number: {
          type: "string",
          description: "Best callback number.",
        },
        job_details: {
          type: "string",
          description:
            "Job details: customer name and address if provided, appliance, brand, reported problem, and any work order number.",
        },
      },
      required: ["caller_name", "company", "callback_number", "job_details"],
    }),
    customTool({
      name: "take_message",
      description:
        "Take a legitimate message for the FixCall team when the call is not a repair booking or a warranty company handoff. Do not use for spam or sales calls.",
      path: "/api/retell/tools/take-message",
      executionMessage:
        "A short, natural line like 'Okay, let me write that down for the team.'",
      properties: {
        caller_name: {
          type: "string",
          description: "Caller's name.",
        },
        callback_number: {
          type: "string",
          description: "Best callback number.",
        },
        reason: {
          type: "string",
          description: "Short reason for the call.",
        },
      },
      required: ["caller_name", "callback_number", "reason"],
    }),
  ];
}

async function findExistingAgent() {
  if (config.retellAgentId) {
    const agent = await optionalRequest(
      "GET",
      `/get-agent/${config.retellAgentId}`,
    );
    if (agent) return agent;
    console.warn(
      `RETELL_AGENT_ID ${config.retellAgentId} was not found; looking up by name.`,
    );
  }
  let paginationKey = null;
  for (let page = 0; page < 20; page += 1) {
    const suffix = paginationKey
      ? `?limit=100&pagination_key=${encodeURIComponent(paginationKey)}`
      : "?limit=100";
    const result = await retellRequest(
      config,
      "POST",
      `/v2/list-agents${suffix}`,
      { filter_criteria: { channel: { type: "string", op: "eq", value: "voice" } } },
    );
    const match = (result.items || []).find(
      (agent) => agent.agent_name === "FixCall - Grace",
    );
    if (match) {
      return retellRequest(config, "GET", `/get-agent/${match.agent_id}`);
    }
    if (!result.has_more) break;
    paginationKey = result.pagination_key;
  }
  return null;
}

async function main() {
  if (!config.retellApiKey) throw new Error("RETELL_API_KEY is required");
  if (!baseUrl.startsWith("https://")) {
    throw new Error(
      "PUBLIC_BASE_URL must be a public HTTPS URL so Retell can call the tools and webhook.",
    );
  }

  const prompt = await fs.readFile(
    path.join(root, "agent", "system-prompt.md"),
    "utf8",
  );
  const agentConfig = JSON.parse(
    await fs.readFile(path.join(root, "agent", "agent.config.json"), "utf8"),
  );
  const {
    llm: llmSettings,
    post_call_analysis_data: postCallAnalysisData,
    post_call_analysis_model: postCallAnalysisModel,
    analysis_summary_prompt: analysisSummaryPrompt,
    ...agentSettings
  } = agentConfig;

  const llmPayload = {
    general_prompt: prompt,
    general_tools: buildTools(),
    ...llmSettings,
  };
  const agentPayload = {
    ...agentSettings,
    webhook_url: `${baseUrl}/api/retell/webhook`,
    post_call_analysis_data: postCallAnalysisData,
    post_call_analysis_model: postCallAnalysisModel,
    analysis_summary_prompt: analysisSummaryPrompt,
  };

  const existing = await findExistingAgent();
  let agent;
  let llmId;
  let action;

  if (existing) {
    action = "updated";
    llmId = existing.response_engine?.llm_id;
    if (!llmId) {
      throw new Error("Existing agent has no Retell LLM response engine");
    }
    console.log(`Updating agent ${existing.agent_id} / LLM ${llmId}`);
    await retellRequest(
      config,
      "PATCH",
      `/update-retell-llm/${llmId}`,
      llmPayload,
    );
    agent = await retellRequest(
      config,
      "PATCH",
      `/update-agent/${existing.agent_id}`,
      agentPayload,
    );
  } else {
    action = "created";
    console.log("Creating a new Retell LLM and voice agent");
    const llm = await retellRequest(
      config,
      "POST",
      "/create-retell-llm",
      llmPayload,
    );
    llmId = llm.llm_id;
    agent = await retellRequest(config, "POST", "/create-agent", {
      ...agentPayload,
      response_engine: { type: "retell-llm", llm_id: llmId },
    });
  }

  const version = Number(agent.version ?? 0);
  await retellRequest(
    config,
    "POST",
    `/publish-agent-version/${agent.agent_id}`,
    { version },
  );

  const state = {
    agent_id: agent.agent_id,
    llm_id: llmId,
    agent_name: agentSettings.agent_name,
    base_url: baseUrl,
    action,
    provisioned_at: new Date().toISOString(),
  };
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(
    path.join(config.dataDir, "retell-provisioning.json"),
    JSON.stringify(state, null, 2),
  );

  console.log("");
  console.log(`Agent ${action} and published.`);
  console.log(`Agent ID: ${agent.agent_id}`);
  console.log(`LLM ID:   ${llmId}`);
  console.log(`Webhook:  ${baseUrl}/api/retell/webhook`);
  console.log("");
  console.log("Add this to your environment:");
  console.log(`RETELL_AGENT_ID=${agent.agent_id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
