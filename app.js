// app.js — AI English Speaking Examiner (frontend)
//
// Speech-to-Text and Text-to-Speech both run natively in the browser via the
// Web Speech API. The browser only ever sends TEXT to the backend; the
// backend calls the LLM (with the API key kept server-side) and returns the
// examiner's next line as text, which we then speak locally.

const PHASES = [
  { id: 1, name: 'Vocabulary', seconds: 120 },
  { id: 2, name: 'Grammar', seconds: 90 },
  { id: 3, name: 'Text Analysis', seconds: 90 },
];

const el = {
  statusChip: document.getElementById('statusChip'),
  statusText: document.getElementById('statusText'),
  statusLine: document.getElementById('statusLine'),
  orb: document.getElementById('orb'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  uploadCard: document.getElementById('uploadCard'),
  dropzone: document.getElementById('dropzone'),
  lessonFile: document.getElementById('lessonFile'),
  fileName: document.getElementById('fileName'),
  transcript: document.getElementById('transcript'),
  phaseStubs: Array.from(document.querySelectorAll('.phase-stub')),
  reportOverlay: document.getElementById('reportOverlay'),
  reportBody: document.getElementById('reportBody'),
  closeReportBtn: document.getElementById('closeReportBtn'),
  micNote: document.getElementById('micNote'),
};

const state = {
  lessonText: '',
  history: [],           // [{role: 'user'|'assistant', content: string}]
  phaseIndex: 0,          // 0,1,2 -> PHASES
  phaseSecondsLeft: PHASES[0].seconds,
  sessionActive: false,
  awaitingPendingPhaseNote: null,
  phaseTimerId: null,
  recognition: null,
  isListeningTurn: false,
};

// ---------------------------------------------------------------------------
// Lesson file upload
// ---------------------------------------------------------------------------

el.dropzone.addEventListener('click', () => el.lessonFile.click());
el.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropzone.classList.add('drag-over'); });
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('drag-over'));
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleLessonFile(e.dataTransfer.files[0]);
});
el.lessonFile.addEventListener('change', () => {
  if (el.lessonFile.files[0]) handleLessonFile(el.lessonFile.files[0]);
});

async function handleLessonFile(file) {
  el.fileName.textContent = `Reading "${file.name}"…`;
  try {
    if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
      state.lessonText = await file.text();
    } else {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      state.lessonText = data.text;
    }
    el.fileName.textContent = `✓ "${file.name}" loaded (${state.lessonText.length.toLocaleString()} chars)`;
  } catch (err) {
    console.error(err);
    el.fileName.textContent = `Could not read file: ${err.message}`;
    state.lessonText = '';
  }
}

// ---------------------------------------------------------------------------
// Speech recognition (STT) setup
// ---------------------------------------------------------------------------

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

function createRecognition() {
  if (!SpeechRecognitionImpl) return null;
  const rec = new SpeechRecognitionImpl();
  rec.lang = 'en-US';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) { resolve(); return; }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.pitch = 1.0;
    utter.lang = 'en-US';
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /en-US|en_US/.test(v.lang) && /female|Samantha|Google US English/i.test(v.name))
      || voices.find((v) => v.lang === 'en-US');
    if (preferred) utter.voice = preferred;
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });
}

// ---------------------------------------------------------------------------
// Status / UI helpers
// ---------------------------------------------------------------------------

function setStatus(mode, label) {
  // mode: idle | listening | thinking | speaking
  el.statusChip.className = `status-chip status-${mode}`;
  el.statusText.textContent = label;
  el.orb.className = `orb ${mode === 'idle' ? '' : mode}`.trim();
  el.statusLine.textContent = label;
}

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (role === 'examiner' || role === 'candidate') {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'examiner' ? 'Ada' : 'You';
    div.appendChild(who);
  }
  const body = document.createElement('span');
  body.textContent = text;
  div.appendChild(body);
  el.transcript.appendChild(div);
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function renderPhaseStrip() {
  el.phaseStubs.forEach((stub, i) => {
    stub.classList.toggle('active', i === state.phaseIndex);
    stub.classList.toggle('done', i < state.phaseIndex);
    const timeEl = stub.querySelector('.phase-time');
    if (i === state.phaseIndex) {
      timeEl.textContent = formatTime(state.phaseSecondsLeft);
    } else if (i < state.phaseIndex) {
      timeEl.textContent = 'Done';
    } else {
      timeEl.textContent = formatTime(PHASES[i].seconds);
    }
  });
}

// ---------------------------------------------------------------------------
// Phase timer
// ---------------------------------------------------------------------------

function startPhaseTimer() {
  clearInterval(state.phaseTimerId);
  state.phaseTimerId = setInterval(() => {
    if (!state.sessionActive) return;
    state.phaseSecondsLeft -= 1;
    renderPhaseStrip();
    if (state.phaseSecondsLeft <= 0) {
      advancePhase();
    }
  }, 1000);
}

function advancePhase() {
  if (state.phaseIndex >= PHASES.length - 1) {
    // Final phase just ended -> end the whole session.
    endSession(true);
    return;
  }
  state.phaseIndex += 1;
  state.phaseSecondsLeft = PHASES[state.phaseIndex].seconds;
  state.awaitingPendingPhaseNote =
    `Time is up for the previous phase. Begin Phase ${PHASES[state.phaseIndex].id} - ${PHASES[state.phaseIndex].name} now.`;
  renderPhaseStrip();
}

// ---------------------------------------------------------------------------
// Conversation turn loop
// ---------------------------------------------------------------------------

async function beginSession() {
  state.sessionActive = true;
  state.history = [];
  state.phaseIndex = 0;
  state.phaseSecondsLeft = PHASES[0].seconds;
  renderPhaseStrip();
  startPhaseTimer();

  el.uploadCard.hidden = true;
  el.startBtn.hidden = true;
  el.stopBtn.hidden = false;
  el.transcript.innerHTML = '';

  setStatus('thinking', 'Preparing your exam…');
  try {
    const resp = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonText: state.lessonText }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to start session');

    state.history.push({ role: 'assistant', content: data.reply });
    addBubble('examiner', data.reply);

    setStatus('speaking', 'Ada is speaking…');
    await speak(data.reply);
    if (state.sessionActive) listenForCandidate();
  } catch (err) {
    console.error(err);
    addBubble('system', `Could not start session: ${err.message}`);
    endSession(false);
  }
}

function listenForCandidate() {
  if (!state.sessionActive) return;
  const rec = createRecognition();
  if (!rec) {
    addBubble('system', 'Speech recognition is not supported in this browser. Try Chrome or Edge.');
    return;
  }
  state.recognition = rec;
  let finalText = '';

  setStatus('listening', 'Listening…');

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk;
      else interim += chunk;
    }
    el.statusLine.textContent = interim ? `Listening… "${interim}"` : 'Listening…';
  };

  rec.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('Speech recognition error:', event.error);
  };

  rec.onend = async () => {
    if (!state.sessionActive) return;
    const text = finalText.trim();
    if (!text) {
      // Nothing captured (silence/timeout) — just listen again.
      listenForCandidate();
      return;
    }
    state.history.push({ role: 'user', content: text });
    addBubble('candidate', text);
    await requestExaminerReply();
  };

  try {
    rec.start();
  } catch (err) {
    console.error(err);
  }
}

async function requestExaminerReply() {
  if (!state.sessionActive) return;
  setStatus('thinking', 'Ada is thinking…');
  const phaseNote = state.awaitingPendingPhaseNote;
  state.awaitingPendingPhaseNote = null;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: state.history,
        lessonText: state.lessonText,
        phaseNote,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Chat request failed');

    state.history.push({ role: 'assistant', content: data.reply });
    addBubble('examiner', data.reply);

    setStatus('speaking', 'Ada is speaking…');
    await speak(data.reply);
    if (state.sessionActive) listenForCandidate();
  } catch (err) {
    console.error(err);
    addBubble('system', `Connection issue: ${err.message}. Listening again…`);
    if (state.sessionActive) listenForCandidate();
  }
}

// ---------------------------------------------------------------------------
// End of session + report
// ---------------------------------------------------------------------------

async function endSession(natural) {
  if (!state.sessionActive) return;
  state.sessionActive = false;
  clearInterval(state.phaseTimerId);
  if (state.recognition) {
    try { state.recognition.onend = null; state.recognition.stop(); } catch {}
  }
  window.speechSynthesis.cancel();

  el.stopBtn.hidden = true;
  setStatus('thinking', 'Generating your score report…');

  if (state.history.length < 2) {
    setStatus('idle', 'Session ended');
    resetForNewSession();
    return;
  }

  try {
    const resp = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: state.history, lessonText: state.lessonText }),
    });
    const report = await resp.json();
    if (!resp.ok) throw new Error(report.error || 'Report generation failed');
    showReport(report);
  } catch (err) {
    console.error(err);
    addBubble('system', `Could not generate report: ${err.message}`);
  } finally {
    setStatus('idle', 'Session ended');
    resetForNewSession();
  }
}

function scoreRow(label, scoreObj) {
  const pct = Math.max(0, Math.min(10, scoreObj.score)) * 10;
  return `
    <div>
      <div class="score-row">
        <span class="score-label">${label}</span>
        <span class="score-value">${scoreObj.score}/10</span>
      </div>
      <div class="score-bar"><div class="score-bar-fill" style="width:${pct}%"></div></div>
      <p class="score-comment">${scoreObj.comment || ''}</p>
    </div>`;
}

function showReport(report) {
  el.reportBody.innerHTML = `
    ${scoreRow('Vocabulary', report.vocabulary)}
    ${scoreRow('Grammar', report.grammar)}
    ${scoreRow('Fluency', report.fluency)}
    <div class="overall-block">
      <span class="overall-level">${report.overall?.level || '—'} · ${report.overall?.score ?? '—'}/10 overall</span>
      <p class="overall-summary">${report.overall?.summary || ''}</p>
    </div>
  `;
  el.reportOverlay.hidden = false;
}

el.closeReportBtn.addEventListener('click', () => { el.reportOverlay.hidden = true; });

function resetForNewSession() {
  el.uploadCard.hidden = false;
  el.startBtn.hidden = false;
  el.startBtn.disabled = false;
  state.phaseIndex = 0;
  state.phaseSecondsLeft = PHASES[0].seconds;
  renderPhaseStrip();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.startBtn.addEventListener('click', () => {
  if (!SpeechRecognitionImpl) {
    alert('Your browser does not support the Web Speech API for voice input. Please use Google Chrome or Microsoft Edge on desktop.');
    return;
  }
  el.startBtn.disabled = true;
  beginSession();
});

el.stopBtn.addEventListener('click', () => endSession(false));

renderPhaseStrip();

if (!SpeechRecognitionImpl) {
  el.micNote.textContent = 'Voice input is not supported in this browser. Please switch to Chrome or Edge on desktop.';
  el.micNote.style.color = 'var(--rose)';
}
