// server.js
// Backend for the AI English Speaking Examiner.
// Responsibilities:
//   1. Serve the static frontend (public/).
//   2. Keep the LLM API key on the server (never sent to the browser).
//   3. Turn conversation turns into examiner replies (POST /api/chat).
//   4. Parse uploaded lesson files - .txt or .pdf - into plain text (POST /api/upload).
//   5. Produce the final score report at the end of the session (POST /api/report).
//
// The browser handles Speech-to-Text and Text-to-Speech itself via the Web
// Speech API, so no audio ever needs to be uploaded here - only text.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase(); // 'openai' | 'gemini'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

if (LLM_PROVIDER === 'openai' && !OPENAI_API_KEY) {
  console.warn('[warn] LLM_PROVIDER=openai but OPENAI_API_KEY is not set in .env');
}
if (LLM_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
  console.warn('[warn] LLM_PROVIDER=gemini but GEMINI_API_KEY is not set in .env');
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// System prompt / examiner persona
// ---------------------------------------------------------------------------

function buildSystemPrompt(lessonText) {
  return `You are "Ms. Ada", a warm but precise professional English Speaking Examiner conducting a
strict 5-minute spoken English assessment over voice. The candidate is speaking to you out loud;
your replies are converted to speech, so:
  - Keep every reply SHORT: 1-3 sentences, unless giving the final report.
  - Never use markdown, bullet points, emojis, or asterisks - plain spoken sentences only.
  - Sound natural and conversational, like a real examiner talking, not a chatbot.

SESSION STRUCTURE (you will be told the current phase and time remaining in each message):
  Phase 1 - Vocabulary (2:00): Ask the candidate to define, use in a sentence, or find synonyms
    for a few everyday words. Increase difficulty gradually. Ask one question at a time.
  Phase 2 - Grammar (1:30): Give short prompts that require correct verb tense, articles,
    prepositions, or sentence structure (e.g. "Tell me what you did yesterday and what you will
    do tomorrow"). Ask one question at a time.
  Phase 3 - Text Analysis (1:30): Base your questions on the LESSON TEXT provided below. Ask the
    candidate to summarize, paraphrase, or give an opinion about it, testing comprehension and
    spoken fluency.

LESSON TEXT for Phase 3 (may be empty if the candidate did not upload one - if empty, use a short
general-interest passage you invent yourself, one paragraph, and mention that no lesson was
provided):
"""
${lessonText && lessonText.trim() ? lessonText.trim().slice(0, 6000) : '(none provided)'}
"""

ERROR CORRECTION: Whenever the candidate makes a grammar or vocabulary mistake, briefly and kindly
correct it out loud in the same turn before continuing (e.g. "Small correction - it's 'I go to
school', not 'I goes'. Now, ...") then move the conversation forward. Do not dwell on it.

PHASE TRANSITIONS: When you receive a system note that a new phase has begun, briefly acknowledge
it in one short sentence ("Great, let's move to grammar now.") and immediately ask the first
question of that phase. Do not summarize the previous phase at length.

TONE: Encouraging, professional, concise. You are evaluating the candidate the entire time, but
you never say numeric scores until the final report.

Never break character and never mention that you are an AI language model.`;
}

const REPORT_INSTRUCTION = `The 5-minute spoken examination has now ended. Based on the ENTIRE
conversation above, produce a final score report. Respond with STRICT JSON ONLY - no markdown
fences, no commentary, matching exactly this shape:
{
  "vocabulary": {"score": <0-10 integer>, "comment": "<one sentence>"},
  "grammar": {"score": <0-10 integer>, "comment": "<one sentence>"},
  "fluency": {"score": <0-10 integer>, "comment": "<one sentence>"},
  "overall": {"score": <0-10 integer>, "level": "<CEFR level e.g. B1>", "summary": "<2-3 sentence spoken-style summary of performance and one concrete tip to improve>"}
}
Return only the JSON object, nothing else.`;

// ---------------------------------------------------------------------------
// LLM callers
// ---------------------------------------------------------------------------

async function callOpenAI(messages, { jsonMode = false } = {}) {
  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.6,
    max_tokens: jsonMode ? 500 : 200,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function callGemini(messages, { jsonMode = false } = {}) {
  // Fold the OpenAI-style {role, content} messages into Gemini's format.
  // System messages become a leading user turn since Gemini's system_instruction
  // field is kept separate here for simplicity.
  const systemMsg = messages.find((m) => m.role === 'system');
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body = {
    contents: turns,
    systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: jsonMode ? 500 : 200,
      responseMimeType: jsonMode ? 'application/json' : 'text/plain',
    },
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.candidates[0].content.parts.map((p) => p.text).join('');
}

async function callLLM(messages, opts = {}) {
  if (LLM_PROVIDER === 'gemini') return callGemini(messages, opts);
  return callOpenAI(messages, opts);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Start a new session: returns the examiner's opening line.
app.post('/api/session/start', async (req, res) => {
  try {
    const { lessonText } = req.body || {};
    const messages = [
      { role: 'system', content: buildSystemPrompt(lessonText) },
      {
        role: 'user',
        content:
          '[SYSTEM NOTE] The session is starting now. Greet the candidate in one short sentence, ' +
          'explain in one sentence that this is a 5-minute spoken test with three phases, then ' +
          'immediately ask the first Phase 1 vocabulary question.',
      },
    ];
    const reply = await callLLM(messages);
    res.json({ reply: reply.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Continue the conversation.
// body: { history: [{role, content}, ...], lessonText, phaseNote (optional) }
app.post('/api/chat', async (req, res) => {
  try {
    const { history = [], lessonText = '', phaseNote = '' } = req.body || {};
    const messages = [
      { role: 'system', content: buildSystemPrompt(lessonText) },
      ...history,
    ];
    if (phaseNote) {
      messages.push({ role: 'user', content: `[SYSTEM NOTE] ${phaseNote}` });
    }
    const reply = await callLLM(messages);
    res.json({ reply: reply.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Final score report.
// body: { history: [{role, content}, ...], lessonText }
app.post('/api/report', async (req, res) => {
  try {
    const { history = [], lessonText = '' } = req.body || {};
    const messages = [
      { role: 'system', content: buildSystemPrompt(lessonText) },
      ...history,
      { role: 'user', content: `[SYSTEM NOTE] ${REPORT_INSTRUCTION}` },
    ];
    const raw = await callLLM(messages, { jsonMode: true });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }
    if (!parsed) throw new Error('Could not parse score report JSON from model output.');
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Lesson file upload -> plain text extraction (.txt or .pdf).
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { originalname, buffer, mimetype } = req.file;

    let text = '';
    if (mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) {
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      text = buffer.toString('utf-8');
    }

    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return res.status(422).json({ error: 'No extractable text found in file.' });

    res.json({ text: text.slice(0, 8000) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AI English Examiner backend running on http://localhost:${PORT}`);
  console.log(`LLM provider: ${LLM_PROVIDER}`);
});
