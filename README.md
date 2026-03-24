# Frameforge — AI Video Pipeline

Prompt → storyboard → video. Built with Claude + Imagen 3 + Veo 3.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure API keys
Edit `.env` (already created):
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
GOOGLE_AI_API_KEY=AIza-your-key-here
PORT=3000
```

Get your keys:
- Anthropic: https://console.anthropic.com/
- Google AI:  https://aistudio.google.com/app/apikey
  (Make sure your Google AI account has Imagen 3 + Veo 3 access)

### 3. Run
```bash
npm start
```
Then open http://localhost:3000

For development with auto-reload:
```bash
npm run dev
```

---

## How it works

| Step | What happens |
|------|-------------|
| **1 — Idea** | You write a plain-language description + optional reference image |
| **2 — Structure** | Claude parses it into a shot-by-shot JSON with image prompts |
| **3 — Storyboard** | Imagen 3 generates a 16:9 frame per shot. You approve / give feedback / regenerate until all shots look right |
| **4 — Video** | Approved frames go to Veo 3 one by one. Each clip is available to download. Stitch with ffmpeg if needed. |

## Stitching clips

After downloading all clips, run:
```bash
# create filelist.txt
for f in shot-*.mp4; do echo "file '$f'"; done > filelist.txt

# stitch
ffmpeg -f concat -safe 0 -i filelist.txt -c copy final.mp4
```

## Project structure

```
frameforge/
├── .env              ← your API keys (never commit this)
├── .gitignore
├── package.json
├── server.js         ← Express server + API proxy
└── public/
    └── index.html    ← full frontend UI
```

## API routes (all internal — keys never leave your server)

| Route | Description |
|-------|-------------|
| `GET  /api/health` | Verify server is running |
| `POST /api/parse` | Claude parses prompt → shot JSON |
| `POST /api/generate-image` | Imagen 3 → storyboard frame |
| `POST /api/generate-video-clip` | Veo 3 → starts long-running operation |
| `GET  /api/poll-video/:op` | Poll Veo operation status |
