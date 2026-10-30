import "dotenv/config";
import { loadConfig } from "../src/config.mjs";
import { createPool } from "../src/db.mjs";
import { Store } from "../src/store.mjs";
import { provisionAgent } from "../src/provision.mjs";

const config = loadConfig();
const pool = createPool(config);
const store = await new Store({ pool }).init();

const state = await provisionAgent({ config, store });
console.log("");
console.log(`Agent ${state.action} and published.`);
console.log(`Agent ID: ${state.agent_id}`);
console.log(`LLM ID:   ${state.llm_id}`);
console.log(`Version:  ${state.version}`);
console.log(`Webhook:  ${state.base_url}/api/retell/webhook`);
console.log("");
console.log("Add this to your environment:");
console.log(`RETELL_AGENT_ID=${state.agent_id}`);
await pool.end();
