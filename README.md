# FixCall AI Receptionist

A production-shaped AI phone receptionist for **FixCall Appliance Repair**, with a Telegram-style call inbox for the office.

The agent is **Grace**. She handles standard repair calls, covered warranty calls, home warranty company handoffs, and spam. After every call, she writes a structured summary to the inbox and sends the same summary to Telegram.

## What is included

- Retell voice agent prompt, tools, voice settings, and post-call analysis.
- Server-side guardrails for the $99 fee and warranty brand rules.
- Retell custom tool endpoints and signed webhook handling.
- Telegram notifications with call type, caller, callback number, issue, address, booking ID, and dashboard link.
- A protected call inbox with live updates, search, filters, transcript viewer, browser voice demo, admin notes/tags, and CSV/JSON export.
- PostgreSQL persistence with migrations.
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

Open `http://localhost:3000`. Sign in with the configured admin password when one is set.

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
| `RETELL_PHONE_NUMBER` | For phone calls | Retell phone number to bind to the latest agent version during provisioning. |
| `PUBLIC_BASE_URL` | Production | Public HTTPS URL for tools, webhook, and Telegram links. Falls back to `RENDER_EXTERNAL_URL`. |
| `DATABASE_URL` | Yes | PostgreSQL connection string (pooled). |
| `MIGRATION_DATABASE_URL` | No | Direct/non-pooling connection used by `npm run migrate`. Falls back to `DATABASE_URL`. |
| `TELEGRAM_BOT_TOKEN` | For notifications | Telegram bot token. |
| `TELEGRAM_CHAT_ID` | For notifications | Target chat or user ID(s). Can be comma- or space-separated for multiple recipients. Also supports `/start` subscriptions. |
| `TELEGRAM_WEBHOOK_SECRET` | No | Secret token for `POST /api/telegram/webhook` (set via `setWebhook` with `secret_token`). |
| `DASHBOARD_PASSWORD` | Production | Shared admin password. Leave empty for local development to disable auth. |
| `ADMIN_SESSION_SECRET` | Production | Secret used to sign admin sessions. Falls back to `DASHBOARD_PASSWORD`. |
| `DASHBOARD_TITLE` | No | Inbox title. Defaults to `FixCall Inbox`. |
| `DASHBOARD_USER` | No | Admin username label. Defaults to `admin`. |
| `DATA_DIR` | No | Legacy data directory (unused in Postgres mode). |
| `ALLOW_UNSIGNED_RETELL` | No | Local testing only. Must stay `false` in production. |
| `WEB_CALL_RATE_LIMIT` | No | Browser demo calls per IP per minute. Defaults to `5`. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | No | Optional Upstash Redis for distributed rate limiting. |
| `FINALIZE_ORPHANS` | No | Reconcile orphaned calls on startup. Defaults to `true`. |
| `RETELL_API_BASE` | No | Retell API base URL. Defaults to `https://api.retellai.com`. |
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

A Retell phone number is now attached to Grace for inbound and outbound calls: **(833) 593-4831** (`+18335934831`). Keep the same webhook and tool URLs when reprovisioning so the number stays bound to the latest agent version.



## Deploying to Vercel

1. Create a Supabase project and copy both the pooled and direct connection strings.
2. Add the environment variables listed above in Vercel.
3. Set `PUBLIC_BASE_URL` to the Vercel production URL.
4. Deploy. Vercel runs `npm run build && npm run migrate`.
5. For Retell, set `RETELL_PHONE_NUMBER` and run `PUBLIC_BASE_URL=https://your-app.vercel.app npm run provision` locally.
6. The browser inbox uses 5-second polling instead of SSE for Vercel compatibility.

Use Vercel Pro if you need the 60-second function limit for admin provisioning. On Hobby, run provisioning locally against the production URL.

## Data and privacy

Data is stored in PostgreSQL (calls, bookings, messages, notifications, notes, tags, persona config, audit logs). Admin access uses signed sessions with CSRF protection. Store PostgreSQL credentials and admin secrets in environment variables only.

Call recordings are linked only when Retell returns a recording URL. Access to Retell recordings is still controlled by Retell.

## Admin features

- **Auth**: Password-protected admin login with signed sessions and CSRF tokens. Auth can be disabled in local dev by leaving `DASHBOARD_PASSWORD` empty.
- **Notes & tags**: Add internal notes and tags to calls for follow-up tracking.
- **Export**: Download call history as JSON via `GET /api/admin/export`.
- **Persona settings**: Tune Grace’s warmth/task focus, add business facts/prompt additions, preview the full prompt, and apply updates directly to the Retell agent.
- **Telegram resend**: Manually resend or refresh Telegram notifications for a call.

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
| `POST /api/telegram/webhook` | Telegram Bot updates webhook (handles `/start` and `/stop` subscriptions). |
| `ALL /api/retell-proxy/*` | Same-origin WebRTC signaling proxy for the browser SDK. |
| `GET /api/auth/status` | Admin auth status. |
| `POST /api/auth/login` | Admin login. |
| `POST /api/auth/logout` | Admin logout. |
| `GET /api/auth/csrf` | Get CSRF token. |
| `GET /api/admin/persona` | Get persona config (admin). |
| `PUT /api/admin/persona` | Update persona config (admin, CSRF). |
| `POST /api/admin/persona/preview` | Preview persona prompt (admin, CSRF). |
| `POST /api/admin/persona/apply` | Apply persona to Retell agent (admin, CSRF). |
| `GET /api/admin/status` | Admin provisioning status. |
| `GET /api/admin/export` | Export all data as JSON (admin). |
| `GET /api/admin/calls/:callId/notes` | List notes (admin). |
| `POST /api/admin/calls/:callId/notes` | Add note (admin, CSRF). |
| `POST /api/admin/calls/:callId/tags` | Add tag (admin, CSRF). |
| `DELETE /api/admin/calls/:callId/tags/:tag` | Remove tag (admin, CSRF). |
| `POST /api/admin/calls/:callId/resend-telegram` | Resend Telegram notification (admin, CSRF). |

## Local demo data

`npm run seed:demo` adds five clearly labeled `Demo` cards. Demo data is stored in `DATA_DIR` and is not committed. Remove `data/state.json` to reset local state.
