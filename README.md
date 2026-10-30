# FixCall AI Receptionist

A production-shaped AI phone receptionist for **FixCall Appliance Repair**, with a Telegram-style call inbox for the office.

The agent is **Grace**. She handles standard repair calls, covered warranty calls, home warranty company handoffs, and spam. After every call, she writes a structured summary to the inbox and sends the same summary to Telegram.

## What is included

- Retell voice agent prompt, tools, voice settings, and post-call analysis.
- Server-side guardrails for the $99 fee and warranty brand rules.
- Retell custom tool endpoints and signed webhook handling.
- Telegram notifications with call type, caller, callback number, issue, address, booking ID, and dashboard link.
- A protected call inbox with live updates, search, filters, transcript viewer, and browser voice demo.
- JSON persistence on a Render persistent disk.
- Docker and Render Blueprint deployment.
- Tests for booking, fee enforcement, warranty rules, warranty reps, spam, signatures, auth, and notifications.

## Call handling rules

| Caller | Intake | Fee | Outcome |
| --- | --- | --- | --- |
| Standard repair | Appliance, brand, issue, name, callback, address | **$99**, must be clearly accepted | `book_service_call` |
| Warranty customer | Same intake, only if caller raises warranty | Waived for **LG, Samsung, GE** | `book_service_call` with `is_warranty: true` |
| Non-covered warranty brand | Treated as standard repair | **$99**, must be accepted | Standard booking, never warranty |
| Warranty company rep | Name, company, callback, job details | No fee | `take_warranty_message` |
| Spam / sales | None | None | Brief refusal and `end_call` |

The agent never asks every caller whether the appliance is under warranty. Warranty comes up only if the caller brings it up.

The booking function is idempotent per call. A caller is never told they are booked unless the server returns `ok: true`.

## Architecture

```
Caller / browser
      |
      v
Retell voice agent (Grace)
      |  custom tools + signed webhooks
      v
Node 22 / Express server
      |-- server-side fee + warranty validation
      |-- JSON store (Render persistent disk)
      |-- Telegram Bot API
      |-- SSE live feed
      v
Protected inbox UI
```

The server does not trust the model for money or warranty decisions. Before saving a standard booking, it checks the actual call transcript for a $99 fee quote and a clear affirmative response. Before saving a warranty booking, it checks that the transcript mentions a warranty and the brand is LG, Samsung, or GE.

This is an intake system, not a scheduling calendar. The agent tells callers the office will call to confirm the appointment time; it never promises a time slot.

## Quick start

```bash
npm install
cp .env.example .env
npm run build
npm run seed:demo   # optional local demo cards
npm start
```

Open `http://localhost:3000`. If `DASHBOARD_PASSWORD` is empty, local access is unprotected.

Run the checks:

```bash
npm run check
npm test
```

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `RETELL_API_KEY` | Yes | Retell server API key. Never expose to the browser. |
| `RETELL_AGENT_ID` | Yes | Agent created by `npm run provision`. |
| `PUBLIC_BASE_URL` | Production | Public HTTPS URL for tools, webhook, and Telegram links. Falls back to `RENDER_EXTERNAL_URL`. |
| `TELEGRAM_BOT_TOKEN` | For notifications | Telegram bot token. |
| `TELEGRAM_CHAT_ID` | For notifications | Target chat or user ID. |
| `DASHBOARD_USER` | No | Basic auth user. Defaults to `admin`. |
| `DASHBOARD_PASSWORD` | Production | Protects the inbox and browser demo API. |
| `DATA_DIR` | No | Store directory. Render uses `/var/data`. |
| `ALLOW_UNSIGNED_RETELL` | No | Local testing only. Must stay `false` in production. |
| `WEB_CALL_RATE_LIMIT` | No | Browser demo calls per IP per minute. Defaults to `5`. |
| `COMPANY_NAME` | No | Used in UI and Telegram. |
| `TIMEZONE` | No | Display timezone for the inbox. |

The server verifies `X-Retell-Signature` using the raw request body and `RETELL_API_KEY`. Requests with missing, stale, or invalid signatures are rejected.

## Provisioning Retell

Retell must be able to reach the server over public HTTPS before the tools and webhook can be tested.

If you do not have a deployment yet, use a temporary tunnel:

```bash
# terminal 1
npm start

# terminal 2 (requires cloudflared)
cloudflared tunnel --url http://localhost:3000
```

Use the generated `https://...trycloudflare.com` URL:

```bash
PUBLIC_BASE_URL=https://your-tunnel.trycloudflare.com npm run provision
```

The script creates a new agent named **FixCall - Grace**, publishes it, and prints:

```text
RETELL_AGENT_ID=agent_...
```

Add that value to `.env`. Re-running the script updates the same agent instead of creating duplicates.

The provisioned agent uses:

- Voice: ElevenLabs **Grace**, American female, middle-aged.
- Speed: 0.97 with dynamic speed.
- Responsiveness: 0.82.
- Interruption sensitivity: 0.88.
- Backchannels enabled.
- Noise cancellation.
- Boosted appliance, brand, and warranty vocabulary.
- Webhook events: `call_ended`, `call_analyzed`.
- Post-call analysis fields for call type, caller, callback, company, address, appliance, brand, issue, fee acceptance, booking status, and summary.

The existing **Appliance Repair Receptionist** agent in the Retell account is not modified.

## Deploying to Render

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository. `render.yaml` creates the Docker web service, a 1 GB persistent disk at `/var/data`, and a generated dashboard password.
3. Set the secret environment variables in Render: `RETELL_API_KEY`, `RETELL_AGENT_ID`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`.
4. Wait for the first deploy. Copy the service URL, for example `https://fixcall-inbox.onrender.com`.
5. Set `PUBLIC_BASE_URL` in Render to that URL.
6. Point the Retell agent at the deployed server:

```bash
PUBLIC_BASE_URL=https://fixcall-inbox.onrender.com \
RETELL_AGENT_ID=agent_your_agent_id \
npm run provision
```

This updates the tool URLs and webhook to the permanent Render URL and publishes the agent again.

The `starter` plan is used because persistent disks are not available on Render's free instances. The service is intentionally single-instance because the JSON store and SSE clients are process-local.

## Browser voice demo

The **Test the voice agent** button starts a real Retell web call from the browser.

- The API key stays on the server.
- `POST /api/web-call` creates the web call with the server-side key.
- The browser SDK connects with the short-lived access token.
- Browser calls are rate-limited per IP.
- The inbox updates when Retell sends `call_ended` and `call_analyzed`.

No phone number was purchased. To move to real inbound calls, buy or port a number in Retell, attach it to the agent, and keep the same webhook and tool URLs.

## Data and privacy

The JSON store is written atomically to `DATA_DIR/state.json`. It contains caller names, callback numbers, addresses, issue descriptions, transcripts, and booking IDs. The inbox is protected by Basic auth. Do not expose `DATA_DIR` or the dashboard without a password.

Call recordings are linked only when Retell returns a recording URL. Access to Retell recordings is still controlled by Retell.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Health check. |
| `GET /api/notifications` | Feed data with filters and stats. |
| `GET /api/notifications/:callId` | One call. |
| `GET /api/events` | SSE live updates. |
| `POST /api/web-call` | Create a browser web call. |
| `POST /api/retell/tools/book-service-call` | Signed custom tool. |
| `POST /api/retell/tools/take-warranty-message` | Signed custom tool. |
| `POST /api/retell/tools/take-message` | Signed custom tool. |
| `POST /api/retell/webhook` | Signed Retell call webhook. |
| `ALL /api/retell-proxy/*` | Same-origin WebRTC signaling proxy for the browser SDK. |

## Local demo data

`npm run seed:demo` adds five clearly labeled `Demo` cards. Demo data is stored in `DATA_DIR` and is not committed. Remove `data/state.json` to reset local state.
