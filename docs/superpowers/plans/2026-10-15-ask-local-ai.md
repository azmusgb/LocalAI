# Ask Local AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Siri Shortcut that answers watch questions correctly, briefly and within 8 s (or hands the answer to the
phone), follows up, knows what needs you, the time and the weather, finds current facts, and starts work by voice.

**Architecture:** A pure voice router (`app/voice.js`) classifies a question and decides its source; small pure
helpers (`app/voice-context.js`, `app/weather.js`) build the facts and the spoken text; `apiGlanceAsk` in
`app/server.js` wires them to `chatOnce`, `searxSearch`, the glance data, notifications and the run starters.
Everything is plain `fetch`; no new dependencies.

**Tech Stack:** Node 22 built-ins, `node --test` with spawned-server tests and mocked Ollama / SearXNG / Open-Meteo.

**Spec:** `docs/superpowers/specs/2026-10-15-ask-local-ai-design.md`

**Depends on:** the warm-model PR (`perf/warm-model`: `TEXT_NUM_CTX`, `TEXT_KEEP_ALIVE`, `fitMessages` in
`app/text-context.js`). Task 1 starts after it merges.

## Global Constraints

- Voice answers: "at most two short sentences, plain words, numbers as people say them, no lists, markdown, links or
  emoji" (spec §3); a final filter strips markdown, URLs and emoji.
- Budget: the server replies within **8 s** (`VOICE_BUDGET_MS = 8000`); current-info search is capped at **3 s**.
- Follow-up window **5 minutes** (`VOICE_THREAD_MS = 300000`), last **6 turns** as context.
- Never by voice: approve, reject, apply or deploy changes; PowerShell; deleting anything. The reply for those is
  exactly "That needs your phone — I've put it in Needs you."
- Weather: Open-Meteo forecast `https://api.open-meteo.com/v1/forecast` and geocoding
  `https://geocoding-api.open-meteo.com/v1/search` (no key). Only coordinates or the place name leave the appliance.
- No new runtime npm dependencies; main stays usable after each PR; `POST /api/glance/ask {text}` keeps working.
- Handoff notification: `notifier.notify({kind:'answer', title:'Local AI answered', body:<first 180 chars>, url:'#run/<runId>', tag:'answer:<runId>'})`.

## Review Focus

1. **Siri sends an empty or noise-only dictation** ("", "um") → a short spoken prompt "I didn't catch that." with
   HTTP 200 (Siri speaks it), not a 400 error page read aloud. Test in Task 1.
2. **The model returns markdown, a URL or emoji anyway** → the spoken text has none. Test in Task 1.
3. **Two asks overlap** (a follow-up sent before the previous answer finished) → the second waits for or joins the
   voice thread without corrupting it; both get answers. Test in Task 2.
4. **Open-Meteo or SearXNG is down or slow** → the answer still comes within the budget, saying the fact is
   unavailable, never hanging. Test in Task 4.
5. **"Approve the login fix" or "deploy it"** → the refusal sentence, and no approval/apply/deploy route is called.
   Test in Task 5.

---

### Task 1: Voice router, voice context, speaking filter, GET form

**Files:**
- Create: `app/voice.js`, `app/voice-context.js`
- Modify: `app/server.js` (`apiGlanceAsk`, route table: add `GET /api/glance/ask`; `systemPrompt` voice branch), `app/glance.js` (a `needsYouItems` that returns names)
- Test: `tests/voice.test.cjs` (new), `tests/glance-ask.test.cjs` (new, spawned server with mocked Ollama)

**Interfaces:**
- Produces:
  - `classify(text: string) → {intent: 'needs'|'health'|'time'|'weather'|'current'|'action'|'refuse'|'chat'|'empty', action?: 'image'|'mission'|'research', subject?: string}` in `app/voice.js`. Rules only (regexes over lower-cased text); no model call.
  - `speakable(text: string) → string` in `app/voice.js`: strips markdown (`*_#>` `` ` `` list markers, link syntax keeping the label), URLs, emoji; collapses whitespace; keeps at most two sentences.
  - `voiceFacts({now: Date, timeZone: string, place?: string}) → string` in `app/voice-context.js`: e.g. "Today is Thursday, October 15, 2026. It is 9:42 in the evening in America/Phoenix."
  - `needsYouItems(data) → [{kind, title}]` in `app/glance.js` (approval, change, finding, failed run, down service titles).
  - `GET /api/glance/ask?q=` and `POST {text}` both → plain text.
- Behaviour: `time` answered without the model from `voiceFacts`; `needs` → a sentence naming up to 3 items ("Two things need you: Fix the login bug, and the Weekly report mission failed.") built in code; `health` → `glance.healthSummary`; `chat` → `chatOnce({messages, brief:true, voice:true})` where the voice system prompt includes `voiceFacts`; output always passes `speakable`. `weather`/`current`/`action`/`refuse` fall back to `chat` until Tasks 4–5.

- [ ] **Step 1: Failing tests.** `tests/voice.test.cjs`: a table test — "anything need me" / "what's waiting for me" → `needs`; "is local ai ok" → `health`; "what's the date" / "what time is it" → `time`; "what's the weather tomorrow" → `weather`; "who won the world series last year" / "latest news on SpaceX" → `current`; "make an image of a red fox" → `action` image subject "a red fox"; "start a mission to compare NAS drives" → `action` mission; "approve the login fix" / "deploy it" / "delete the library" → `refuse`; "" / "um" → `empty`; "explain WAL mode" → `chat`. `speakable('**Yes** — see https://x.y 🙂\n- a\n- b. Third. Fourth.')` has no `*`, `http`, emoji or `-` markers and at most two sentences. `voiceFacts` for a fixed date/zone equals the exact sentence above. `tests/glance-ask.test.cjs`: `GET /api/glance/ask?q=what%20time%20is%20it` answers without calling the mock model; `q=anything need me` with one seeded pending approval titled "Fix the login bug" speaks that title; Review Focus 1: `q=` and `q=um` return 200 "I didn't catch that."; Review Focus 2: mocked model returning markdown + URL + emoji → spoken text clean; the chat system prompt sent to the mock contains today's weekday.
- [ ] **Step 2: Run** `node --test tests/voice.test.cjs tests/glance-ask.test.cjs` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Ask Local AI: a voice router that knows the time and what needs you`.

### Task 2: Follow-up voice threads

**Files:** Modify `app/voice.js` (thread state helpers), `app/server.js` (`apiGlanceAsk`); Test `tests/glance-ask.test.cjs`.

**Interfaces:**
- Produces: `createVoiceThreads({now: () => number, windowMs = 300000}) → { take(text) → {threadId: string, history: {role,content}[]}, record(threadId, userText, answer) → void }` in `app/voice.js`. `take` continues the current thread inside the window (returning up to the last 6 turns), else starts one (`newThreadId`-style `t-` + 32 hex from `crypto.randomBytes`); "new question" / "start over" (classified intent unaffected) forces a new thread. One instance per server.
- Chat asks pass `threadId` and the history to `chatOnce`, so the turns form one thread in Work.

- [ ] **Step 1: Failing tests:** two asks 1 minute apart share `threadId` and the second request to the mock model contains the first Q and A; asks 6 minutes apart don't; "start over" starts a new thread; Review Focus 3: two overlapping asks (the first's mock answer delayed 500 ms) both answer, and the thread records both turns in order.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (serialize asks on the same thread with a per-thread promise chain).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Ask Local AI: follow-ups continue the conversation`.

### Task 3: 8-second budget and phone handoff

**Files:** Modify `app/voice.js` (`withBudget`), `app/server.js` (`apiGlanceAsk`); Test `tests/voice.test.cjs`, `tests/glance-ask.test.cjs`.

**Interfaces:**
- Produces: `withBudget(promise: Promise<T>, ms: number) → Promise<{done: true, value: T} | {done: false, later: Promise<T>}>` in `app/voice.js`.
- When not done: reply exactly "Still working on that — I'll send it to your phone."; when `later` resolves, call `notifier.notify` with the Global Constraints payload (body = `speakable(answer)` cut to 180 chars); if it rejects, notify `{kind:'answer', title:'Local AI couldn't answer', body:<error message>}`. `VOICE_BUDGET_MS` overridable by env `LOCALAI_VOICE_BUDGET_MS` (tests set it low).

- [ ] **Step 1: Failing tests:** `withBudget` with fake timers (resolves before → done; after → later); server: mock model delayed beyond a 200 ms test budget → the handoff sentence returns within ~250 ms and exactly one notification with `url:'#run/<id>'` is recorded (inject a recording notifier via the existing push test hooks or a test-only `LOCALAI_NOTIFY_LOG`); a fast answer sends no notification.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Ask Local AI: answers in 8 seconds or sends them to your phone`.

### Task 4: Weather and current facts

**Files:**
- Create: `app/weather.js`
- Modify: `app/server.js` (`apiGlanceAsk`; `GET/POST /api/voice/home` for the home location), `app/public/ui.js` (Health: a "Home location" settings row), `docs/APPLE-WATCH.md` not yet (Task 6)
- Test: `tests/weather.test.cjs` (new), `tests/glance-ask.test.cjs`, a Health check in an existing browser suite (e.g. `tests/secure-connection-ui.mjs` or a new `tests/voice-home-ui.mjs`)

**Interfaces:**
- Produces in `app/weather.js`: `geocode(place, {fetch}) → Promise<{name, lat, lon, timeZone}|null>`; `reverse(lat, lon, {fetch}) → Promise<string|null>` (nearest place name); `forecast(lat, lon, {fetch, timeZone}) → Promise<{now:{tempC, code}, today:{maxC, minC, rainChance, code}, tomorrow:{…}}>`; `weatherSentence(f, {when: 'now'|'today'|'tomorrow'|'tonight', place, units: 'F'|'C'}) → string` (default units F; WMO code → plain words table in the module).
- Home location: `GET /api/voice/home` → `{place, lat, lon, timeZone}|{}`; `POST /api/voice/home {place}` geocodes and stores (`storage.writeSetting('voice-home', …)`); 400 "Couldn't find that place." when geocoding fails. Health shows "Home location: <place>" with Change… (uses `LocalAIUI.ask` with an `input`).
- `weather` intent: location from `lat/lon` query params (reverse-geocoded name) else the home setting else the sentence "Set your home location on Local AI's Health page."; time zone from the location (Open-Meteo `timezone=auto`) else the host's.
- `current` intent: `searxSearch(text)` raced against 3 s; top 3 results as research context into the voice chat; the answer names the first source's site ("According to espn.com, …").

- [ ] **Step 1: Failing tests:** `weather.test.cjs` with a stubbed fetch: geocode/reverse/forecast parse Open-Meteo's response shapes (fixtures in the test); `weatherSentence` for now/tomorrow in F and C ("Tomorrow in Phoenix: sunny, high of 84, low of 61, no rain expected."). `glance-ask.test.cjs` (mock Open-Meteo and SearXNG servers via env `OPEN_METEO_URL`, `OPEN_METEO_GEO_URL`, `SEARXNG_URL`): weather with lat/lon names the reverse-geocoded place; with no location and no home → the set-home sentence; current-info passes 3 snippets to the mock model and the answer names the source; Review Focus 4: SearXNG delayed 5 s → answer within 3.5 s saying it couldn't look that up; Open-Meteo returns 500 → "I couldn't get the weather right now." Health UI: setting "Phoenix, AZ" (geocode mocked) shows "Home location: Phoenix".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`OPEN_METEO_URL`/`OPEN_METEO_GEO_URL` env overrides default to the public URLs).
- [ ] **Step 4: Run** `npm test` and the browser suites → PASS.
- [ ] **Step 5: Commit** `Ask Local AI: weather where you are, and current facts with a source`.

### Task 5: Voice actions and refusals

**Files:** Modify `app/server.js` (`apiGlanceAsk`), `app/voice.js` (subject extraction); Test `tests/glance-ask.test.cjs`.

**Interfaces:**
- `action` → start without awaiting completion, reply when started: image → `POST /api/images/generate {prompt: subject}` (internal loopback `fetch` to the server's own port, not awaited; reply "Started an image of <subject>. I'll notify you when it's ready."); mission → `POST /api/agents/missions/start {goal: subject, async: true}` when the async API exists, else without `async` and not awaited (reply "Started a mission: <subject>."); research → `chatOnce({webSearch:true, …})` not awaited (reply "Researching <subject>. I'll send you the answer.") with the handoff notification on completion (Task 3's path).
- `refuse` → exactly "That needs your phone — I've put it in Needs you." and nothing else is called (the item is already in Needs you; this task adds no new item).

- [ ] **Step 1: Failing tests:** "make an image of a red fox" → reply within 1 s containing "a red fox" and the mock image endpoint receives the prompt; "start a mission to compare NAS drives" → the mission endpoint receives the goal; "research the best NAS for Plex" → reply immediately and one handoff notification after the mock completes; Review Focus 5: "approve the login fix" / "deploy it" → the refusal sentence and the test asserts no request reached `/api/approvals/decide`, `/api/changes/approve`, `/api/changes/request-apply` or any PowerShell route.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Ask Local AI: start work by voice; approvals stay on your phone`.

### Task 6: Docs and the shortcut recipe

**Files:** Modify `docs/APPLE-WATCH.md`, `README.md` (one line linking it); Test: `tests/glance-ask.test.cjs` gains a check that every example sentence in the doc's "What you can say" table classifies to its listed intent (the doc table is parsed).

- [ ] **Step 1: Failing test** (doc table parse → classify).
- [ ] **Step 2: Run** → FAIL (table not yet written).
- [ ] **Step 3: Write** the doc: the one shortcut (Dictate Text → optional Get Current Location → Get Contents of URL `BASE/api/glance/ask?q=<Dictated Text>&lat=<Latitude>&lon=<Longitude>` → Speak Text), Show on Apple Watch, the "What you can say" table (intent, example, where the answer comes from), the 8-second handoff, follow-ups, setting the home location, what's never possible by voice, and the old three shortcuts noted as still working.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `Ask Local AI: one shortcut, documented`.
