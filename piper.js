// Piper: open-source neural voices that run in the browser (no key, no quota).
// The voice model downloads once (Cache Storage), then speech is generated on-device.
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js";
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
const PHONEMIZE_URL = "https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js";
const PHONEMIZE_WASM = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const CACHE_NAME = "piper-voices-v1";

// One good voice per app language (Piper has no Japanese voice). German is Thorsten's
// medium voice: clear, and it speaks a reply in a fraction of its length. The high-quality
// one took about twice as long to make as to play (11 s for 5.6 s of speech on a PC).
const VOICES = {
  de: "de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx",
  es: "es/es_ES/davefx/medium/es_ES-davefx-medium.onnx",
  fr: "fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
  it: "it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx",
  pt: "pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx",
};

// Voices replaced by the ones above: removed from the cache so they don't take up space.
const OLD_VOICES = [
  "de/de_DE/thorsten/high/de_DE-thorsten-high.onnx",
  "de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx",
];

// The moods a reply can be spoken in, for voices recorded in several moods.
export const MOODS = ["neutral", "amused", "surprised", "angry", "sleepy", "whisper"];

// Pause between sentences, in seconds.
const SENTENCE_GAP = 0.25;

let ortPromise = null;
let phonemizePromise = null;
const loaded = new Map(); // lang -> Promise<{ session, config }>
const ready = new Set(); // langs whose voice has finished loading

export function hasPiperVoice(locale) {
  return Boolean(VOICES[locale.split("-")[0]]);
}

function loadOrt() {
  ortPromise ??= import(ORT_URL).then((ort) => {
    ort.env.wasm.wasmPaths = ORT_WASM;
    ort.env.wasm.numThreads = 1; // static hosting isn't cross-origin isolated, so no threads
    return ort;
  });
  return ortPromise;
}

// One phonemizer instance, reused: starting it takes about a second, each call a few ms.
let phonemizeOut = null;
function loadPhonemizer() {
  phonemizePromise ??= import(PHONEMIZE_URL)
    .then((m) => m.createPiperPhonemize({
      print: (line) => { phonemizeOut = line; },
      printErr: () => {},
      locateFile: (f) => (f.endsWith(".wasm") ? `${PHONEMIZE_WASM}.wasm` : f.endsWith(".data") ? `${PHONEMIZE_WASM}.data` : f),
    }))
    .catch((error) => { phonemizePromise = null; throw error; });
  return phonemizePromise;
}

// Fetch with a persistent cache so the big model downloads only once.
async function cachedFetch(url, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  } catch {
    // Cache Storage unavailable (private mode); download every session instead.
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`voice download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  let bytes;
  if (reader) {
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(got, total);
    }
    bytes = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  try {
    await cache?.put(url, new Response(bytes));
  } catch {
    // Not enough storage; still usable for this session.
  }
  return bytes.buffer;
}

// Is the voice loaded into memory, so speaking can start right away?
export function piperLoaded(locale) {
  return ready.has(locale.split("-")[0]);
}

// Is the voice for this locale already downloaded (or loaded)?
export async function piperReady(locale) {
  const lang = locale.split("-")[0];
  if (!VOICES[lang]) return false;
  if (ready.has(lang)) return true;
  if (loaded.has(lang)) return false; // still downloading
  try {
    const cache = await caches.open(CACHE_NAME);
    return Boolean(await cache.match(`${VOICES_BASE}/${VOICES[lang]}`));
  } catch {
    return false;
  }
}

async function forgetOldVoices() {
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const v of OLD_VOICES) {
      await cache.delete(`${VOICES_BASE}/${v}`);
      await cache.delete(`${VOICES_BASE}/${v}.json`);
    }
  } catch {
    // Cache Storage unavailable: nothing was kept anyway.
  }
}

// Download (first time) and prepare the voice. Safe to call repeatedly.
export function loadPiperVoice(locale, onProgress) {
  const lang = locale.split("-")[0];
  if (!VOICES[lang]) return Promise.reject(new Error("no open-source voice for this language"));
  if (!loaded.has(lang)) {
    forgetOldVoices();
    const url = `${VOICES_BASE}/${VOICES[lang]}`;
    const p = (async () => {
      const [ort, configBuf, model] = await Promise.all([
        loadOrt(),
        cachedFetch(`${url}.json`),
        cachedFetch(url, onProgress),
        loadPhonemizer(),
      ]);
      const config = JSON.parse(new TextDecoder().decode(configBuf));
      const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
      return { ort, session, config };
    })();
    p.then(() => ready.add(lang), () => loaded.delete(lang)); // allow a retry after a failed download
    loaded.set(lang, p);
  }
  return loaded.get(lang);
}

async function phonemeIds(text, espeakVoice) {
  const phonemizer = await loadPhonemizer();
  phonemizeOut = null;
  phonemizer.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
  if (!phonemizeOut) throw new Error("could not read the text");
  return JSON.parse(phonemizeOut).phoneme_ids;
}

// "Oh! Wirklich? Das ist toll." -> ["Oh!", "Wirklich?", "Das ist toll."]
function sentences(text) {
  return (text.trim().match(/[^.!?…]+[.!?…]*["»«“”)]*/g) ?? []).map((t) => t.trim()).filter(Boolean);
}

async function synthesize(ort, session, config, text, sid, speed) {
  const ids = await phonemeIds(text, config.espeak.voice);
  const inf = config.inference;
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale, inf.length_scale / speed, inf.noise_w]), [3]),
  };
  if (sid !== null) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(sid)]), [1]);
  const { output } = await session.run(feeds);
  return output.data;
}

// Text -> { pcm: 16-bit little-endian mono bytes, sampleRate }, same shape as Gemini TTS.
// speed < 1 speaks more slowly. Each sentence is spoken on its own, so its own "!" or "?"
// shapes it, with a short pause between them. mood picks the recording for voices that have
// several (MOODS); others ignore it.
export async function piperSpeak(text, locale, { speed = 1, mood = "neutral" } = {}) {
  const { ort, session, config } = await loadPiperVoice(locale);
  const speakers = config.speaker_id_map ?? {};
  const sid = Object.keys(speakers).length ? (speakers[mood] ?? speakers.neutral ?? 0) : null;
  const parts = [];
  for (const sentence of sentences(text)) parts.push(await synthesize(ort, session, config, sentence, sid, speed));
  const gap = Math.round(SENTENCE_GAP * config.audio.sample_rate);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const pcm = new Uint8Array(total * 2); // the gaps stay zero: silence
  const view = new DataView(pcm.buffer);
  let at = 0;
  parts.forEach((floats, i) => {
    if (i) at += gap;
    for (let k = 0; k < floats.length; k++, at++) {
      const v = Math.max(-1, Math.min(1, floats[k]));
      view.setInt16(at * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
  });
  return { pcm, sampleRate: config.audio.sample_rate };
}
