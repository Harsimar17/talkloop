// Talkloop client: speech in, AI character turn out, spoken back with word highlighting.
import { hasPiperVoice, piperLoaded, piperReady, loadPiperVoice, piperSpeak, MOODS } from "./piper.js?v=5"; // bump with piper.js changes so no browser pairs this file with an old copy

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  history: [],
  rapport: 0,
  busy: false,
  finished: false,
  handsFree: false, // when true, the mic listens, auto-sends on a pause, and resumes after each reply
  speaking: false,
  paused: false, // call on hold: no voice, no mic, timer stopped
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

// ---------- AI services (called directly from the browser with the user's own keys) ----------
// Conversation runs on Mistral (best German of the free tiers, with Groq as a backup when
// Mistral is busy) or on Gemini. Gemini is also the backup voice when Piper can't speak.
// Lite answers in about a second; Flash takes about five, so it is only the fallback.
const CONV_MODEL = "gemini-flash-lite-latest";
const CONV_FALLBACK_MODEL = "gemini-flash-latest";
const TTS_MODEL = "gemini-3.8-flash-tts";
const TTS_VOICE = "Kore";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MISTRAL = { name: "Mistral", url: "https://api.mistral.ai/v1/chat/completions", model: "mistral-small-latest" };
const GROQ = {
  name: "Groq",
  url: "https://api.groq.com/openai/v1/chat/completions",
  model: "openai/gpt-oss-120b",
  extra: { reasoning_effort: "low" }, // keep replies quick enough for a conversation
};

const memoryKeys = {}; // fallback when localStorage is unavailable
function getKey(service = "gemini") {
  try {
    return localStorage.getItem(`${service}_key`) || "";
  } catch {
    return memoryKeys[service] || "";
  }
}
function setKey(service, k) {
  memoryKeys[service] = k;
  try {
    if (k) localStorage.setItem(`${service}_key`, k);
    else localStorage.removeItem(`${service}_key`);
  } catch {
    // storage unavailable; key lives only for this page load
  }
}

// Which service runs the conversation. People who only ever saved a Gemini key stay on Gemini.
function getProvider() {
  let saved = "";
  try {
    saved = localStorage.getItem("talkloop_provider") || "";
  } catch {
    saved = memoryKeys.provider || "";
  }
  if (saved === "mistral" || saved === "gemini") return saved;
  return getKey("gemini") && !getKey("mistral") ? "gemini" : "mistral";
}
function setProvider(p) {
  memoryKeys.provider = p;
  try {
    localStorage.setItem("talkloop_provider", p);
  } catch {
    // storage unavailable
  }
}

// Each scene has a goal with several steps, so the learner has to do most of the talking
// over many turns instead of finishing in two lines.
const SCENARIOS = {
  cafe: {
    character: "Inès",
    setting: "a barista at a busy neighbourhood café who loves recommending pastries",
    goal: "Take the learner's order: drink, size, milk, something to eat, here or to go, then payment. Chat a little while you prepare it.",
  },
  market: {
    character: "Tomás",
    setting: "a fruit seller at an outdoor market who haggles playfully",
    goal: "Sell the learner fruit and vegetables for a dinner they're cooking. Ask what they're making, suggest things, discuss quantities and haggle over the price.",
  },
  station: {
    character: "Yuki",
    setting: "a helpful ticket clerk at a train station during rush hour",
    goal: "Help the learner buy a ticket: destination, date and time, one-way or return, class, seat reservation, discount card, and which platform. Then tell them their train is delayed and help them choose an alternative.",
  },
  doctor: {
    character: "Dr. Weber",
    setting: "a friendly but thorough family doctor",
    goal: "Find out what's wrong: ask about the symptoms, since when, how bad, fever, medication, allergies, work and sleep. Explain what you think it is, what to take and how often, and whether they need a sick note.",
  },
  flat: {
    character: "Frau Schulz",
    setting: "a landlady showing a flat to a possible new tenant",
    goal: "Show the flat room by room and interview the learner: their job, income, why they're moving, pets, smoking, how long they'd stay, when they could move in. Let them ask about rent, deposit, heating and the neighbours.",
  },
  job: {
    character: "Herr Brandt",
    setting: "a recruiter interviewing the learner for a job at a mid-sized company",
    goal: "Run a job interview: ask them to introduce themselves, their experience, strengths and weaknesses, a difficult situation they solved, why this job, salary expectations and start date. Then invite their questions.",
  },
  office: {
    character: "Frau Yilmaz",
    setting: "a clerk at the town hall registration office who is strict about paperwork",
    goal: "Register the learner's new address: ask for ID, the landlord's confirmation, moving date, previous address, marital status and religion for tax. One document is missing; work out with them how to solve it.",
  },
  restaurant: {
    character: "Luca",
    setting: "a chatty waiter at a small family restaurant",
    goal: "Seat the learner, explain the specials, take drinks and food orders with questions about preferences and allergies. Later there's a problem with the dish; handle the complaint, then dessert, the bill and splitting it.",
  },
  hotel: {
    character: "Sophie",
    setting: "a receptionist at a city hotel",
    goal: "Check the learner in, but their booking can't be found. Sort it out together: name, dates, room type, how they booked. Then explain breakfast, Wi-Fi and checkout, and give tips for sightseeing.",
  },
  neighbour: {
    character: "Jonas",
    setting: "a friendly neighbour who has just moved in next door",
    goal: "Get to know the learner on the stairs: where they're from, how long they've lived here, work, hobbies, tips for the area. Invite them to a small party and agree on day, time and what to bring.",
  },
  dentist: {
    character: "Frau Klein",
    setting: "a receptionist answering the phone at a busy dental practice",
    goal: "Take an appointment request by phone: name and spelling, date of birth, insurance, what the problem is, how urgent. Offer times that don't fit at first and negotiate until one works, then confirm.",
  },
  shop: {
    character: "Max",
    setting: "a shop assistant in a clothing store",
    goal: "The learner wants to return a jacket. Ask what's wrong, when they bought it, whether they have the receipt. Offer an exchange or a voucher instead of a refund and negotiate, then help them try something else.",
  },
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
    extra: "Play out the scene naturally, one step at a time. Ask the learner questions so they do most of the talking, and ask follow-ups when an answer is short. Set conversation_finished to true only once every part of the scene goal is done, usually after ten or more exchanges.",
  },
};

// Tense practice: the partner steers the talk so the learner has to use this tense,
// and the coach checks it. "any" adds nothing.
const TENSES = {
  any: null,
  present: {
    short: "Präsens",
    form: "the present tense (in German the Präsens: ich spiele, du fährst, er ist)",
    ask: "what the learner usually does, their routines, likes, family, job and what is happening right now",
  },
  perfekt: {
    short: "Perfekt",
    form: "the spoken past (in German the Perfekt: haben or sein + Partizip II, e.g. ich habe gekocht, ich bin gefahren)",
    ask: "what the learner did yesterday, last weekend, on their last holiday or at work this week",
  },
  praeteritum: {
    short: "Präteritum",
    form: "the simple past used for telling stories (in German the Präteritum: ich ging, ich machte, ich war, ich hatte, ich konnte)",
    ask: "stories: their childhood, how something happened, a film or book they remember, an adventure",
  },
  future: {
    short: "Futur I",
    form: "the future (in German Futur I: werden + infinitive, e.g. ich werde reisen)",
    ask: "the learner's plans for tonight, the weekend, next year, and their dreams",
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

const DEFAULT_VOCAB_URL = "https://harsimar17.github.io/Deutsch-Vocab-Helper/german_vocab.json";

async function storeVocab(json) {
  const words = flattenVocab(json);
  if (!words.length) throw new Error("No vocabulary found in that source.");
  await idbSet("vocab_words", words);
  await idbSet("vocab_seen", []);
  return { count: words.length, levels: [...new Set(words.map((w) => w.level))].sort() };
}

async function importVocab(file) {
  return storeVocab(JSON.parse(await file.text()));
}

async function importVocabFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return storeVocab(await res.json());
}

async function vocabMeta() {
  const words = (await idbGet("vocab_words")) ?? [];
  return { count: words.length, levels: [...new Set(words.map((w) => w.level))].sort() };
}

// ---------- Link to the Vocab Trainer (only the words learnt there) ----------
// The trainer's "practise in Talkloop" opens this page with #vocab-link=…&vocab-api=…:
// a read-only link to the learner's learnt words. It is kept here and the
// fragment is wiped from the address bar.
function takeTrainerLinkFromUrl() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("vocab-link");
  const api = params.get("vocab-api");
  if (!token || !/^https?:\/\//.test(api ?? "")) return false;
  store.set("trainer_link", { token, api: api.replace(/\/+$/, "") });
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

function trainerLink() {
  return store.get("trainer_link", null);
}

// The deployed Vocab Trainer backend; "trainer_api" in localStorage overrides it (e.g. a local one).
const TRAINER_API = "https://deutsch-vocab-trainer-v2-1.onrender.com";

// Log in to the trainer once and swap the session for the same read-only link the
// trainer's button hands out. The password is sent only to the trainer and not kept.
async function connectTrainer(email, password) {
  const api = store.get("trainer_api", TRAINER_API).replace(/\/+$/, "");
  const message = async (res) => (await res.json().catch(() => ({}))).message || `Vocab Trainer answered ${res.status}`;
  const login = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (login.status === 401) throw new Error("Wrong email or password.");
  if (!login.ok) throw new Error(await message(login));
  const { token: session } = await login.json();
  const res = await fetch(`${api}/api/talkloop/link`, { method: "POST", headers: { Authorization: `Bearer ${session}` } });
  if (!res.ok) throw new Error(await message(res));
  store.set("trainer_link", { token: (await res.json()).token, api });
}

// Learnt words, the least secure first (the trainer sorts them).
async function fetchLearntWords() {
  const link = trainerLink();
  const res = await fetch(`${link.api}/api/talkloop/words`, { headers: { Authorization: `Bearer ${link.token}` } });
  if (res.status === 401) {
    store.set("trainer_link", null);
    throw new Error("The link to the Vocab Trainer has expired. Connect again.");
  }
  if (!res.ok) throw new Error(`Vocab Trainer answered ${res.status}`);
  const { words } = await res.json();
  return words.map((w) => ({ de: w.de, en: w.en ?? "", example: w.example ?? "", level: w.lvl, cat: w.cat }));
}

// In-memory state for the active session.
// Each pool rotates on its own, so a small pool keeps coming back next to a big one.
let vocabPools = []; // [{ words, pointer }]
let vocabSeen = new Set();

// The levels counted as known when linked to the trainer: all their words are used.
// Higher levels use only the words learnt in the trainer.
const KNOWN_LEVELS = ["A1", "A2"];

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// learnt (linked to the trainer): every A1/A2 word, shuffled, plus the learnt B1 words
// in the trainer's order so the shakiest come up first. Otherwise the imported list, shuffled.
async function loadVocabForSession(levels, learnt = null) {
  const all = ((await idbGet("vocab_words")) ?? []).filter((w) => levels.includes(w.level));
  if (learnt) {
    const higher = learnt.filter((w) => levels.includes(w.level) && !KNOWN_LEVELS.includes(w.level));
    const known = shuffled(all.filter((w) => KNOWN_LEVELS.includes(w.level)));
    vocabPools = [higher, known];
  } else {
    vocabPools = [shuffled(all)];
  }
  vocabPools = vocabPools.filter((words) => words.length).map((words) => ({ words, pointer: 0 }));
  vocabSeen = new Set((await idbGet("vocab_seen")) ?? []);
  return vocabPools.reduce((sum, p) => sum + p.words.length, 0);
}

// Pick the next rotating batch of words to weave into the conversation, shared
// evenly between the pools (the learnt B1 words first).
function nextVocabBatch(n = 12) {
  const batch = [];
  vocabPools.forEach((pool, i) => {
    const share = Math.min(pool.words.length, Math.ceil((n - batch.length) / (vocabPools.length - i)));
    for (let k = 0; k < share; k++) {
      batch.push(pool.words[pool.pointer % pool.words.length]);
      pool.pointer++;
    }
  });
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
    // How the reply is spoken (the open-source German voice has a recording per mood).
    mood: { type: "STRING", enum: MOODS },
  },
  required: ["reply", "reply_translation", "suggestions", "coach", "rapport_delta", "conversation_finished", "mood"],
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

function turnSystemPrompt({ language, nativeLanguage, level, scenario, mode, tense }, targetWords = [], learnt = false) {
  const m = MODES[mode] ?? MODES.scene;
  const persona = personaFor({ scenario, mode });
  const lines = [
    `You are ${persona.character}, ${persona.setting}. Stay in character and speak only ${language}.`,
    `The learner speaks ${language} at CEFR level ${level}; their native language is ${nativeLanguage}.`,
    "Keep each reply to one or two short sentences that match the learner's level, and end with something they can respond to.",
    m.extra,
    ...(m.usesScene && persona.goal ? [`Scene goal: ${persona.goal}`] : []),
    "Speech recognition produced the learner's message, so ignore missing punctuation and obvious transcription slips.",
    `Write reply_translation, coach.tip and nothing else in ${nativeLanguage}.`,
    "Give a correction only when the learner made a real grammar or word-choice mistake.",
    "Your reply is read aloud, so let your feelings show in the words: react like a real person with short interjections (for example Oh!, Ach wirklich?, Super!, Oh nein!) and use ! and ? where you mean them.",
    `Set mood to how the reply should sound: ${MOODS.join(", ")}. Use amused for fun or happy replies, surprised for amazement, angry only when the role calls for annoyance, sleepy for tiredness, whisper for secrets, and neutral otherwise.`,
  ];
  const t = TENSES[tense];
  if (t) {
    lines.push(
      `The learner wants to practise ${t.form}. Use this tense yourself wherever it fits, and keep steering the conversation so that the natural answer to your question needs it: ask about ${t.ask}. Your very first question, right after the greeting, should already need this tense. Stay in your role while doing so.`,
      "Write the suggestions in this tense.",
      "Check every learner message for this tense. If they used another tense where it was expected, or formed it wrongly (wrong auxiliary, wrong participle or ending), put the whole sentence corrected into this tense in coach.correction, even if it is otherwise understandable. When they use it correctly, say so briefly in coach.tip.",
    );
  }
  if (targetWords.length && learnt) {
    const list = targetWords.map((w) => (w.en ? `${w.de} (${w.en})` : w.de)).join("; ");
    lines.push(
      `The learner already knows these words but now needs to practise using them when speaking: ${list}.`,
      "Otherwise speak as you normally would: you are not limited to these words. Use one or two of them naturally in your reply, and steer the conversation so the learner gets to use them too, for example with a question whose natural answer needs one of them. Never list or quiz the words.",
      "When the learner uses one of these words, check it: if it is right, say so briefly in coach.tip; if the meaning, article or form is wrong, give the fix in coach.correction.",
    );
  } else if (targetWords.length) {
    const list = targetWords.map((w) => (w.en ? `${w.de} (${w.en})` : w.de)).join("; ");
    lines.push(
      `The learner is practising this vocabulary. Naturally weave two to four of these words or phrases into your reply where they fit — do not force all of them, keep it natural, and give the learner a chance to use them too: ${list}.`,
    );
  }
  return lines.join("\n");
}

// The schemas above are in Gemini's format; OpenAI-style APIs want standard JSON Schema.
function toJsonSchema(s) {
  const out = { type: s.type.toLowerCase() };
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  }
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.enum) out.enum = s.enum;
  if (s.required) out.required = s.required;
  return out;
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The model returned an unreadable response. Please try again.");
  }
}

// One request to an OpenAI-compatible chat API (Mistral, Groq). Returns the fetch Response.
function chatRequest(service, key, { systemInstruction, schema, contents }) {
  const messages = [
    {
      role: "system",
      content: `${systemInstruction}\n\nAnswer with only a JSON object that matches this JSON Schema:\n${JSON.stringify(toJsonSchema(schema))}`,
    },
    ...contents.map((c) => ({
      role: c.role === "model" ? "assistant" : "user",
      content: c.parts.map((p) => p.text).join(""),
    })),
  ];
  return fetch(service.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: service.model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.8,
      ...service.extra,
    }),
  });
}

async function chatJson(request) {
  const mistralKey = getKey("mistral");
  const groqKey = getKey("groq");
  if (!mistralKey) throw new Error("Add your Mistral API key to start.");
  let service = MISTRAL;
  let res = await chatRequest(MISTRAL, mistralKey, request);
  // Mistral's free tier is rate-limited (429) and sometimes overloaded (5xx); Groq takes over.
  if ((res.status === 429 || res.status >= 500) && groqKey) {
    service = GROQ;
    res = await chatRequest(GROQ, groqKey, request);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message ?? data.message ?? data.detail ?? `Request failed (${res.status})`;
    throw new Error(`${service.name}: ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return parseModelJson(data.choices?.[0]?.message?.content ?? "");
}

function aiJson(request) {
  return getProvider() === "mistral" ? chatJson(request) : geminiJson(request);
}

async function geminiJson({ systemInstruction, schema, contents }) {
  const key = getKey("gemini");
  if (!key) throw new Error("Add your Gemini API key to start.");
  const request = (model) =>
    fetch(`${API_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.8 },
      }),
    });
  let res = await request(CONV_MODEL);
  // When one model is overloaded (503) or out of free quota (429), the other usually isn't.
  if (res.status === 503 || res.status === 429) res = await request(CONV_FALLBACK_MODEL);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? `Request failed (${res.status})`);
  return parseModelJson(data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "");
}

function historyToContents(history, userText) {
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  contents.push({ role: "user", parts: [{ text: userText }] });
  return contents;
}

async function chatTurn(settings, history, message) {
  const mode = MODES[settings.request.mode] ?? MODES.scene;
  const userText = message.trim() || mode.opener;
  const learnt = Boolean(settings.vocab?.learnt);
  const targetWords = settings.vocab?.enabled ? nextVocabBatch(learnt ? 8 : 12) : [];
  const turn = await aiJson({
    systemInstruction: turnSystemPrompt(settings.request, targetWords, learnt),
    schema: TURN_SCHEMA,
    contents: historyToContents(history, userText),
  });
  turn.focusWords = targetWords;
  // In open modes the conversation never ends on its own.
  if (!mode.endable) turn.conversation_finished = false;
  return { turn, userText };
}

async function wordInfo({ word, sentence, language, nativeLanguage }) {
  return aiJson({
    systemInstruction: `You are a concise ${language} dictionary for a ${nativeLanguage} speaker. Write translations in ${nativeLanguage}.`,
    schema: WORD_SCHEMA,
    contents: [{ role: "user", parts: [{ text: `Explain the word "${word}" as it is used in: "${sentence}"` }] }],
  });
}

// Gemini TTS returns base64 16-bit PCM; decode it into raw bytes.
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Wrap PCM bytes in a WAV blob URL (fallback path for browsers without Web Audio).
function pcmToWavUrl(pcm, sampleRate = 24000) {
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

// The free tier allows only a few TTS requests a day. After a quota error, skip
// Gemini voice until the reset time it reports (e.g. "Please retry in 9h58m15.8s").
function blockGeminiTts(message) {
  const m = /retry in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i.exec(message);
  let ms = 60 * 60 * 1000; // no reset time given: try again in an hour
  if (m && m[1]) {
    const part = (unit) => Number(new RegExp(`([\\d.]+)${unit}`).exec(m[1])?.[1] ?? 0);
    ms = ((part("h") * 60 + part("m")) * 60 + part("s")) * 1000 || ms;
  }
  store.set("tts_blocked_until", Date.now() + ms);
}

function geminiTtsBlocked() {
  return Date.now() < store.get("tts_blocked_until", 0);
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) blockGeminiTts(data.error?.message ?? "");
    throw new Error(data.error?.message ?? `TTS request failed (${res.status})`);
  }
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error("TTS returned no audio");
  const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? "");
  return { pcm: base64ToBytes(part.inlineData.data), sampleRate: rate ? Number(rate[1]) : 24000 };
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
  setAudioSession("auto");
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
    if (state.paused) {
      // Paused mid-sentence: drop it rather than sending half a thought.
    } else if (isPauseCommand(spoken)) {
      setPaused(true, { byVoice: true });
    } else if (spoken) {
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

// ---------- voice commands: "zwei Minuten" pauses the call, "zurück" / "back" resumes ----------
// Only short utterances count, so "Ich warte zwei Minuten auf den Bus" is still sent normally.
function normalizeSpeech(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\b2\b/g, "zwei").replace(/\s+/g, " ").trim();
}
function isPauseCommand(text) {
  const t = normalizeSpeech(text);
  return t.split(" ").length <= 4 && /\bzwei minuten\b/.test(t);
}
function isResumeCommand(text) {
  const t = normalizeSpeech(text);
  // de-DE recognition may hear the English "back" as "Beck" or "bäck".
  // (\b doesn't treat ü as a letter, so use Unicode-aware word edges.)
  return t.split(" ").length <= 5 && /(?<!\p{L})(zurück|zurueck|back|beck|bäck|bin wieder da)(?!\p{L})/u.test(t);
}

// While paused by voice, keep a quiet listener running that only waits for the resume word.
// Speech recognition stops by itself after a while, so it restarts until the call resumes.
let wakeRecognizer = null;
let wakeEnded = null; // resolves when the wake listener has fully stopped
function startWakeListener() {
  if (!Recognition || wakeRecognizer || !state.paused) return;
  const rec = new Recognition();
  rec.lang = state.settings.locale;
  rec.interimResults = true;
  rec.continuous = true;
  let heardResume = false;
  let denied = false;
  let resolveEnded;
  wakeEnded = new Promise((r) => { resolveEnded = r; });
  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (isResumeCommand(event.results[i][0].transcript)) {
        heardResume = true;
        rec.abort();
        return;
      }
    }
  };
  rec.onerror = (event) => { if (event.error === "not-allowed") denied = true; };
  rec.onend = () => {
    wakeRecognizer = null;
    resolveEnded();
    updateCallState();
    if (heardResume) setPaused(false);
    else if (state.paused && pausedByVoice && !denied) setTimeout(startWakeListener, 300);
  };
  wakeRecognizer = rec;
  try {
    rec.start();
  } catch {
    wakeRecognizer = null;
    resolveEnded();
  }
  updateCallState();
}
function stopWakeListener() {
  if (!wakeRecognizer) return Promise.resolve();
  wakeRecognizer.abort();
  return wakeEnded;
}

function stopListening() {
  state.handsFree = false;
  recognizer?.stop();
  setStatus("Hands-free off.");
  updateCallState();
}

function setMic(on) {
  $("mic").setAttribute("aria-pressed", String(on));
  $("mic").querySelector(".round-label").textContent = on ? "Listening" : "Talk";
  updateCallState();
}

// ---------- speech synthesis with word highlighting ----------
// Apple's Eloquence and novelty voices sound synthetic; Safari sometimes lists them first.
const ROBOTIC_VOICES = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy)\b/;

// Rank voices so the browser's natural/neural voice for the locale wins
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
    if (/premium/.test(name)) s += 35; // Apple's downloadable top-quality voices
    else if (/enhanced/.test(name)) s += 30;
    if (/(natural|neural|wavenet|siri|multilingual)/.test(name)) s += 25;
    if (/google|microsoft/.test(name)) s += 10;
    if (/compact|espeak|pico/.test(name)) s -= 20; // known robotic engines
    if (ROBOTIC_VOICES.test(name)) s -= 60;
    return s;
  };

  return candidates.slice().sort((a, b) => score(b) - score(a))[0];
}

// Safari loads voices lazily; wait briefly so we don't speak with the default one.
function voicesReady() {
  if (speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener("voiceschanged", done);
      resolve();
    };
    speechSynthesis.addEventListener("voiceschanged", done);
    setTimeout(done, 1000);
  });
}

let currentAudio = null;
let currentSource = null;
let currentHighlight = null;
let speakToken = 0; // bumps on every speak/stop so a slow TTS reply can't play over a newer one

// A single AudioContext, unlocked on the first user tap. Playing generated audio
// through Web Audio is far more reliable than <audio> in Safari / on iPhone.
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}

// One shared <audio> element. On iPhone, speech recognition takes over the audio
// session and suspends Web Audio; an element primed inside a tap can still play then.
const player = new Audio();
player.setAttribute("playsinline", "");
let playerPrimed = false;

// iOS 17+: route speech like media (plays with the ring switch on silent).
// Listening switches it back to "auto" so the mic still works.
function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {
    // unsupported value or browser; the default session still works
  }
}

// Runs inside every user gesture so Safari lets audio play later, after network waits.
let speechPrimed = false;
function unlockAudio() {
  if (!playerPrimed) {
    playerPrimed = true;
    player.src = pcmToWavUrl(new Uint8Array(480)); // 10 ms of silence
    player.play().catch(() => { playerPrimed = false; });
  }
  const ctx = getAudioCtx();
  if (ctx && ctx.state !== "running") {
    ctx.resume().catch(() => {});
    // Safari only truly unlocks once something is started inside the gesture.
    const blip = ctx.createBufferSource();
    blip.buffer = ctx.createBuffer(1, 1, 22050);
    blip.connect(ctx.destination);
    blip.start();
  }
  // Safari's speech synthesis also needs one gesture-initiated utterance.
  if (!speechPrimed && "speechSynthesis" in window) {
    speechPrimed = true;
    speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  }
}
for (const type of ["click", "touchend", "keydown"]) {
  document.addEventListener(type, unlockAudio, { capture: true });
}

// Generated audio by text, so Replay and Listen don't spend another TTS request.
const ttsCache = new Map();
const TTS_CACHE_MAX = 60;
function rememberTts(text, audio) {
  ttsCache.set(text, audio);
  if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
}

// Get the open-source voice ready in the background (download the first time, then load
// it into memory), showing progress on the setup screen and in the call.
const piperLoads = new Map(); // locale -> Promise
function setVoiceStatus(text) {
  $("voice-status").textContent = text;
  const inCall = !$("conversation").hidden;
  const mine = $("status").textContent.startsWith("Voice:");
  if (inCall && !state.busy && !state.paused && (mine || !$("status").textContent)) setStatus(text);
  else if (!text && mine) setStatus("");
}
function preloadPiper(locale) {
  if (!hasPiperVoice(locale)) return Promise.reject(new Error("no open-source voice for this language"));
  if (piperLoaded(locale)) return loadPiperVoice(locale);
  if (!piperLoads.has(locale)) {
    const mb = (n) => Math.round(n / 1e6);
    setVoiceStatus("Voice: getting ready…");
    const p = loadPiperVoice(locale, (got, total) => {
      setVoiceStatus(`Voice: downloading (one time) ${mb(got)}${total ? ` / ${mb(total)}` : ""} MB…`);
    }).then(
      (voice) => {
        if ($("language").selectedOptions[0]?.dataset.locale === locale || state.settings?.locale === locale) {
          setVoiceStatus("");
          $("voice-status").textContent = "✓ Voice ready";
        }
        return voice;
      },
      (error) => {
        piperLoads.delete(locale); // allow another try later
        setVoiceStatus("Voice: download failed, using a backup voice for now.");
        throw error;
      },
    );
    piperLoads.set(locale, p);
  }
  return piperLoads.get(locale);
}

// Load the voice for the language picked on the setup screen, before the call starts.
function preloadSelectedVoice() {
  const locale = $("language").selectedOptions[0]?.dataset.locale;
  if (!locale) return;
  if (!hasPiperVoice(locale)) {
    $("voice-status").textContent = "";
    return;
  }
  preloadPiper(locale).catch((error) => console.warn("Piper voice failed to load:", error));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Voice order: Piper (open-source, runs on the device, unlimited) → Gemini (small
// daily free quota) → the browser's built-in voice.
async function speak(text, wordSpans, onDone, mood = "neutral") {
  stopSpeaking();
  const token = speakToken;
  const locale = state.settings.locale;
  const rate = ["A1", "A2"].includes(state.settings.level) ? 0.9 : 1;
  // Make sure the done callback fires exactly once, whichever path plays.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (token === speakToken) setSpeaking(false);
    if (typeof onDone === "function") onDone();
  };
  const fallback = (reason) => {
    if (token !== speakToken) return;
    console.warn("Natural voice unavailable, using the browser voice:", reason);
    noteVoice(wordSpans, `Browser voice — ${reason}`);
    setSpeaking(true);
    browserSpeak(text, rate, wordSpans, finish);
  };
  const play = (audio, note) => {
    if (token !== speakToken) return; // stopped or superseded while audio was generating
    noteVoice(wordSpans, note);
    setSpeaking(true);
    playCloudAudio(audio.pcm, audio.sampleRate, wordSpans, finish, fallback);
  };
  noteVoice(wordSpans, "");
  setAudioSession("playback");

  const cached = ttsCache.get(`${locale}|${mood}|${text}`);
  if (cached) return play(cached.audio, cached.note);

  // 1. Piper, once it's loaded. A reply never waits for a download: until the voice is
  //    ready, it starts loading and this reply uses the next voice. If it's already
  //    downloaded and only loading into memory, give it a moment first.
  let piperNote = "";
  if (hasPiperVoice(locale)) {
    if (!piperLoaded(locale)) {
      const loading = preloadPiper(locale).catch(() => null);
      if (await piperReady(locale)) await Promise.race([loading, sleep(1500)]);
      if (token !== speakToken) return;
    }
    if (piperLoaded(locale)) {
      try {
        const audio = await piperSpeak(text, locale, { speed: rate, mood });
        rememberTts(`${locale}|${mood}|${text}`, { audio, note: "" });
        return play(audio, "");
      } catch (error) {
        console.warn("Piper voice failed:", error);
        piperNote = `open-source voice failed: ${error.message}`;
      }
    } else {
      piperNote = "open-source voice still loading";
    }
  } else {
    piperNote = "no open-source voice for this language";
  }
  if (token !== speakToken) return;

  // 2. Gemini, while the free daily quota lasts.
  let reason = piperNote;
  if (!getKey()) reason += " · no API key";
  else if (geminiTtsBlocked()) reason += " · Gemini voice daily limit reached";
  else {
    try {
      const audio = await geminiTts(text);
      const note = `Gemini voice — ${piperNote}`;
      rememberTts(`${locale}|${mood}|${text}`, { audio, note });
      return play(audio, note);
    } catch (error) {
      if (token !== speakToken) return;
      reason += geminiTtsBlocked() ? " · Gemini voice daily limit reached" : ` · ${error.message}`;
    }
  }

  // 3. The browser's built-in voice.
  fallback(reason);
}

function startHighlight(wordSpans, elapsedFn, duration) {
  if (!wordSpans.length) return null;
  return setInterval(() => {
    const i = Math.min(wordSpans.length - 1, Math.floor((elapsedFn() / duration) * wordSpans.length));
    wordSpans.forEach((span, idx) => span.classList.toggle("speaking", idx === i));
  }, 80);
}

async function playCloudAudio(pcm, sampleRate, wordSpans, onDone, onFail) {
  const token = speakToken;
  const ctx = getAudioCtx();
  if (!ctx) {
    playCloudAudioWav(pcm, sampleRate, wordSpans, onDone, onFail);
    return;
  }
  if (ctx.state !== "running") {
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    if (token !== speakToken) return;
    // A still-suspended context (iPhone after the mic was used) would play silently
    // and never end; try the primed <audio> element instead.
    if (ctx.state !== "running") {
      playCloudAudioWav(pcm, sampleRate, wordSpans, onDone, onFail);
      return;
    }
  }

  // 16-bit little-endian mono PCM -> AudioBuffer.
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  const buffer = ctx.createBuffer(1, samples, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

  const clear = () => {
    if (currentHighlight) { clearInterval(currentHighlight); currentHighlight = null; }
    wordSpans.forEach((span) => span.classList.remove("speaking"));
  };
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  currentSource = src;
  const startedAt = ctx.currentTime;
  currentHighlight = startHighlight(wordSpans, () => ctx.currentTime - startedAt, buffer.duration);
  src.onended = () => { currentSource = null; clear(); onDone(); };
  try {
    src.start();
  } catch (error) {
    currentSource = null;
    clear();
    onFail(error.message);
  }
}

// Plays through the shared <audio> element, for browsers without Web Audio or
// when the AudioContext is suspended.
function playCloudAudioWav(pcm, sampleRate, wordSpans, onDone, onFail) {
  const url = pcmToWavUrl(pcm, sampleRate);
  const audio = player;
  audio.src = url;
  currentAudio = audio;
  audio.ontimeupdate = () => {
    if (!audio.duration || !wordSpans.length) return;
    const i = Math.min(wordSpans.length - 1, Math.floor((audio.currentTime / audio.duration) * wordSpans.length));
    wordSpans.forEach((span, idx) => span.classList.toggle("speaking", idx === i));
  };
  const clear = () => {
    wordSpans.forEach((span) => span.classList.remove("speaking"));
    URL.revokeObjectURL(url);
  };
  audio.onended = () => { clear(); onDone(); };
  audio.onerror = () => { clear(); onFail("audio could not be played"); };
  audio.play().catch((error) => { clear(); onFail(error.message); });
}

async function browserSpeak(text, rate, wordSpans, onDone) {
  if (!("speechSynthesis" in window)) {
    if (typeof onDone === "function") onDone();
    return;
  }
  const token = speakToken;
  await voicesReady();
  if (token !== speakToken) return;
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
  speakToken++;
  setSpeaking(false);
  if (currentHighlight) { clearInterval(currentHighlight); currentHighlight = null; }
  document.querySelectorAll(".word.speaking").forEach((span) => span.classList.remove("speaking"));
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }
  if (currentAudio) {
    currentAudio.onended = currentAudio.onerror = currentAudio.ontimeupdate = null;
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
  replay.addEventListener("click", () => speak(turn.reply, spans, null, turn.mood));
  const translate = document.createElement("button");
  translate.textContent = "Translate";
  translate.addEventListener("click", () => {
    translation.hidden = !translation.hidden;
  });
  tools.append(replay, translate);

  li.append(who, line, translation, tools);
  $("transcript").append(li);
  scrollCallToBottom();
  // A reply that arrives while the call is paused is spoken on resume.
  if (state.paused) {
    pendingReply = { text: turn.reply, spans, mood: turn.mood };
    return;
  }
  // When hands-free, start listening again once the character finishes speaking.
  speak(turn.reply, spans, () => maybeResumeListening(), turn.mood);
}

function maybeResumeListening() {
  if (state.handsFree && !state.finished && !state.paused && !recognizer) {
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
  scrollCallToBottom();
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

// Run handler on a tap without taking focus from the text box. A button would otherwise
// blur it, and on phones that drops the keyboard and reflows the dock mid-tap. iOS decides
// that at the touch level, so the tap is handled on touchend with its default prevented
// (which also cancels the synthesized click). A touch that moved is a scroll of the chip
// row, not a tap. click covers mouse and keyboard activation, unless the button submits
// the form, whose submit handler covers those instead.
function onTap(el, handler, { click = true } = {}) {
  let start = null;
  el.addEventListener("mousedown", (event) => event.preventDefault());
  el.addEventListener("touchstart", (event) => {
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  el.addEventListener("touchend", (event) => {
    const t = event.changedTouches[0];
    const moved = !start || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10;
    start = null;
    if (moved) return;
    event.preventDefault();
    handler();
  });
  if (click) el.addEventListener("click", handler);
}

// Put a suggestion into the text box, ready to edit or send, with the caret at the end.
// The keyboard is only kept up if it already was: a suggestion never pops it open.
function useSuggestion(text) {
  const input = $("text");
  input.value = text;
  if (!document.body.classList.contains("typing")) return;
  input.focus();
  try { input.setSelectionRange(text.length, text.length); } catch { /* unsupported */ }
}

function renderSuggestions(suggestions) {
  const box = $("suggestions");
  box.replaceChildren();
  for (const text of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = text;
    onTap(chip, () => useSuggestion(text));
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
  label.textContent = state.settings?.vocab?.learnt ? "Your words: " : "Practising: ";
  box.append(label);
  for (const w of words) {
    const chip = document.createElement("span");
    chip.className = "focus-word";
    chip.textContent = w.de;
    chip.title = w.en;
    box.append(chip);
  }
}

// Small note under a message saying the browser voice played, and why (empty clears it).
function noteVoice(wordSpans, text) {
  const li = wordSpans[0]?.closest("li");
  if (!li) return;
  let note = li.querySelector(".voice-note");
  if (!text) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("div");
    note.className = "voice-note";
    li.append(note);
  }
  note.textContent = text;
}

function setStatus(text) {
  $("status").textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  // Only the buttons are disabled while a reply loads, so a second turn can't be fired
  // mid-reply. The text box stays enabled (and focused) so the keyboard — and the compact
  // typing layout — don't collapse, and the learner can start composing their next turn.
  // It's only locked once the scene is finished or the call is on hold.
  for (const el of $("composer").querySelectorAll("button")) el.disabled = busy || state.finished || state.paused;
  $("text").disabled = state.finished || state.paused;
  updateCallState();
}

// ---------- call screen ----------
function scrollCallToBottom() {
  const box = $("call-scroll");
  requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: "smooth" }));
}

function setSpeaking(on) {
  state.speaking = on;
  updateCallState();
}

// The pill in the call header: what's happening right now.
function updateCallState() {
  let key = "idle";
  let text = state.handsFree ? "Your turn — just talk" : "Your turn";
  if (state.finished) { key = "ended"; text = "Scene complete"; }
  else if (state.paused) { key = "paused"; text = wakeRecognizer ? "Paused — say “zurück”" : "Paused"; }
  else if (state.busy) { key = "thinking"; text = "Thinking…"; }
  else if (state.speaking) { key = "speaking"; text = "Speaking…"; }
  else if (recognizer) { key = "listening"; text = "Listening…"; }
  $("conversation").dataset.state = key;
  $("call-state").textContent = text;
}

// Call timer; time spent paused doesn't count.
let callTimer = null;
let callElapsed = 0; // ms counted before the current running stretch
let callRunningSince = 0;
function tickCallTimer() {
  const ms = callElapsed + (callTimer ? Date.now() - callRunningSince : 0);
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  $("call-timer").textContent = hh ? `${hh}:${mmss}` : mmss;
}
function runCallTimer() {
  if (callTimer) return;
  callRunningSince = Date.now();
  callTimer = setInterval(tickCallTimer, 1000);
  tickCallTimer();
}
function holdCallTimer() {
  if (!callTimer) return;
  callElapsed += Date.now() - callRunningSince;
  clearInterval(callTimer);
  callTimer = null;
  tickCallTimer();
}
function startCallTimer() {
  holdCallTimer();
  callElapsed = 0;
  runCallTimer();
}

// Pause = put the call on hold: stop the voice and the mic, freeze the timer.
// Paused by voice ("zwei Minuten"), the mic keeps listening only for the resume word.
let pendingReply = null; // a reply that arrived while paused, spoken on resume
let resumeHandsFree = false;
let pausedByVoice = false;
function setPaused(paused, { byVoice = false } = {}) {
  if (paused === state.paused) return;
  if (paused) {
    resumeHandsFree = state.handsFree;
    pausedByVoice = byVoice && Boolean(Recognition);
    state.paused = true; // set first so nothing restarts the mic or voice
    if (recognizer) stopListening();
    state.handsFree = false;
    stopSpeaking();
    holdCallTimer();
    setStatus(pausedByVoice
      ? "Call paused. Say “zurück” or “back” when you're ready, or tap Resume."
      : "Call paused. Tap Resume to carry on.");
    if (pausedByVoice) startWakeListener();
  } else {
    state.paused = false;
    pausedByVoice = false;
    runCallTimer();
    setStatus("");
    state.handsFree = resumeHandsFree;
    const reply = pendingReply;
    pendingReply = null;
    // The browser allows one recognizer at a time: let the resume listener stop first.
    stopWakeListener().then(() => {
      if (state.paused) return;
      if (reply) speak(reply.text, reply.spans, () => maybeResumeListening(), reply.mood);
      else maybeResumeListening();
    });
  }
  const btn = $("pause");
  btn.setAttribute("aria-pressed", String(paused));
  btn.title = paused ? "Resume the call" : "Pause the call";
  btn.querySelector(".round-label").textContent = paused ? "Resume" : "Pause";
  $("mic").disabled = paused;
  setBusy(state.busy);
}

function enterCall() {
  const { request, characterName } = state.settings;
  const mode = MODES[request.mode] ?? MODES.scene;
  $("call-avatar").textContent = characterName.split(" ").at(-1).charAt(0); // "Dr. Weber" -> W
  $("call-name").textContent = characterName;
  const tense = TENSES[request.tense];
  $("call-mode").textContent = (mode.usesScene
    ? `${$("scenario").selectedOptions[0].textContent.split(" — ")[0]} · ${request.language}`
    : `${mode.label.split(" — ")[0]} · ${request.language}`) + (tense ? ` · ${tense.short}` : "");
  document.body.classList.add("in-call");
  $("conversation").hidden = false;
  startCallTimer();
  updateCallState();
}

function leaveCall() {
  clearInterval(callTimer);
  callTimer = null;
  document.body.classList.remove("in-call");
  $("conversation").hidden = true;
}

// Keep the call screen pinned to the visible area when the phone keyboard opens.
// The keyboard shrinks the visual viewport and (on iOS) scrolls it, but a position:fixed
// layer stays anchored to the full layout viewport — so without this the dock is left
// stranded at the top with a gap above the keyboard. Size the call to the visible height
// and shift it down by the viewport's scroll offset so it lines up with what's on screen.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    const root = document.documentElement.style;
    root.setProperty("--vvh", `${vv.height}px`);
    root.setProperty("--vvtop", `${vv.offsetTop}px`);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

// ---------- conversation turns ----------
async function sendTurn(message) {
  if (state.busy || state.finished) return;
  if (message) addLearnerMessage(message);
  setBusy(true);
  setStatus(`${state.settings.characterName} is thinking…`);
  const slowHint = setTimeout(() => setStatus("Still thinking… longer replies take a moment."), 6000);
  try {
    const { turn, userText } = await chatTurn(state.settings, state.history, message);
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
      state.handsFree = false;
      setStatus("Scene complete! Tap End to start another.");
    } else if (!state.paused) {
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
    const info = await wordInfo({
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

const KEY_INPUTS = { mistral: "mistral-key", groq: "groq-key", gemini: "api-key" };

// Show only the key fields the chosen AI needs; saved keys show as a placeholder.
function showKeyFields() {
  const provider = $("provider").value;
  for (const el of document.querySelectorAll("#keygate [data-provider]")) {
    el.hidden = el.dataset.provider !== provider;
  }
  $("gemini-optional").hidden = provider === "gemini";
  for (const [service, id] of Object.entries(KEY_INPUTS)) {
    $(id).placeholder = getKey(service) ? "Saved — leave blank to keep" : $(id).dataset.placeholder;
  }
}
for (const id of Object.values(KEY_INPUTS)) $(id).dataset.placeholder = $(id).placeholder;
$("provider").addEventListener("change", showKeyFields);

function keySummary() {
  if (getProvider() === "gemini") return "✓ Using Google Gemini.";
  return getKey("groq") ? "✓ Using Mistral, with Groq as backup." : "✓ Using Mistral.";
}

// Show the key box or the setup, depending on whether the chosen AI has a key saved.
function refreshKeyGate() {
  const haveKey = Boolean(getKey(getProvider()));
  $("keygate").hidden = haveKey;
  $("setup").hidden = !haveKey;
  $("key-saved").hidden = !haveKey;
  $("key-summary").textContent = keySummary();
  $("provider").value = getProvider();
  showKeyFields();
}

$("save-key").addEventListener("click", () => {
  const provider = $("provider").value;
  const typed = Object.fromEntries(Object.entries(KEY_INPUTS).map(([service, id]) => [service, $(id).value.trim()]));
  if (!typed[provider] && !getKey(provider)) {
    $("key-status").textContent = `Paste your ${provider === "mistral" ? "Mistral" : "Gemini"} API key first.`;
    return;
  }
  for (const [service, value] of Object.entries(typed)) {
    if (value) setKey(service, value);
    $(KEY_INPUTS[service]).value = "";
  }
  setProvider(provider);
  $("key-status").textContent = "";
  refreshKeyGate();
});

$("change-key").addEventListener("click", () => {
  $("keygate").hidden = false;
  $("setup").hidden = true;
  showKeyFields();
});

$("start").addEventListener("click", async () => {
  const languageSelect = $("language");
  const scenario = $("scenario").value;
  const mode = $("mode").value;
  const usesScene = (MODES[mode] ?? MODES.scene).usesScene;
  const useVocab = $("use-vocab").checked && !$("use-vocab").disabled;
  // Vocab of the chosen level and the ones below it (the list only goes up to B1).
  const VOCAB_LEVELS = ["A1", "A2", "B1"];
  const upTo = VOCAB_LEVELS.indexOf($("level").value);
  const levels = upTo === -1 ? VOCAB_LEVELS : VOCAB_LEVELS.slice(0, upTo + 1);

  let vocab = { enabled: false };
  if (useVocab) {
    // Linked to the trainer: A1/A2 in full plus its learnt B1 words (fetched on page load, so Start never waits).
    const learnt = trainerLink() ? ((await idbGet("learnt_words").catch(() => null)) ?? []) : null;
    const loaded = await loadVocabForSession(levels, learnt);
    vocab = { enabled: loaded > 0, levels, learnt: Boolean(learnt) };
  }

  state.settings = {
    locale: languageSelect.selectedOptions[0].dataset.locale,
    level: $("level").value,
    characterName: usesScene ? (SCENARIOS[scenario] ?? SCENARIOS.cafe).character : PARTNER.character,
    vocab,
    request: {
      language: languageSelect.value,
      nativeLanguage: $("native").value,
      level: $("level").value,
      scenario,
      mode,
      tense: $("tense").value,
    },
  };
  bumpStreak();
  renderStats();
  $("setup").hidden = true;
  enterCall();
  // The on-device voice is the default: get it ready while the first reply loads.
  if (hasPiperVoice(state.settings.locale)) {
    preloadPiper(state.settings.locale).catch((error) => console.warn("Piper download failed:", error));
  }
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

// Load a vocab JSON from a URL.
async function loadVocabUrl(url, { silent } = {}) {
  if (!url) return;
  if (!silent) $("vocab-status").textContent = "Loading from web…";
  try {
    const { count, levels } = await importVocabFromUrl(url);
    $("vocab-status").textContent = `✓ ${count} words loaded (${levels.join(", ")}).`;
    refreshVocabUI(count);
  } catch (error) {
    if (!silent) $("vocab-status").textContent = `Load failed: ${error.message}`;
  }
}

$("load-url").addEventListener("click", () => loadVocabUrl($("vocab-url").value.trim()));

// Fetch the learnt words now and keep them, so they are ready when a conversation starts.
async function refreshLearntWords() {
  if (!trainerLink()) return renderTrainerLink(null);
  $("trainer-status").textContent = "🔗 Linked to your Vocab Trainer · fetching your learnt words…";
  try {
    const words = await fetchLearntWords();
    await idbSet("learnt_words", words);
    renderTrainerLink(higherCount(words));
  } catch (error) {
    const kept = trainerLink() ? higherCount((await idbGet("learnt_words").catch(() => null)) ?? []) : null;
    renderTrainerLink(kept, error.message);
  }
}

function higherCount(words) {
  return words.filter((w) => !KNOWN_LEVELS.includes(w.level)).length;
}

// count: learnt B1 words ready (null when not linked).
function renderTrainerLink(count, problem = "") {
  const linked = Boolean(trainerLink());
  $("trainer-unlink").hidden = !linked;
  $("trainer-form").hidden = linked;
  const text = !linked
    ? "Connect your Vocab Trainer so B1 uses only the words you have learnt there:"
    : `🔗 Linked to your Vocab Trainer · your partner uses all A1 and A2 words plus ${
        count ? `the ${count} B1 words you have learnt there` : "your learnt B1 words (none yet)"}.`;
  $("trainer-status").textContent = problem ? `${problem} ${linked ? text : ""}`.trim() : text;
}

$("trainer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("trainer-email").value.trim();
  const password = $("trainer-password").value;
  $("trainer-connect").disabled = true;
  // The free server sleeps when unused and can take a minute to wake up.
  $("trainer-status").textContent = "Connecting… (the Vocab Trainer can take up to a minute to wake up)";
  try {
    await connectTrainer(email, password);
    $("trainer-password").value = "";
    await refreshLearntWords();
  } catch (error) {
    renderTrainerLink(null, error.message === "Failed to fetch" ? "Couldn't reach the Vocab Trainer." : error.message);
  } finally {
    $("trainer-connect").disabled = false;
  }
});

$("trainer-unlink").addEventListener("click", async () => {
  store.set("trainer_link", null);
  await idbSet("learnt_words", []).catch(() => {});
  renderTrainerLink(null);
  refreshVocabUI((await vocabMeta().catch(() => ({ count: 0 }))).count);
});

function refreshVocabUI(count) {
  const useVocab = $("use-vocab");
  const have = count > 0;
  useVocab.disabled = !have;
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

$("language").addEventListener("change", preloadSelectedVoice);

function submitComposer() {
  // A reply is still loading (or the call is finished/on hold): keep what's typed.
  if (state.busy || state.finished || state.paused) return;
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  if (isPauseCommand(text)) {
    setPaused(true);
    return;
  }
  stopSpeaking();
  sendTurn(text);
}

// Submitting via Enter or the native button click (desktop).
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});

// On phones the on-screen keyboard covers half the screen, so while the text box is
// focused mark the body "typing": the CSS then folds away the big round call controls
// and the vocab row, leaving the input and transcript usable. Keep the latest message
// in view above the keyboard. The layout only goes back once the box has stayed blurred
// for a moment, so a brief blur during a tap can't reflow the dock and move the Send
// button out from under the finger.
let typingTimer = null;
$("text").addEventListener("focus", () => {
  clearTimeout(typingTimer);
  document.body.classList.add("typing");
  scrollCallToBottom();
});
$("text").addEventListener("blur", () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (document.activeElement !== $("text")) document.body.classList.remove("typing");
  }, 300);
});

// Send without dropping the keyboard (see onTap), so you can type the next turn straight
// away. If the browser blurred the box anyway, focusing it again inside the tap keeps
// the keyboard up. Mouse clicks and Enter go through the form's submit handler.
onTap($("composer").querySelector("button[type='submit']"), () => {
  const keepKeyboard = document.body.classList.contains("typing");
  submitComposer();
  if (keepKeyboard) $("text").focus();
}, { click: false });

$("mic").addEventListener("click", () => {
  if (state.handsFree || $("mic").getAttribute("aria-pressed") === "true") {
    stopListening();
  } else {
    state.handsFree = true; // hands-free loop: talk, auto-send on pause, resume after each reply
    startListening();
  }
});

$("pause").addEventListener("click", () => setPaused(!state.paused));

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
  pendingReply = null;
  resumeHandsFree = false;
  setPaused(false);
  $("transcript").replaceChildren();
  $("coach").hidden = true;
  $("suggestions").replaceChildren();
  $("live").textContent = "";
  $("text").value = "";
  setStatus("");
  renderStats();
  renderFocusWords([]);
  setBusy(false);
  leaveCall();
  $("setup").hidden = false;
});

// Voices load asynchronously in Chrome.
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

refreshKeyGate();
renderStats();
renderBookmarks();
// Get the voice ready while the learner picks their settings, so the first reply doesn't wait.
preloadSelectedVoice();
// Show any already-imported vocab; if none, fetch the default URL in the background.
// Then the learnt words from the Vocab Trainer, if linked (or just linked via the URL).
takeTrainerLinkFromUrl();
vocabMeta()
  .then((m) => {
    refreshVocabUI(m.count);
    if (m.count === 0) loadVocabUrl(DEFAULT_VOCAB_URL, { silent: true });
  })
  .catch(() => {})
  .finally(refreshLearntWords);
