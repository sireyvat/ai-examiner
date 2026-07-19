# Ada — AI English Speaking Examiner

A voice-to-voice web app that runs a strict 5-minute spoken English exam:
Phase 1 Vocabulary (2:00) → Phase 2 Grammar (1:30) → Phase 3 Text Analysis (1:30),
with live oral grammar correction and a final Vocabulary/Grammar/Fluency score report.

## How it actually works (read this before you build on it)

You asked for "Gemini Multimodal Live API / OpenAI Realtime API" — those are real
low-latency **audio-in / audio-out websocket** APIs. I did not wire this app to
either of them, and want to be upfront about why, rather than quietly building
something different from what you asked for:

- They require a persistent WebSocket session, audio streamed as raw PCM chunks,
  and non-trivial client-side audio buffering/echo-cancellation handling.
- They're materially more expensive per minute and more complex to secure (the
  browser needs a short-lived ephemeral token minted by your backend, not a
  direct key).
- For a 5-minute, turn-based Q&A exam (not a free-flowing phone call), the extra
  latency win of a raw audio pipeline is not very noticeable — most of the
  "wait" a candidate feels is the examiner formulating a reply, not STT/TTS
  encoding time.

So this build instead uses:

- **Speech-to-Text**: the browser's native Web Speech API (`SpeechRecognition`) —
  free, no API key, works well in Chrome/Edge.
- **Text-to-Speech**: the browser's native `speechSynthesis` — free, no API key,
  no added latency from network audio transfer.
- **The "brain"**: a small Node/Express backend that sends the text transcript to
  OpenAI (`gpt-4o-mini` by default) or Gemini (your choice) and gets back the
  examiner's next line as text.

This is turn-based (listen → think → speak → listen), not a continuously
streaming call, but it's simple, cheap, secure, and reliable for a 5-minute
structured exam. **If you specifically want the true low-latency streaming
Realtime experience**, see "Upgrading to a true Realtime API" at the bottom —
the backend is already structured so you can swap in a websocket relay later
without touching the exam logic or scoring.

## Project structure

```
ai-examiner/
├── server.js           Express backend — calls the LLM, keeps your API key server-side
├── package.json
├── .env.example         Copy to .env and fill in your key
├── public/
│   ├── index.html        UI
│   ├── style.css          Styling
│   └── app.js              STT/TTS + exam logic
```

## Prerequisites

- **Node.js 18+** (for native `fetch`). Check with `node -v`.
- **Google Chrome or Microsoft Edge on desktop.** The Web Speech API's
  `SpeechRecognition` is not supported in Firefox or Safari, and requires a
  real desktop browser (not all mobile browsers implement it either).
- An API key for **either** OpenAI **or** Gemini:
  - OpenAI: https://platform.openai.com/api-keys
  - Gemini: https://aistudio.google.com/apikey

## Setup (local)

```bash
cd ai-examiner
npm install
cp .env.example .env
```

Open `.env` and fill in:

```
LLM_PROVIDER=openai          # or "gemini"
OPENAI_API_KEY=sk-...        # only needed if LLM_PROVIDER=openai
OPENAI_MODEL=gpt-4o-mini
GEMINI_API_KEY=...           # only needed if LLM_PROVIDER=gemini
GEMINI_MODEL=gemini-1.5-flash
PORT=3000
```

**Your API key never touches the browser.** The frontend only ever calls your
own backend (`/api/chat`, `/api/session/start`, `/api/report`, `/api/upload`);
the backend attaches the key to the outbound request to OpenAI/Gemini. Never
put an API key directly in `app.js`, `index.html`, or any file under `public/`
— anything in `public/` is downloadable by anyone who opens the page.

## Run it

```bash
npm start
```

Then open **http://localhost:3000** in Chrome or Edge.

1. (Optional) Upload a `.txt` or `.pdf` reading passage for Phase 3.
2. Click **Start Interview** and allow microphone access when prompted.
3. Speak naturally after each question — the app auto-detects when you stop
   talking and sends your answer.
4. After 5 minutes (or when you click **End Session**), a score report modal
   appears with Vocabulary / Grammar / Fluency scores and an overall CEFR-style
   summary.

## Dependencies

Backend (installed via `npm install`):
| Package | Purpose |
|---|---|
| `express` | HTTP server, serves `public/` and the `/api/*` routes |
| `cors` | Allows the frontend to call the backend during local dev |
| `dotenv` | Loads `.env` into `process.env` |
| `multer` | Handles the lesson file upload (multipart/form-data) |
| `pdf-parse` | Extracts text from uploaded `.pdf` lesson files |

Frontend: no build step, no npm packages — plain HTML/CSS/JS using two native
browser APIs (`SpeechRecognition`, `speechSynthesis`).

## Customizing the exam

All exam behavior — persona, phase order, timing, correction style, and the
final report's JSON shape — lives in `buildSystemPrompt()` and
`REPORT_INSTRUCTION` in `server.js`. Phase durations for the UI timer live in
the `PHASES` array at the top of `public/app.js` — **change both together** if
you adjust timing, since the backend prompt currently hardcodes "2 min / 1.5
min / 1.5 min" in its instructions.

## Deploying to Render

This repo includes `render.yaml`, so Render will auto-detect the service config.
See the deployment walkthrough in the chat where this project was generated, or:

1. Push this folder to a GitHub repo.
2. In the Render dashboard: **New → Blueprint**, connect the repo, Render reads `render.yaml`.
3. Fill in `LLM_PROVIDER` and either `OPENAI_API_KEY` or `GEMINI_API_KEY` when prompted
   (these are entered directly in Render's dashboard, never committed to git).
4. Deploy. Render gives you an `https://your-app.onrender.com` URL with HTTPS already handled.

Note: Render's free tier spins the service down after inactivity, so the first
request after idle time takes ~30-50s to wake up.

## Deploying (general, any host)

- Put `.env` values into your host's environment variable settings (Render,
  Railway, Fly.io, a VPS, etc.) — never commit `.env`.
- Serve the app over **HTTPS**. Browsers only allow microphone access
  (`getUserMedia`, which `SpeechRecognition` relies on) on `https://` or
  `localhost` — plain `http://` on a public domain will silently fail to
  access the mic.
- Consider rate-limiting `/api/chat` and `/api/report` if this goes public, since
  each call spends your LLM budget.

## Upgrading to a true Realtime API (optional, future work)

If you later want genuine streaming audio-in/audio-out (e.g. for a more
free-flowing, interruption-aware conversation), the swap point is isolated:
replace the STT→`/api/chat`→TTS turn loop in `app.js`'s `listenForCandidate()` /
`requestExaminerReply()` with a WebSocket connection to a backend relay that:

1. Mints a short-lived ephemeral session token server-side (never expose your
   main API key to the browser for a websocket session).
2. Streams microphone PCM audio up, and receives streamed audio + text back.

The system prompt, phase timing, and score-report logic in `server.js` can be
reused as-is — only the transport layer changes.
