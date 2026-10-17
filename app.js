// Talkloop client: speech in, AI character turn out, spoken back with word highlighting.
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  history: [],
  rapport: 0,
  busy: false,
  finished: false,
  handsFree: false, // when true, the mic listens, auto-sends on a pause, and resumes after each reply
};

const SILENCE_MS = 2500; // how long a pause ends your turn in hands-free mode

// ---------- persistence (per-browser conveniences only) ----------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode); the app still works without it.
    }
  },
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function bumpStreak() {
  const streak = store.get("streak", { count: 0, last: null });
  const now = today();
  if (streak.last === now) return streak.count;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  streak.count = streak.last === yesterday ? streak.count + 1 : 1;
  streak.last = now;
  store.set("streak", streak);
  return streak.count;
}

function renderStats() {
  $("streak").textContent = `🔥 ${store.get("streak", { count: 0 }).count}`;
  $("rapport").textContent = `♥ ${state.rapport}`;
}

// ---------- Gemini API (called directly from the browser with the user's key) ----------
const CONV_MODEL = "gemini-flash-lite-latest";
const TTS_MODEL = "gemini-3.8-flash-tts";
const TTS_VOICE = "Kore";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function getKey() {
  try {
    return localStorage.getItem("gemini_key") || "";
  } catch {
    return "";
  }
}
function setKey(k) {
  try {
    if (k) localStorage.setItem("gemini_key", k);
    else localStorage.removeItem("gemini_key");
  } catch {
    // storage unavailable; key lives only for this page load
  }
}

const SCENARIOS = {
  cafe: { character: "Inès", setting: "a barista at a busy neighbourhood café who loves recommending pastries" },
  market: { character: "Tomás", setting: "a fruit seller at an outdoor market who haggles playfully" },
  station: { character: "Yuki", setting: "a helpful ticket clerk at a train station during rush hour" },
};

// A general partner used by the AI-led modes (not tied to a scene).
const PARTNER = { character: "Mika", setting: "a warm, patient native-speaker conversation partner and language buddy" };

// Conversation modes. Open modes never end on their own — they run until you quit.
const MODES = {
  lead: {
    label: "Free chat — the partner leads",
    usesScene: false,
    endable: false,
    opener: "(Start the conversation. Greet the learner warmly and ask one easy opening question.)",
    extra: "You lead the whole conversation. Always finish your reply with a question that keeps it going. Follow up on what the learner says, gently change topic when one runs dry, and keep it light and encouraging. Never end the conversation: always set conversation_finished to false.",
  },
  interview: {
    label: "Interview me",
    usesScene: false,
    endable: false,
    opener: "(Greet the learner and ask their name or how their day is going.)",
    extra: "Interview the learner about their life, day, hobbies, work and opinions. Ask one question at a time, react to the answer, then ask a natural follow-up. Never end: always set conversation_finished to false.",
  },
  topic: {
    label: "Discuss a topic",
    usesScene: false,
    endable: false,
    opener: "(Pick a light, everyday topic suited to the learner's level — food, travel, films, weekend plans — introduce it in one line and ask the learner what they think.)",
    extra: "Have a back-and-forth discussion about an everyday topic at the learner's level. Share a short opinion, then ask what they think. Keep it flowing and never end: always set conversation_finished to false.",
  },
  scene: {
    label: "Scene role-play",
    usesScene: true,
    endable: true,
    opener: "(The learner walks up. Greet them and open the scene.)",
    extra: "Play out the scene naturally. Let it reach a natural end only after several exchanges, and only then set conversation_finished to true.",
  },
};

// ---------- Vocabulary (user-imported, stored locally in IndexedDB) ----------
const VOCAB_DB = "talkloop";
const VOCAB_KV = "kv";

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(VOCAB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(VOCAB_KV);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_KV, "readwrite");
    tx.objectStore(VOCAB_KV).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_KV, "readonly");
    const rq = tx.objectStore(VOCAB_KV).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

// Flatten the nested { levels: { A1: { nouns: { der:[...] }, verbs:[...] } } } shape
// into a flat list of { de, en, example, level, cat }.
function flattenVocab(json) {
  const out = [];
  const levels = json?.levels ?? {};
  const add = (e, level, cat) => {
    if (e && e.de) out.push({ de: e.de, en: e.en ?? "", example: e.example ?? "", level, cat });
  };
  for (const level of Object.keys(levels)) {
    const cats = levels[level] ?? {};
    for (const cat of Object.keys(cats)) {
      const v = cats[cat];
      if (Array.isArray(v)) v.forEach((e) => add(e, level, cat));
      else if (v && typeof v === "object") {
        for (const sub of Object.keys(v)) {
          if (Array.isArray(v[sub])) v[sub].forEach((e) => add(e, level, cat));
        }
      }
    }
  }
  return out;
}

async function importVocab(file) {
  const json = JSON.parse(await file.text());
  const words = flattenVocab(json);
  if (!words.length) throw new Error("No vocabulary found in that file.");
  await idbSet("vocab_words", words);
  await idbSet("vocab_seen", []);
  return { count: words.length, levels: [...new Set(words.map((w) => w.level))].sort() };
}

async function vocabMeta() {
  const words = (await idbGet("vocab_words")) ?? [];
  return { count: words.length, levels: [...new Set(words.map((w) => w.level))].sort() };
}

// In-memory state for the active session.
let vocabWords = [];
let vocabPointer = 0;
let vocabSeen = new Set();

async function loadVocabForSession(levels) {
  const all = (await idbGet("vocab_words")) ?? [];
  vocabWords = all.filter((w) => levels.includes(w.level));
  for (let i = vocabWords.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [vocabWords[i], vocabWords[j]] = [vocabWords[j], vocabWords[i]];
  }
  vocabSeen = new Set((await idbGet("vocab_seen")) ?? []);
  vocabPointer = 0;
  return vocabWords.length;
}

// Pick the next rotating batch of words to weave into the conversation.
function nextVocabBatch(n = 12) {
  if (!vocabWords.length) return [];
  const batch = [];
  for (let scanned = 0; batch.length < n && scanned < vocabWords.length; scanned++) {
    batch.push(vocabWords[vocabPointer % vocabWords.length]);
    vocabPointer++;
  }
  batch.forEach((w) => vocabSeen.add(w.de));
  idbSet("vocab_seen", [...vocabSeen]).catch(() => {});
  return batch;
}

const TURN_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    reply_translation: { type: "STRING" },
    suggestions: { type: "ARRAY", items: { type: "STRING" } },
    coach: {
      type: "OBJECT",
      properties: { understood: { type: "BOOLEAN" }, correction: { type: "STRING" }, tip: { type: "STRING" } },
      required: ["understood", "correction", "tip"],
    },
    rapport_delta: { type: "INTEGER" },
    conversation_finished: { type: "BOOLEAN" },
  },
  required: ["reply", "reply_translation", "suggestions", "coach", "rapport_delta", "conversation_finished"],
};

const WORD_SCHEMA = {
  type: "OBJECT",
  properties: {
    word: { type: "STRING" },
    translation: { type: "STRING" },
    part_of_speech: { type: "STRING" },
    pronunciation: { type: "STRING" },
    example: { type: "STRING" },
    example_translation: { type: "STRING" },
  },
  required: ["word", "translation", "part_of_speech", "pronunciation", "example", "example_translation"],
};

function personaFor({ scenario, mode }) {
  const m = MODES[mode] ?? MODES.scene;
  return m.usesScene ? SCENARIOS[scenario] ?? SCENARIOS.cafe : PARTNER;
}

function turnSystemPrompt({ language, nativeLanguage, level, scenario, mode }, targetWords = []) {
  const m = MODES[mode] ?? MODES.scene;
  const persona = personaFor({ scenario, mode });
  const lines = [
    `You are ${persona.character}, ${persona.setting}. Stay in character and speak only ${language}.`,
    `The learner is a ${level} ${language} speaker whose native language is ${nativeLanguage}.`,
    "Keep each reply to one or two short sentences that match the learner's level, and end with something they can respond to.",
    m.extra,
    "Speech recognition produced the learner's message, so ignore missing punctuation and obvious transcription slips.",
    `Write reply_translation, coach.tip and nothing else in ${nativeLanguage}.`,
    "Give a correction only when the learner made a real grammar or word-choice mistake.",
  ];
  if (targetWords.length) {
    const list = targetWords.map((w) => (w.en ? `${w.de} (${w.en})` : w.de)).join("; ");
    lines.push(
      `The learner is practising this vocabulary. Naturally weave two to four of these words or phrases into your reply where they fit — do not force all of them, keep it natural, and give the learner a chance to use them too: ${list}.`,
    );
  }
  return lines.join("\n");
}

async function geminiJson({ systemInstruction, schema, contents }) {
  const key = getKey();
  if (!key) throw new Error("Add your Gemini API key to start.");
  const res = await fetch(`${API_BASE}/${CONV_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.8 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? `Request failed (${res.status})`);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The model returned an unreadable response. Please try again.");
  }
}

function historyToContents(history, userText) {
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  contents.push({ role: "user", parts: [{ text: userText }] });
  return contents;
}

async function geminiTurn(settings, history, message) {
  const mode = MODES[settings.request.mode] ?? MODES.scene;
  const userText = message.trim() || mode.opener;
  const targetWords = settings.vocab?.enabled ? nextVocabBatch() : [];
  const turn = await geminiJson({
    systemInstruction: turnSystemPrompt(settings.request, targetWords),
    schema: TURN_SCHEMA,
    contents: historyToContents(history, userText),
  });
  turn.focusWords = targetWords;
  // In open modes the conversation never ends on its own.
  if (!mode.endable) turn.conversation_finished = false;
  return { turn, userText };
}

async function geminiWord({ word, sentence, language, nativeLanguage }) {
  return geminiJson({
    systemInstruction: `You are a concise ${language} dictionary for a ${nativeLanguage} speaker. Write translations in ${nativeLanguage}.`,
    schema: WORD_SCHEMA,
    contents: [{ role: "user", parts: [{ text: `Explain the word "${word}" as it is used in: "${sentence}"` }] }],
  });
}

// Gemini TTS returns raw PCM; wrap it in a WAV data URL the browser can play.
function pcmBase64ToWavUrl(b64, sampleRate = 24000) {
  const bin = atob(b64);
  const pcm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  const blockAlign = 2;
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.length, true);
  const blob = new Blob([header, pcm], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

async function geminiTts(text) {
  const key = getKey();
  if (!key) return null;
  const res = await fetch(`${API_BASE}/${TTS_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
      },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) return null;
  const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? "");
  return pcmBase64ToWavUrl(part.inlineData.data, rate ? Number(rate[1]) : 24000);
}

// ---------- speech recognition (browser) ----------
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognizer = null;

function startListening() {
  if (!Recognition) {
    setStatus("Voice input needs Chrome or Edge. You can still type.");
    return;
  }
  stopSpeaking();
  recognizer = new Recognition();
  recognizer.lang = state.settings.locale;
  recognizer.interimResults = true;
  // Keep listening through pauses; a longer silence ends the turn.
  recognizer.continuous = true;

  let finalText = "";
  let silenceTimer = null;
  const armSilence = () => {
    clearTimeout(silenceTimer);
    // Auto-stop after a pause so the turn sends hands-free. You get time to think.
    silenceTimer = setTimeout(() => recognizer?.stop(), SILENCE_MS);
  };

  recognizer.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    $("live").textContent = (finalText + interim).trim();
    if (finalText.trim()) armSilence();
  };
  recognizer.onerror = (event) => {
    if (event.error === "no-speech") setStatus("I'm listening… take your time.");
    else if (event.error === "not-allowed") { state.handsFree = false; setStatus("Microphone permission was denied."); }
    else if (event.error !== "aborted") setStatus(`Speech recognition error: ${event.error}`);
  };
  recognizer.onend = () => {
    clearTimeout(silenceTimer);
    recognizer = null;
    setMic(false);
    $("live").textContent = "";
    const spoken = finalText.trim();
    if (spoken) {
      // Hands-free: send straight away. Listening resumes after the reply is spoken.
      sendTurn(spoken);
    } else if (state.handsFree) {
      // Nothing heard but still hands-free (e.g. restarted too soon) — keep listening.
      maybeResumeListening();
    } else {
      setStatus("");
    }
  };
  recognizer.start();
  setMic(true);
  setStatus("Listening… just talk. Tap the mic to stop hands-free.");
}

function stopListening() {
  state.handsFree = false;
  recognizer?.stop();
  setStatus("Hands-free off.");
}

function setMic(on) {
  $("mic").setAttribute("aria-pressed", String(on));
}

// ---------- speech synthesis with word highlighting ----------
// Rank voices so the browser's natural/neural (cloud) voice for the locale wins
// over the default robotic one.
function voiceFor(locale) {
  const voices = speechSynthesis.getVoices();
  const lang = locale.split("-")[0];
  const candidates = voices.filter((v) => v.lang === locale || v.lang.replace("_", "-").startsWith(lang));
  if (candidates.length === 0) return null;

  const score = (v) => {
    let s = 0;
    const name = v.name.toLowerCase();
    if (v.lang === locale || v.lang.replace("_", "-") === locale) s += 40; // exact region
    if (!v.localService) s += 30; // online voices are the high-quality neural ones
    if (/(natural|neural|wavenet|premium|enhanced|siri|multilingual)/.test(name)) s += 25;
    if (/google|microsoft/.test(name)) s += 10;
    if (/compact|espeak|pico/.test(name)) s -= 20; // known robotic engines
    return s;
  };

  return candidates.slice().sort((a, b) => score(b) - score(a))[0];
}

let currentAudio = null;

// Speak with the native-sounding cloud voice; fall back to the browser voice
// if the server TTS is unavailable.
async function speak(text, wordSpans, onDone) {
  stopSpeaking();
  const rate = state.settings.level === "beginner" ? 0.9 : 1;
  // Make sure the done callback fires exactly once, whichever path plays.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (typeof onDone === "function") onDone();
  };
  try {
    const wavUrl = await geminiTts(text);
    if (wavUrl) {
      playCloudAudio(wavUrl, wordSpans, finish);
      return;
    }
  } catch {
    // TTS unavailable (quota/network) — fall through to the browser voice
  }
  browserSpeak(text, rate, wordSpans, finish);
}

function playCloudAudio(wavUrl, wordSpans, onDone) {
  const audio = new Audio(wavUrl);
  currentAudio = audio;
  // Approximate karaoke highlight: spread words across the clip's duration.
  audio.ontimeupdate = () => {
    if (!audio.duration) return;
    const i = Math.min(wordSpans.length - 1, Math.floor((audio.currentTime / audio.duration) * wordSpans.length));
    wordSpans.forEach((span, idx) => span.classList.toggle("speaking", idx === i));
  };
  const clear = () => {
    wordSpans.forEach((span) => span.classList.remove("speaking"));
    URL.revokeObjectURL(wavUrl);
    if (typeof onDone === "function") onDone();
  };
  audio.onended = clear;
  audio.onerror = clear;
  audio.play().catch(() => clear());
}

function browserSpeak(text, rate, wordSpans, onDone) {
  if (!("speechSynthesis" in window)) {
    if (typeof onDone === "function") onDone();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = state.settings.locale;
  const voice = voiceFor(state.settings.locale);
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.onboundary = (event) => {
    if (event.name && event.name !== "word") return;
    wordSpans.forEach((span) => span.classList.toggle(
      "speaking",
      event.charIndex >= Number(span.dataset.start) && event.charIndex < Number(span.dataset.end),
    ));
  };
  const clear = () => {
    wordSpans.forEach((span) => span.classList.remove("speaking"));
    if (typeof onDone === "function") onDone();
  };
  utterance.onend = clear;
  utterance.onerror = clear;
  speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- transcript rendering ----------
function wordify(container, text, sentence) {
  const spans = [];
  // Split into word and non-word runs while keeping character offsets for TTS boundaries.
  for (const match of text.matchAll(/[\p{L}\p{M}'’-]+|[^\p{L}\p{M}'’-]+/gu)) {
    const chunk = match[0];
    if (/\p{L}/u.test(chunk)) {
      const span = document.createElement("span");
      span.className = "word";
      span.textContent = chunk;
      span.dataset.start = String(match.index);
      span.dataset.end = String(match.index + chunk.length);
      span.addEventListener("click", () => openExplorer(chunk, sentence));
      container.append(span);
      spans.push(span);
    } else {
      container.append(document.createTextNode(chunk));
    }
  }
  return spans;
}

function addCharacterMessage(turn) {
  const li = document.createElement("li");
  li.className = "msg character";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = state.settings.characterName;
  const line = document.createElement("div");
  const spans = wordify(line, turn.reply, turn.reply);

  const translation = document.createElement("div");
  translation.className = "translation";
  translation.textContent = turn.reply_translation;
  translation.hidden = true;

  const tools = document.createElement("div");
  tools.className = "tools";
  const replay = document.createElement("button");
  replay.textContent = "▶ Replay";
  replay.addEventListener("click", () => speak(turn.reply, spans));
  const translate = document.createElement("button");
  translate.textContent = "Translate";
  translate.addEventListener("click", () => {
    translation.hidden = !translation.hidden;
  });
  tools.append(replay, translate);

  li.append(who, line, translation, tools);
  $("transcript").append(li);
  li.scrollIntoView({ behavior: "smooth", block: "end" });
  // When hands-free, start listening again once the character finishes speaking.
  speak(turn.reply, spans, () => maybeResumeListening());
}

function maybeResumeListening() {
  if (state.handsFree && !state.finished && !recognizer) {
    startListening();
  }
}

function addLearnerMessage(text) {
  const li = document.createElement("li");
  li.className = "msg learner";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = "You";
  li.append(who, document.createTextNode(text));
  $("transcript").append(li);
}

function renderCoach(coach) {
  const box = $("coach");
  box.replaceChildren();
  if (!coach.correction && !coach.tip && coach.understood) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle("has-correction", Boolean(coach.correction));
  if (!coach.understood) {
    const p = document.createElement("p");
    p.textContent = "That didn't quite land. Try one of the suggestions below.";
    box.append(p);
  }
  if (coach.correction) {
    const p = document.createElement("p");
    p.innerHTML = "<strong>More natural:</strong> ";
    p.append(document.createTextNode(coach.correction));
    box.append(p);
  }
  if (coach.tip) {
    const p = document.createElement("p");
    p.textContent = coach.tip;
    box.append(p);
  }
}

function renderSuggestions(suggestions) {
  const box = $("suggestions");
  box.replaceChildren();
  for (const text of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      $("text").value = text;
      $("text").focus();
    });
    box.append(chip);
  }
}

function renderFocusWords(words) {
  const box = $("focus");
  if (!box) return;
  if (!words || !words.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const label = document.createElement("span");
  label.className = "focus-label";
  label.textContent = "Practising: ";
  box.append(label);
  for (const w of words) {
    const chip = document.createElement("span");
    chip.className = "focus-word";
    chip.textContent = w.de;
    chip.title = w.en;
    box.append(chip);
  }
}

function setStatus(text) {
  $("status").textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  for (const el of $("composer").querySelectorAll("button, input")) el.disabled = busy || state.finished;
}

// ---------- conversation turns ----------
async function sendTurn(message) {
  if (state.busy || state.finished) return;
  if (message) addLearnerMessage(message);
  setBusy(true);
  setStatus(`${state.settings.characterName} is thinking…`);
  const slowHint = setTimeout(() => setStatus("Still thinking… longer replies take a moment."), 6000);
  try {
    const { turn, userText } = await geminiTurn(state.settings, state.history, message);
    state.history.push({ role: "user", content: message || userText });
    state.history.push({ role: "assistant", content: turn.reply });

    state.rapport = Math.max(0, state.rapport + Math.max(-2, Math.min(2, turn.rapport_delta)));
    addCharacterMessage(turn);
    if (message) renderCoach(turn.coach);
    renderSuggestions(turn.suggestions);
    renderFocusWords(turn.focusWords);
    renderStats();

    if (turn.conversation_finished) {
      state.finished = true;
      renderSuggestions([]);
      setStatus("Scene complete! Refresh to start another.");
    } else {
      setStatus("");
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    clearTimeout(slowHint);
    setBusy(false);
  }
}

// ---------- word explorer & bookmarks ----------
async function openExplorer(word, sentence) {
  const panel = $("explorer");
  const body = $("explorer-body");
  panel.hidden = false;
  body.textContent = `Looking up “${word}”…`;
  try {
    const info = await geminiWord({
      word,
      sentence,
      language: state.settings.request.language,
      nativeLanguage: state.settings.request.nativeLanguage,
    });
    body.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = `${info.word} — ${info.translation}`;
    const meta = document.createElement("p");
    meta.textContent = `${info.part_of_speech} · say it: ${info.pronunciation}`;
    const example = document.createElement("p");
    example.textContent = `${info.example} (${info.example_translation})`;
    const actions = document.createElement("div");
    actions.className = "tools";
    const listen = document.createElement("button");
    listen.textContent = "▶ Listen";
    listen.addEventListener("click", () => speak(info.word, []));
    const save = document.createElement("button");
    save.textContent = "★ Save word";
    save.addEventListener("click", () => {
      saveBookmark(info);
      save.textContent = "Saved";
      save.disabled = true;
    });
    actions.append(listen, save);
    body.append(title, meta, example, actions);
  } catch (error) {
    body.textContent = error.message;
  }
}

function saveBookmark(info) {
  const bookmarks = store.get("bookmarks", []);
  if (!bookmarks.some((b) => b.word === info.word && b.language === state.settings.request.language)) {
    bookmarks.unshift({ word: info.word, translation: info.translation, language: state.settings.request.language });
    store.set("bookmarks", bookmarks.slice(0, 200));
  }
  renderBookmarks();
}

function renderBookmarks() {
  const list = $("bookmarks");
  list.replaceChildren();
  const bookmarks = store.get("bookmarks", []);
  if (bookmarks.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Tap any word the character says to look it up and save it.";
    list.append(li);
    return;
  }
  for (const b of bookmarks) {
    const li = document.createElement("li");
    li.textContent = `${b.word} — ${b.translation} `;
    const lang = document.createElement("span");
    lang.className = "muted";
    lang.textContent = `(${b.language})`;
    li.append(lang);
    list.append(li);
  }
}

// ---------- wiring ----------
const CHARACTER_NAMES = { cafe: "Inès", market: "Tomás", station: "Yuki" };

// Show the key box or the setup, depending on whether a key is already saved.
function refreshKeyGate() {
  const haveKey = Boolean(getKey());
  $("keygate").hidden = haveKey;
  $("setup").hidden = !haveKey;
  if (haveKey) $("key-saved").hidden = false;
}

$("save-key").addEventListener("click", () => {
  const value = $("api-key").value.trim();
  if (!value) {
    $("key-status").textContent = "Paste your Gemini API key first.";
    return;
  }
  setKey(value);
  $("api-key").value = "";
  $("key-status").textContent = "";
  refreshKeyGate();
});

$("change-key").addEventListener("click", () => {
  setKey("");
  $("key-saved").hidden = true;
  refreshKeyGate();
});

$("start").addEventListener("click", async () => {
  const languageSelect = $("language");
  const scenario = $("scenario").value;
  const mode = $("mode").value;
  const usesScene = (MODES[mode] ?? MODES.scene).usesScene;
  const useVocab = $("use-vocab").checked && !$("use-vocab").disabled;
  const levels = ["A1", "A2", "B1"].filter((l) => $(`vlev-${l}`)?.checked);

  let vocab = { enabled: false };
  if (useVocab) {
    const loaded = await loadVocabForSession(levels.length ? levels : ["A1", "A2", "B1"]);
    vocab = { enabled: loaded > 0, levels };
  }

  state.settings = {
    locale: languageSelect.selectedOptions[0].dataset.locale,
    level: $("level").value,
    characterName: usesScene ? CHARACTER_NAMES[scenario] : PARTNER.character,
    vocab,
    request: {
      language: languageSelect.value,
      nativeLanguage: $("native").value,
      level: $("level").value,
      scenario,
      mode,
    },
  };
  bumpStreak();
  renderStats();
  $("setup").hidden = true;
  $("conversation").hidden = false;
  sendTurn("");
});

// Import a vocab JSON file into the browser (IndexedDB).
$("vocab-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $("vocab-status").textContent = "Importing…";
  try {
    const { count, levels } = await importVocab(file);
    $("vocab-status").textContent = `✓ ${count} words imported (${levels.join(", ")}).`;
    refreshVocabUI(count);
  } catch (error) {
    $("vocab-status").textContent = `Import failed: ${error.message}`;
  }
  event.target.value = "";
});

function refreshVocabUI(count) {
  const useVocab = $("use-vocab");
  const have = count > 0;
  useVocab.disabled = !have;
  $("vocab-levels").style.opacity = have ? "1" : "0.5";
  if (have && !$("vocab-status").textContent) {
    $("vocab-status").textContent = `✓ ${count} words ready.`;
  }
}

// The scene only matters in scene role-play; grey it out otherwise.
$("mode").addEventListener("change", () => {
  const usesScene = (MODES[$("mode").value] ?? MODES.scene).usesScene;
  $("scenario").disabled = !usesScene;
  $("scenario").closest("label").style.opacity = usesScene ? "1" : "0.5";
});

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  stopSpeaking();
  sendTurn(text);
});

$("mic").addEventListener("click", () => {
  if (state.handsFree || $("mic").getAttribute("aria-pressed") === "true") {
    stopListening();
  } else {
    state.handsFree = true; // hands-free loop: talk, auto-send on pause, resume after each reply
    startListening();
  }
});

$("explorer-close").addEventListener("click", () => {
  $("explorer").hidden = true;
});

// Quit the current conversation and return to the start screen.
$("end").addEventListener("click", () => {
  stopListening();
  stopSpeaking();
  state.history = [];
  state.rapport = 0;
  state.finished = false;
  state.handsFree = false;
  $("transcript").replaceChildren();
  $("coach").hidden = true;
  $("suggestions").replaceChildren();
  $("live").textContent = "";
  $("text").value = "";
  setStatus("");
  renderStats();
  $("conversation").hidden = true;
  $("setup").hidden = false;
});

// Voices load asynchronously in Chrome.
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

refreshKeyGate();
renderStats();
renderBookmarks();
vocabMeta().then((m) => refreshVocabUI(m.count)).catch(() => {});
