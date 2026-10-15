# Ask Local AI, amazing — design

Date: 2026-10-15 · Status: spec for review (owner delegated the design decisions: "do all you can to make it amazing")
Research: measured on the appliance and on Apple's platform limits (summary below). Builds on `docs/APPLE-WATCH.md`
(#129, #132), notifications (sub-project 6) and the warm-model change (`perf/warm-model`: 8k context fully on the
6 GB GPU, 30-minute keep-alive, unload/re-warm around image jobs).

## Intent

One Siri Shortcut, **Ask Local AI**, used mostly from an Apple Watch, that you can ask anything a sensible assistant
should handle — and it answers correctly, briefly, out loud, fast; continues a conversation; knows what needs you;
knows the weather; and can start work for you. The shortcut stays three or four steps.

**Success:** a watch question gets a spoken answer within about 8 seconds, or a spoken "I'll send it to your phone"
and a notification with the answer; answers are right about today (date, time, weather, what needs you); "and
tomorrow?" works as a follow-up; "make an image of…" or "start a mission to…" starts it and says so.

## What research found

- Today (warm model): about 1 s per answer, but "what's the weather" is refused (no web), follow-ups get filler (no
  history), "who won the World Series last year" was wrong (no date in the prompt), "anything need me?" is right only
  by luck (the model never sees approvals or failures).
- Cold starts dominated: 164 s and a 180 s timeout — fixed by the warm-model change (8k context: 74 tok/s fully on GPU
  vs 26 tok/s at 32k; ~5 s cold load).
- Platform limits: Shortcuts can't stream (the watch waits for the full answer); Siri gives up after roughly 10–30 s
  (unpublished), so the server answers within 8 s; Shortcuts on the watch can't reliably keep state between runs, so
  follow-ups live on the server.

## Design

### 1. One endpoint, simpler shortcut

`GET /api/glance/ask?q=<text>[&lat=<n>&lon=<n>]` returns plain text to speak (`POST {text, lat?, lon?}` keeps
working). The shortcut: **Dictate Text → (optional) Get Current Location → Get Contents of URL → Speak Text**.
The request is logged as an ordinary chat run (`brief: true`), so asks appear in Work as a "Voice" thread.

### 2. A voice router before the model

A small pure module `app/voice.js` classifies the text (rules first, the model only when unclear) into:

| Intent | Example | Answer comes from |
|---|---|---|
| `needs` | "anything need me?", "what's waiting" | glance data with **names**: approvals, changes, Claude decisions, failed runs, down services |
| `health` | "is Local AI ok" | glance health sentence |
| `weather` | "weather", "will it rain tomorrow", "how cold tonight" | Open-Meteo (free, no key) for the location; the model phrases it |
| `time` | "what's the date", "what time is it" | server clock in the home time zone, no model |
| `current` | "news on…", "who won…", "latest…" | a SearXNG search capped at 3 s, top 3 snippets as context; the model answers and names the source |
| `action` | "make an image of…", "start a mission to…", "research…" | starts the run (image, mission, research chat) and says "Started: <title>. I'll notify you when it's done." |
| `chat` | anything else | the model, with the voice context below |

**Never by voice:** approving, rejecting, applying or deploying changes; PowerShell; deleting anything. Asked for one,
it says "That needs your phone — I've put it in Needs you."

### 3. Voice context in every model call

The system prompt for voice gains: the current date, weekday and time in the home time zone; the location name when
known; the speaking rules (at most two short sentences, plain words, numbers as people say them, no lists, markdown,
links or emoji); and, for `needs`/`health`/`weather`/`current`, the fetched facts. A last-mile filter strips any
remaining markdown, URLs and emoji before speaking.

### 4. Follow-ups on the server

An ask within **5 minutes** of the previous voice ask continues the same thread (`threadId` kept server-side as the
"voice thread"), sending the last 6 turns as context; after 5 minutes a new thread starts. "New question" / "start
over" forces a new thread.

### 5. Answer in 8 seconds, or hand off to the phone

The server races the answer against an **8 s** budget. If the answer isn't ready, it replies immediately
"Still working on that — I'll send it to your phone." and lets the run finish; when it completes, a notification
(`kind: 'answer'`, title "Local AI answered", body = the first 180 characters, url `#run/<id>`) goes to your devices.
Actions reply as soon as the run starts.

### 6. Location

The shortcut may pass `lat`/`lon` (Get Current Location) — used for weather and named by reverse lookup (Open-Meteo
geocoding). Without it, a **home location** set once on System › Health (a place name, geocoded and stored on the
appliance) is used; the time zone defaults to the host's. With neither, weather says "Set your home location on
Local AI's Health page."

### 7. Docs

`docs/APPLE-WATCH.md` rewritten around the one shortcut (with and without location), what you can say, the 8 s
handoff, follow-ups, and what's deliberately not possible by voice.

## Delivery (one PR each; depends on the warm-model PR)

1. Voice router + voice context + speaking filter + GET form (`time`, `needs` with names, `health`, `chat`).
2. Follow-up voice threads.
3. 8 s budget with phone handoff via notifications.
4. Weather (Open-Meteo, location from the shortcut or the home setting on Health) and `current` via SearXNG ≤ 3 s.
5. Voice actions (image, mission, research) with spoken confirmation; the "needs your phone" refusals.
6. Docs and the shortcut recipe.

**Tests:** unit tests for the router (a table of phrasings per intent), the speaking filter, the follow-up window and
the budget race (fake timers); server tests with a mocked Ollama, SearXNG and Open-Meteo for each intent's spoken
output; a notification is sent exactly once on handoff; actions never call approval/apply/deploy routes. A live
check after deploy: five watch questions timed end to end.

**Out of scope:** a native watch app; approvals by voice; storing state in the shortcut; changing the text model.

**Rules:** no new runtime npm dependencies (Open-Meteo and SearXNG over `fetch`); external calls only for weather
and the existing SearXNG; nothing about the questions leaves the appliance except the weather lookup's coordinates or
place name; main stays usable after each PR.
