# Apple Watch and Siri

Three Siri Shortcuts that work on an iPhone and on an Apple Watch. LocalAI has no watch app; the shortcuts call two
endpoints and speak the answer.

| Say | Calls | You hear |
|---|---|---|
| "What needs me" | `GET /api/glance?format=text` | "Needs you: 1 approval and 11 unfinished change requests. 1 run failed today." |
| "Is Local AI OK" | `GET /api/glance?topic=health&format=text` | "Local AI 2.0.258 is running and all 5 core services are up." or "Image generation is down. Everything else is up." |
| "Ask Local AI" | `POST /api/chat` with `brief: true` | A one- or two-sentence answer from the local model |

Notifications (finished, failed, waiting for approval) reach the watch on their own: once they are on in Health ›
Notifications on the iPhone, iOS mirrors them to the watch while the phone is locked.

## Address to use

- Phone or watch on the home network: `http://10.0.0.21:3080` (the appliance's LAN address), or `https://<name>/` if
  you installed Local AI's certificate on the iPhone (Health › Secure connection).
- Away from home the watch can't reach the appliance. A private network link such as Tailscale on the iPhone and the
  Windows host fixes that; nothing in LocalAI needs to change.

Below, `BASE` stands for that address.

## Build the shortcuts (Shortcuts app on the iPhone)

**What needs me**
1. New shortcut, named **What needs me**.
2. Add **Get Contents of URL**: `BASE/api/glance?format=text` (method GET).
3. Add **Speak Text** with the input *Contents of URL*. (Optional: **Show Result** as well, for reading on the watch.)

**Is Local AI OK**: the same, with `BASE/api/glance?topic=health&format=text`.

**Ask Local AI**
1. New shortcut, named **Ask Local AI**.
2. Add **Dictate Text**.
3. Add **Get Contents of URL**: `BASE/api/chat`, method **POST**, Request Body **JSON**, with two fields:
   - `messages`, type **Array**, one item of type **Dictionary**: `role` = `user`, `content` = *Dictated Text*.
   - `brief`, type **Boolean**, on.
4. Add **Get Dictionary Value** `message` from *Contents of URL*, then **Get Dictionary Value** `content` from that.
5. Add **Speak Text** with the result.

For each shortcut, open its details (ⓘ) and turn on **Show on Apple Watch**. Then raise your wrist and say
"Hey Siri, what needs me", or run it from the Shortcuts app or a Smart Stack widget on the watch.

The first question after the model has been idle can take a few seconds longer while Ollama loads it.

## The endpoints

`GET /api/glance` returns JSON: `{topic, speech, needsYou:{count, items:[{kind, count, text}]}, health:{ok, down, total},
version}`. `?topic=health` switches `speech` to the health sentence; `?format=text` returns only `speech` as plain text.
"Needs you" counts pending approvals, unfinished change requests and Claude findings still marked Proposed; it also
mentions runs that failed in the last 24 hours, runs in progress, and any core service that is down. The sentences are
built in `app/glance.js`.

`POST /api/chat` accepts `brief: true`, which adds one instruction to the system prompt: answer in at most two short
sentences of plain text, for reading aloud. Everything else about the chat run (Library, run history) is unchanged.

Both are read-only or create an ordinary chat run, and like the rest of the API they have no password on the LAN (see
[Security](SECURITY.md)). Approving changes from the watch is deliberately not offered until approvals have their own
confirmation step.
