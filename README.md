# Talkloop(A Fully Vibe Coded Web Application)

Practise speaking a language with an AI character — live voice input, native-sounding
spoken replies, coaching, translations and a word explorer. It runs **entirely in your
browser** and talks to Google Gemini with **your own API key**, so it's free to host as a
static site (e.g. GitHub Pages).

## Use it

1. Open the page.
2. Paste a **Gemini API key** (free from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
   The key is stored only in your browser (`localStorage`) and is sent only to Google.
3. Pick a language, level and scene, and start talking.

Use **Chrome or Edge** for voice input (they provide the microphone speech recognition).
Typing works in any browser.

## Features

- **Voice conversation** with live transcripts; a hands-free mode (tap the mic, then just talk).
- **Native-sounding replies** via Gemini TTS, with word-by-word highlighting; falls back to the
  browser voice if TTS quota runs out.
- **Coach** corrections and tips each turn, **suggestions**, per-message **translation**.
- **Word explorer**: tap any word for meaning, pronunciation and an example; save it.
- **Streaks** and a per-scene rapport score (stored per browser).

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

Every visitor enters their own Gemini key, so you never ship a key and there's no server to run.

## Models used

- Conversation: `gemini-flash-lite-latest` (cheapest, highest free limits)
- Speech: `gemini-3.8-flash-tts`
- Backup speech: [Piper](https://github.com/rhasspy/piper), an open-source voice that runs on the
  device (`piper.js`). It's used once the Gemini voice's daily free limit runs out. The voice
  (German: "Thorsten", ~63 MB plus ~18 MB of pronunciation data) downloads the first time it's
  needed and is then stored in the browser. No key, no limit. Japanese has no Piper voice, so it
  uses the browser voice.

Change these at the top of `app.js` / `piper.js` if you like.

## Notes

- **No key is in this repo.** Never commit one. `.gitignore` excludes common secret files.
- Free Gemini tiers have daily request caps; TTS has its own smaller cap (10 a day), after which
  the app switches to the Piper voice until the reset time. Replays reuse audio already made.
- `docs/lingolooper-analysis.md` is background notes on the design and is not part of the app.
