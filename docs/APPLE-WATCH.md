# Apple Watch and Siri

One Siri Shortcut, **Ask Local AI**, that works on an iPhone and on an Apple Watch. Ask it anything: what needs you,
whether Local AI is OK, the time, the weather where you are, the latest news, or to start an image, a mission or some
research. It answers in one or two short sentences within 8 seconds, or tells you the answer is on its way to your
phone. LocalAI has no watch app; the shortcut calls one endpoint and speaks what comes back.

Notifications (finished, failed, waiting for approval, and answers handed off from Siri) reach the watch on their own:
once they are on in Settings › Notifications on the iPhone, iOS mirrors them to the watch while the phone is locked.

## Address to use

- Phone or watch on the home network: `https://10.0.0.81` (the appliance's LAN address), or `https://<name>/` if
  you installed Local AI's certificate on the iPhone (Health › Secure connection).
- Away from home the watch can't reach the appliance. A private network link such as Tailscale on the iPhone and the
  Windows host fixes that; nothing in LocalAI needs to change.

Below, `BASE` stands for that address.

## Build the shortcut (Shortcuts app on the iPhone)

1. New shortcut, named **Ask Local AI**.
2. Add **Dictate Text**.
3. Optional, for weather where you are: add **Get Current Location**.
4. Add **Get Contents of URL** with the URL `BASE/api/glance/ask`. Tap **Show More**: set **Method** to **POST** and
   **Request Body** to **JSON**, then add a **Text** field `text` with the value *Dictated Text*. With step 3, also add
   two **Number** fields, `lat` and `lon`: insert *Current Location* in each and tap it to pick *Latitude* or
   *Longitude*.
5. Add **Speak Text** with the input *Contents of URL*. (Optional: **Show Result** as well, for reading on the watch.)

The shortcut must use POST: making an image, starting a mission and research only start from a POST, because any
web page can make a browser load a GET address. An older shortcut that asks with GET still gets every other answer,
and for those three hears "Use the Ask Local AI shortcut to start that."

Open the shortcut's details (ⓘ) and turn on **Show on Apple Watch**. Then raise your wrist and say "Hey Siri, Ask Local
AI", or run it from the Shortcuts app or a Smart Stack widget on the watch. The first time it uses your location,
Shortcuts asks for permission on the phone.

The first question after the model has been idle can take a few seconds longer while Ollama loads it; if that passes
8 seconds, the answer arrives as a notification instead (below).

## What you can say

| Intent | You say | The answer comes from |
|---|---|---|
| `needs` | "Anything need me?", "What's waiting for me?" | What Home's Needs you lists, by name: approvals and failures you haven't opened yet (one per goal), and services that are down. No model. |
| `health` | "Is Local AI OK?", "Health check" | The Health page's summary sentence. No model. |
| `time` | "What time is it?", "What's the date?" | The appliance's clock, in its time zone. No model. |
| `weather` | "What's the weather?", "Will it rain tomorrow?", "How cold is it tonight?" | Open-Meteo, for where your phone is (or your home location). |
| `history` | "What did I ask about PETG yesterday?", "When did I last make a poster?", "Did my last print finish?" | Past work: your own record in Local AI (the journal), answered by the local model on this PC with no tools; the citation numbers are not spoken. Nothing found is "I don't have anything about that", with no model. Prints: Pi Hub's print list can't be read from here yet, and the answer says so. Films: no record is kept. The run is in Work as Past work. |
| `current` | "Who won the game last night?", "Latest news on SpaceX" | A web search (SearXNG, at most 3 seconds); the model answers from the top three results and names the site. |
| `action` `image` | "Make an image of a red fox", "Draw a picture of a lighthouse at dusk" | Starts the image and says so; a notification follows when it's ready. |
| `action` `mission` | "Start a mission to compare NAS drives" | Starts the mission and says so; it appears in Work, and its own notification arrives when it finishes. |
| `action` `research` | "Research the best NAS for Plex" | Starts a web-search research run and says so; the answer arrives as a notification. |
| `refuse` | "Approve the login fix", "Deploy it", "Delete the old runs" | Nothing is done. You hear "That needs your phone — I've put it in Needs you." |
| `chat` | "Explain WAL mode", "How many ounces in a cup?" | The local model, told the date, the time and to answer in two short spoken sentences. |

Whatever the answer, it is cleaned before Siri reads it: no markdown, links, lists or emoji, and at most two sentences.
If Siri hears nothing or only "um", you hear "I didn't catch that."

### Follow-ups

A question within 5 minutes of the previous one continues the same conversation, with the last six exchanges as
context, so "And tomorrow?" after a weather answer gives tomorrow's weather for the same place, and "Why?" follows the
last answer. Start with "New question" or "Start over" to drop the earlier context. The conversation lives on the
appliance, not in the shortcut, so it is shared by every device that asks within those 5 minutes.

### The 8-second limit

Siri gives up on a shortcut that takes too long, so Local AI always replies within 8 seconds. If the answer isn't
ready, you hear "Still working on that — I'll send it to your phone." and the answer arrives as a notification titled
**Local AI answered** (or **Local AI couldn't answer**) a little later; tap it to open the run. Image and research
actions report the same way, as **Your image is ready** and **Research ready**. These notifications go to every device
with notifications on, even during quiet hours, unless you turned answers off for that device in Health ›
Notifications.

### Home location

When the shortcut sends no location, weather is for your home location. Set it on System › Settings: **Home location: Not set**
› **Change…**, then type a place such as "Phoenix, AZ". Until it is set, weather without a location answers "Set your
home location on Local AI's Health page." Only the coordinates or the place name leave the appliance (to Open-Meteo,
which needs no account).

### Never by voice

Approving or rejecting, applying or deploying changes, PowerShell, restarts and deleting anything are refused, and
nothing is called. These stay on the phone, where the item is already waiting in Needs you.

## Older shortcuts

Earlier versions of this guide built three shortcuts. They keep working:

- **What needs me**: `GET BASE/api/glance?format=text`, then **Speak Text**. The new shortcut answers the same
  question with names instead of counts.
- **Is Local AI OK**: `GET BASE/api/glance?topic=health&format=text`.
- **Ask Local AI** with `POST BASE/api/glance/ask` and a JSON body `{"text": Dictated Text}`. It gets everything
  above; add `lat` and `lon` number fields to the body for weather where you are.

## The endpoints

`POST /api/glance/ask` `{"text": "…", "lat"?: n, "lon"?: n}` and `GET /api/glance/ask?q=<text>[&lat=<n>&lon=<n>]`
return the answer as plain text, always with status 200 except "That was too long for me." (413) and "Local AI can't
answer right now. Try again in a minute." (503); Siri speaks the body either way. A GET never starts an image, a
mission or research (it answers "Use the Ask Local AI shortcut to start that."), and a POST with a foreign `Origin` or
`Sec-Fetch-Site: cross-site` gets 403 like every other mutating request. The router is `app/voice.js` (rules
only, no model); the handler is `apiGlanceAsk` in `app/server.js`. Model answers are ordinary chat runs, so they show
in Work (and in the Library once you keep them). `GET /api/voice/home` and `POST /api/voice/home {"place": "…"}` read and set the home
location.

`GET /api/glance` returns JSON: `{topic, speech, needsYou:{count, items:[{kind, count, text}]}, health:{ok, down, total},
version}`. `?topic=health` switches `speech` to the health sentence; `?format=text` returns only `speech` as plain text.
The sentences are built in `app/glance.js`. "What needs me?" (here and in Ask Local AI) counts what Home's Needs you
lists, by the same rule (`app/public/needs-you.js`): waiting approvals, and failures you haven't opened, under a day
old, not retried and not answered by a later success, one per goal. Opening a failure on any device takes it off
Home and out of Siri's answer alike.

Like the rest of the API, these have no password on the LAN (see [Security](SECURITY.md)).
