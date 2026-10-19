// Piper: open-source neural voices that run in the browser (no key, no quota).
// The voice model downloads once (Cache Storage), then speech is generated on-device.
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js";
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
const PHONEMIZE_URL = "https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js";
const PHONEMIZE_WASM = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const CACHE_NAME = "piper-voices-v1";

// One good voice per app language (Piper has no Japanese voice).
const VOICES = {
  de: "de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx",
  es: "es/es_ES/davefx/medium/es_ES-davefx-medium.onnx",
  fr: "fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
  it: "it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx",
  pt: "pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx",
};

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

// Download (first time) and prepare the voice. Safe to call repeatedly.
export function loadPiperVoice(locale, onProgress) {
  const lang = locale.split("-")[0];
  if (!VOICES[lang]) return Promise.reject(new Error("no open-source voice for this language"));
  if (!loaded.has(lang)) {
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

// Text -> { pcm: 16-bit little-endian mono bytes, sampleRate }, same shape as Gemini TTS.
// speed < 1 speaks more slowly.
export async function piperSpeak(text, locale, { speed = 1 } = {}) {
  const { ort, session, config } = await loadPiperVoice(locale);
  const ids = await phonemeIds(text.trim(), config.espeak.voice);
  const inf = config.inference;
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale, inf.length_scale / speed, inf.noise_w]), [3]),
  };
  if (Object.keys(config.speaker_id_map ?? {}).length) {
    feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
  }
  const { output } = await session.run(feeds);
  const floats = output.data;
  const pcm = new Uint8Array(floats.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return { pcm, sampleRate: config.audio.sample_rate };
}
