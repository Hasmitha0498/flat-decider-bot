# Flat Decider

A Telegram bot that helps a small group of friends (2–6 people) agree on a shared flat.

## What it solves

This is a **multi-person constraint alignment and tradeoff tool**, not an apartment discovery product.

Friends looking for a flat together usually have plenty of listings. What they lack is a shared picture of what "good" means. One person cares about commute, one needs a lift, one wants to be near family, and their budgets differ. Today someone shares a listing on WhatsApp, everyone evaluates it, and only then do hidden dealbreakers come out. Repeat for months.

Flat Decider fixes that decision process:

1. **Each person privately enters their requirements.** For every criterion the bot asks *what* they want and, separately, *how important* it is (Must have / Prefer / No preference).
2. **Everyone adds the listings they have already found**, as links, with pasted text as a fallback.
3. **`/compare` checks every flat against everyone's requirements** and returns the strongest 3 options with transparent, per-person tradeoffs.

The bot does **not** search for flats. Users bring the listings. The bot answers one question: *"Out of the flats we already found, which ones actually work for all of us?"*

## Architecture

```text
Telegram (user chats, inline buttons)
   ↓  webhook
Application (Vercel serverless function, TypeScript)
   ↓
Supabase memory (groups, members, structured preferences, listings, extractions, runs)
   ↓
Gemini (1. extract listing facts  2. normalise free-text requirements  3. explain tradeoffs)
   ↓
Matching logic (deterministic code: hard rules → preference % → balanced ranking)
   ↓
Telegram shortlist
```

```text
api/telegram.ts             Vercel webhook: verifies secret, answers 200 at once, processes in background
src/
  types.ts                  Domain types (criteria, importance, match states, listing facts)
  config.ts                 Env vars and limits
  matching/                 PURE business logic: no Telegram, no Gemini, no database
    criteria.ts             Evaluate one person × one criterion × one flat → match/fail/unknown/not_relevant
    rank.ts                 Hard-rule qualification, preference %, balanced ranking, shortlist
    describe.ts             Human-readable names/values
  gemini/                   All Gemini calls (official @google/genai SDK), JSON-schema output only
    client.ts               generateJson(): schema → call → zod-validate → retry with backoff + fallback model → error
    extractListing.ts       Job 1 (+ evidence-backed custom checks) and the anti-hallucination filter
    normalizeRequirement.ts Job 2: free text → yes/no check
    explainTradeoffs.ts     Job 3: explains the finished result (template fallback if Gemini fails)
  listings/                 URL validation/normalisation and safe page fetching
  db/                       Supabase client + every query (repo.ts)
  bot/                      Telegram UX only: router, questionnaire, commands, message formatting
  demo/                     Demo data, seeder and the /demo command (isolated; not used by production logic)
scripts/                    Local polling, webhook setup, demo seeding
supabase/                   SQL migration + optional scripts
tests/                      Matching, extraction safety, formatting, full conversation flow
```

The most important business logic (`src/matching`) can be tested without Telegram or Gemini.

## Setup

### 1. Create the Telegram bot
1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a name and a username ending in `bot`.
3. BotFather replies with a token like `123456:ABC...`. That is your `TELEGRAM_BOT_TOKEN`.

### 2. Add the Telegram bot token
```bash
cp .env.example .env
```
Put the token in `.env` as `TELEGRAM_BOT_TOKEN=...`. `.env` is git-ignored and must never be committed.

### 3. Create a Supabase project
1. Go to <https://supabase.com> → **New project**.
2. In **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (recommended, see below)

### 4. Run the SQL migrations
In Supabase open **SQL Editor → New query**, and run these files in order, pasting each one and clicking **Run**:
1. [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql)
2. [`supabase/migrations/002_persistent_membership.sql`](supabase/migrations/002_persistent_membership.sql)

Both are safe to run again.

#### Supabase keys
The migration turns on Row Level Security with no policies, so only the **service role key** can access the tables. That is the recommended setup: the key lives only in server environment variables, and this app has no browser frontend.

If you want to use only `SUPABASE_ANON_KEY`, also run [`supabase/optional_anon_key_access.sql`](supabase/optional_anon_key_access.sql). It grants the anon role access to the bot's tables. That is acceptable here only because the anon key never leaves the server, so don't publish it.

The code uses `SUPABASE_SERVICE_ROLE_KEY` if it is set and falls back to `SUPABASE_ANON_KEY` otherwise.

### 5. Get the Gemini API key
1. Go to <https://aistudio.google.com/apikey> and click **Create API key**.
2. Put it in `.env` as `GEMINI_API_KEY=...`.
3. Optional: `GEMINI_MODEL` (default `gemini-3.8-flash`). Any current Gemini model that supports JSON-schema output works.

### 6. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from BotFather |
| `GEMINI_API_KEY` | yes | Gemini API key |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | yes* | Used if no service role key is set (then run the optional anon SQL) |
| `SUPABASE_SERVICE_ROLE_KEY` | recommended | Server-only key; bypasses RLS |
| `TELEGRAM_WEBHOOK_SECRET` | recommended | Random string; Telegram sends it with every webhook call so fake requests are rejected |
| `GEMINI_MODEL` | no | Override the Gemini model |
| `GEMINI_FALLBACK_MODELS` | no | Comma-separated models tried in order when the main one is overloaded or rate-limited (default `gemini-3.5-flash,gemini-3.1-flash-lite`) |
| `DEMO_MODE` | no | `true` enables the `/demo` command |
| `DEBUG_EXTRACTION` | no | `true` logs (server-side only) each fact that was dropped for lacking a real quote |

\* Either the anon key or the service role key must be set.

### 7. Run locally
Requires Node.js 20+.
```bash
npm install
npm test          # core logic tests
npm run dev       # long-polls Telegram, no public URL needed
```
Now message your bot in Telegram. `npm run dev` removes any webhook, so run `npm run set-webhook` again when you go back to Vercel.

### 8. Deploy to Vercel
1. Push this folder to GitHub.
2. On <https://vercel.com> → **Add New → Project** → import the repository. No build settings are needed; Vercel detects `api/telegram.ts` automatically.
3. In **Settings → Environment Variables**, add the same variables as in `.env`.
4. Deploy. `https://<your-app>.vercel.app/api/telegram` should reply "Flat Decider bot is running." when opened in a browser.

`vercel.json` allows the function to run for up to 300 s, because `/compare` may read many listings. The webhook answers Telegram immediately and finishes the work in the background (`waitUntil`).

### 9. Configure the Telegram webhook
With `.env` filled in locally:
```bash
npm run set-webhook -- https://<your-app>.vercel.app
```
This registers the webhook (with `TELEGRAM_WEBHOOK_SECRET` if set) and the command menu.

## Using the bot

| Command | What it does |
|---|---|
| `/start` | Intro → **Create a house search** or **Join a house search** |
| `/join CODE` | Join friends with the 6-character code |
| `/status` | Who has finished preferences, how many flats each person added |
| `/preferences` | View your profile |
| `/edit` | Change one preference (profile must be re-confirmed) |
| `/add` | Add a listing link (or just paste a link anytime) |
| `/listings` | Your flats + their read status + **Add details manually** |
| `/remove` | Remove one of your flats |
| `/compare` | Compare all flats → top 3 with tradeoffs |
| `/details` | Full criterion-by-criterion comparison for the last result |
| `/cancel` | Stop the current input |
| `/leave` | Leave the house search, after confirming. Your answers and flats are kept, and rejoining with the same code restores them. |

## Matching logic

### Importance: Must have / Prefer / No preference
Every criterion stores a **desired value** and an **importance**, as separate fields:

```json
{ "criterion": "lift", "desired_value": true, "importance": "must_have" }
{ "criterion": "lift", "desired_value": true, "importance": "prefer" }
```

- **Must have**: a hard rule. A confirmed failure disqualifies the flat from normal recommendations.
- **Prefer**: counts toward that person's preference %.
- **No preference**: ignored for scoring. Every criterion is still asked and stored, even if the whole group picks "No preference".

Choosing "Doesn't matter" as the value skips the importance question and is stored as No preference. Excluded areas are always Must have. City is search context and is never scored.

### The four match states
Every (person × criterion × flat) gets exactly one state:

| State | Meaning | Shown as |
|---|---|---|
| `match` | Listing clearly satisfies it | ✅ |
| `fail` | Listing clearly violates it | ❌ |
| `unknown` | Listing doesn't say | ⚠️ Needs verification |
| `not_relevant` | Person chose No preference | ➖ (usually omitted) |

**Missing information is never Yes and never No.** Gemini returns `null` for anything not stated. On top of that, the code discards any extracted value that Gemini can't back with a quote actually found in the listing text (`sanitizeExtraction`).

Per-criterion rules:
- **Rent**: whole-flat rent split equally across the group, compared with each person's max.
- **Areas / excluded areas**: case-insensitive text match on the locality.
- **Commute**: there are no maps APIs in this MVP. A commute is a *match* only when the flat is in the destination area itself. Otherwise it is *unknown*. It is never guessed and never failed.
- **Free-text "anything else"**: Gemini turns it into a yes/no question, then answers it per listing *only* with a quoted piece of evidence. Otherwise the answer is unknown.

### Hard rules come first
Each flat gets one status:
- **QUALIFIED**: no member has a confirmed fail *or* unknown on any Must have.
- **NEEDS VERIFICATION**: no confirmed fail, but at least one Must have is unknown. Unknown hard rules are never counted as passed.
- **NEAR MATCH WITH HARD-RULE CONFLICT**: at least one confirmed Must have fail.

If fewer than 3 flats avoid a confirmed conflict, the rules are **not** weakened. The remaining slots show the closest conflicting flats, labelled loudly, with each violation spelled out ("Meera requires: Lift - Yes. This listing: No lift.").

### Preference percentage
For each person:

```text
preference match % = confirmed preferred criteria satisfied
                     ÷ preferred criteria that could be evaluated (match + fail)
```

UNKNOWN preferences are **not** counted as matches and are **not** in the denominator. They are reported separately ("1 preference still needs verification"). No preference criteria are never in the denominator.

### Balanced ranking (fairness)
Flats are sorted by, in order:
1. Status tier: Qualified → Needs verification → Hard-rule conflict
2. Fewer confirmed hard-rule failures
3. Fewer unknown hard rules
4. **Balanced score = 0.6 × lowest member's % + 0.4 × average member's %**
5. Average % (tie-break)
6. Fewer unverified preferences (tie-break)

Weighting the worst-off person stops one friend from being sacrificed for the others:

| Flat | Riya | Meera | Kavita | Average | Balanced score |
|---|---|---|---|---|---|
| A | 100% | 100% | 20% | 73.3 | **41.3** |
| B | 80% | 85% | 80% | 81.7 | **80.7** |

B ranks above A. The formula lives in code (`src/matching/rank.ts`). Gemini only writes the "Main tradeoff" sentences and never sees or changes the scoring.

### Gemini's three jobs (and nothing else)
1. **Extract listing facts** into a fixed JSON schema (validated with zod). Up to 5 listings go in one call, because the free Gemini tier allows only about 5 requests per minute. Calls are sent one at a time. Failed calls or invalid output are retried: the main model again (waiting as long as Gemini asks on rate limits), then each fallback model. If all fail, those listings are reported as "not processed, try again later" and nothing is invented. A lighter fallback model may leave more facts unknown, but the evidence check means it can't add wrong ones.
2. **Normalise free-text requirements** into yes/no checks.
3. **Explain** the finished, already-ranked result in plain language. If this fails, a deterministic sentence is used.

Listing pages are **untrusted input**. They are fenced as data in the prompt, and the system prompt says to ignore any instructions inside them. Structurally, Gemini's output can only fill validated fact fields: it cannot change preferences, scoring, the database beyond that listing's extraction, or trigger any tool. No secrets are ever sent to Gemini.

### When a URL can't be read
Many property sites need a login, render with JavaScript, block bots, or have expired listings. The bot fetches public HTML (with timeouts, size limits and private-network blocking). If it can't get enough text, or Gemini can't find enough facts, the flat is marked **"Could not read listing details"** and is left out of the comparison. It is listed separately with an **Add details manually** button for the person who submitted it. Pasted text is stored with the listing and used next time. When manual text exists it takes priority over the URL. One failed listing never stops the others from being compared.

Extractions are cached in `listing_extractions` and redone only when the listing text or someone's free-text requirement changes.

## Product decisions

**Deliberately not built:** property APIs, automated apartment discovery or scraping across portals, a web frontend, a login system, marketplace features, notifications, listing monitoring, WhatsApp integration, or ML recommendation models.

Finding a flat together is a **temporary, one-time workflow**. Once the group signs a lease they may never use the tool again. Those systems would cost far more to build and run than they return for a few weeks of use. The users already know how to find listings. The unsolved part is agreeing, and that is all this bot does.

Other simple decisions:
- **Member identity is `(group_id, telegram_user_id)`**, enforced by a database unique constraint. Usernames and display names are never used to identify someone, and a changed @username is simply updated.
- **Returning members are recognised, never restarted.** Sending `/start`, re-entering the join code, or tapping an old Create/Join button shows a "Welcome back" menu. A partial profile resumes at the first unanswered question, which is worked out from the answers saved in Supabase, not from chat session state.
- **Leaving keeps your data.** `/leave` (or `/leavegroup`) asks for confirmation, then marks the membership as left. That person is removed from status and comparisons and their flats are hidden. Rejoining with the same code reactivates the same record, with the same answers, flats and creator status. Demo groups are the exception: leaving one deletes it.
- A person is active in one house search at a time (`/leave` to switch). Up to 6 members per group.
- Rent is split equally between all members.
- No hard per-person listing limit. There is a safety cap of 30 flats per group to keep `/compare` fast (the design target is ~5 per person, ~15 total).
- Duplicates are detected on a normalised URL (ignores `www.`, tracking parameters, `#fragments` and trailing slashes).
- Conversation state is stored in `members.state`, not in Gemini chat history. The database is the only memory.
- The bot only works in private chats, so each person answers separately.

## Demo mode

Demo data lives in `src/demo/` and is never used by production logic.

**Option A: in Telegram.** Set `DEMO_MODE=true`, then send `/demo` to the bot (you must not already be in a house search). This creates a Pune house search where **you play Riya**, with Meera and Kavita's profiles complete and 9 flats already added:
- flats described with pasted listing text, so the demo doesn't depend on live property websites
- flats chosen to show all three labels: one qualifies, one needs verification (lift not mentioned), and several break a hard rule (no lift, 1 bathroom, over budget, excluded area, no parking, 2BHK)
- one deliberately unreadable URL, to show the manual-details fallback

Then run `/status`, `/preferences`, `/compare`, `/details`. `/leave` deletes the whole demo group.

**Option B: script.** `npm run demo:seed -- <your Telegram user id>` does the same from your machine. You can get your user id from @userinfobot.

**Removing demo data:** run [`supabase/remove_demo_data.sql`](supabase/remove_demo_data.sql) and unset `DEMO_MODE`.

## Tests

```bash
npm test
npm run typecheck
```

- `tests/matching.test.ts`: the 7 required scenarios (all hard rules pass; one confirmed hard fail; missing hard-rule info → needs verification; No preference doesn't affect the score; preference % with unknowns; only two qualify → labelled near match; fairness), plus per-criterion rules.
- `tests/extraction-and-format.test.ts`: hallucinated facts are dropped, custom checks need evidence, prompt fencing, URL normalisation and private-address blocking, message wording.
- `tests/persistence.test.ts`: returning members (completed, halfway, the creator leaving and rejoining, repeated joins, username changes, preferences only changing through an explicit edit).
- `tests/database.test.ts`: runs both SQL migrations in an embedded Postgres (PGlite) and checks the uniqueness rules at database level.
- `tests/flow.test.ts`: a full conversation through the real router (create → join → 16 questions → confirm → edit → add/duplicate → manual details → compare → details), with an in-memory database, fake Telegram and fake Gemini.

## Known limitations
- Commute times are not calculated (no maps API). Commutes are "needs verification" unless the flat is in the destination area.
- Area matching is text-based. "Baner" matches "Baner Road", but nearby localities are not treated as the same.
- Many portals (NoBroker, MagicBricks, 99acres) render with JavaScript or block bots, so pasting details manually will often be needed.
- Rent is split equally. Unequal room splits aren't modelled.
- On the free Gemini tier, a `/compare` with ~15 new flats takes about 1–2 minutes (batched calls plus rate-limit waits). Unchanged flats are cached and not re-read.
- Updates from the same person are processed independently. Tapping buttons extremely fast could, in rare cases, interleave.
