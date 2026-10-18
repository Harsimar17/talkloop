# Talkloop(A Fully Vibe Coded Web Application)

Practise speaking a language with an AI character — live voice input, native-sounding
spoken replies, coaching, translations and a word explorer. It runs **entirely in your
browser** and talks to Mistral (or Google Gemini) with **your own free API key**, so it's free to host as a
static site (e.g. GitHub Pages).

## Use it

1. Open the page(https://harsimar17.github.io/talkloop/).
2. Pick the AI and paste its free key:
   - **Mistral** (recommended, best German): key from [console.mistral.ai](https://console.mistral.ai/api-keys)
     on the free Experiment plan. Optionally add a **Groq** key ([console.groq.com](https://console.groq.com/keys)),
     used automatically when Mistral is busy.
   - **Gemini**: key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A Gemini key is
     also used as the backup voice.

   Keys are stored only in your browser (`localStorage`) and are sent only to their own service.
3. Pick a language, level and scene, and start talking.

Use **Chrome or Edge** for voice input (they provide the microphone speech recognition).
Typing works in any browser.

## Features

- **Voice conversation** with live transcripts; a hands-free mode (tap the mic, then just talk).
- **Natural-sounding replies** from an open-source voice that runs on your device (no limit),
  with word-by-word highlighting.
- **Coach** corrections and tips each turn, **suggestions**, per-message **translation**.
- **Word explorer**: tap any word for meaning, pronunciation and an example; save it.
- **Streaks** and a per-scene rapport score (stored per browser).
- **Your learnt words**: under "My vocabulary", connect the
  [Deutsch Vocab Trainer](https://deutsch-vocab-trainer-v2-1.onrender.com/) with its email and password (or in
  the trainer, tap your initial → **practise in Talkloop**). Talkloop logs in once, keeps only a read-only link
  to the words you have learnt there (valid 180 days) and never stores the password. Your partner works every A1 and A2 word into the conversation, but for B1 only the words you have
  learnt (shakiest first), so you practise using them; the coach checks how you used them. Without the link,
  the whole vocabulary list is used.

## Host it free on GitHub Pages

1. Create a new GitHub repository and push these files (`index.html`, `app.js`, `piper.js`, `styles.css`,
   `README.md`) to the `main` branch.
   ```bash
   git init
   git add .
   git commit -m "Talkloop"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch **main**, folder **/ (root)**, then **Save**.
3. After a minute your app is live at `https://<you>.github.io/<repo>/`.

Every visitor enters their own keys, so you never ship a key and there's no server to run.

## Models used

- Conversation (Mistral): `mistral-small-latest`, falling back to Groq's `openai/gpt-oss-120b`
  when Mistral is rate-limited or busy
- Conversation (Gemini): `gemini-flash-lite-latest` (replies in about a second), falling back to
  `gemini-flash-latest`
- Speech (default): [Piper](https://github.com/rhasspy/piper), an open-source voice that runs on
  the device (`piper.js`). The voice (German: "Thorsten", ~63 MB plus ~18 MB of pronunciation
  data) downloads when you start your first conversation and is then stored in the browser.
  No key, no limit.
- Speech (backup): `gemini-3.8-flash-tts`, used while Piper is still downloading or for
  Japanese, which has no Piper voice. After that, the browser's own voice.

Change these at the top of `app.js` / `piper.js` if you like.

## Notes

- **No key is in this repo.** Never commit one. `.gitignore` excludes common secret files.
- Free Gemini tiers have daily request caps; Gemini TTS has its own small cap (10 a day), which
  is why Piper is the default voice. Replays reuse audio already made.
- `docs/lingolooper-analysis.md` is background notes on the design and is not part of the app.
