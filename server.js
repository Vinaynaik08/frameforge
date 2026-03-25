require('dotenv').config();
const express = require('express');
const path    = require('path');
const { fal } = require('@fal-ai/client');
const { GoogleGenAI } = require('@google/genai');

const app            = express();
const GOOGLE_API_KEY = process.env.GOOGLE_AI_API_KEY;
const FAL_KEY        = process.env.FAL_KEY;
const PORT           = process.env.PORT || 3000;

if (!GOOGLE_API_KEY) { console.error('\n❌  Missing GOOGLE_AI_API_KEY in .env\n'); process.exit(1); }
if (!FAL_KEY)        { console.error('\n❌  Missing FAL_KEY in .env\n'); process.exit(1); }

// ── Configure fal client ────────────────────────────────────────
fal.config({ credentials: FAL_KEY });

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

// ── Model config ────────────────────────────────────────────────
// Wan 2.6 I2V: supports duration "5", "10", "15" (strings), 720p/1080p
const WAN_ENDPOINT = 'wan/v2.6/image-to-video';

// ── stores ──────────────────────────────────────────────────────
const videoOps = {};
const costLog  = { image: [], video: [] };

// ── pricing ─────────────────────────────────────────────────────
const PRICE = {
  imagenPerImage:     0.040,
  wan26Per5s720p:     0.50,   // ~$0.10/s × 5s
  wan26Per10s720p:    1.00,   // ~$0.10/s × 10s
  wan26Per5s1080p:    0.75,   // ~$0.15/s × 5s
  wan26Per10s1080p:   1.50,   // ~$0.15/s × 10s
};

// ── middleware ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── helpers ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wan 2.6 only accepts "5", "10", or "15" as strings
function snapDuration(d) {
  const n = parseInt(d) || 5;
  if (n <= 7)  return '5';
  if (n <= 12) return '10';
  return '15';
}

function makeLocalId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Upload image to fal storage ─────────────────────────────────
async function uploadToFal(imageBuffer, mime) {
  const ext      = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const filename = `frame_${Date.now()}.${ext}`;
  console.log(`[upload] ${filename} (${(imageBuffer.length / 1024).toFixed(0)} KB)…`);

  const blob = new Blob([imageBuffer], { type: mime });
  const file = new File([blob], filename, { type: mime });
  const url  = await fal.storage.upload(file);

  if (!url?.startsWith('http')) throw new Error(`Unexpected upload response: ${url}`);
  console.log(`[upload] ✅ ${url}`);
  return url;
}

// ── costs ────────────────────────────────────────────────────────
app.get('/api/costs', (_req, res) => {
  const imageTotal = costLog.image.reduce((a, b) => a + b.cost, 0);
  const videoTotal = costLog.video.reduce((a, b) => a + b.cost, 0);
  res.json({
    entries: costLog,
    totals: { image: imageTotal, video: videoTotal, grand: imageTotal + videoTotal }
  });
});

// STEP 0: Parse the text
// ── SCRIPT → SHOT BREAKDOWN (Gemini) ─────────────────────────────
// ── SCRIPT → SHOT BREAKDOWN (Gemini) ─────────────────────────────
app.post('/api/breakdown-script', async (req, res) => {
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'script is required' });

  try {
    const model = 'gemini-2.5-flash';

    const prompt = `
You are a professional cinematic storyboard artist.

You will receive:
1. A script
2. (Optional) A reference image

GOAL:
Convert the script into clean cinematic shots.

-----------------------------------
REFERENCE IMAGE LOGIC
-----------------------------------

IF a reference image is PROVIDED:
- STRICTLY preserve the character(s) from the image
- Do NOT change face, body, hairstyle, clothing, or identity
- Maintain identical appearance across ALL shots
- Do NOT redesign or reimagine the character
- Use the image as the visual ground truth

IF NO reference image is PROVIDED:
- Generate characters naturally based on the script
- Keep character appearance consistent across all shots
- Do NOT randomly change looks between shots

-----------------------------------
STRICT VISUAL RULES
-----------------------------------

- 1 shot = ONLY 1 idea or action
- NEVER combine multiple actions in one shot
- If multiple actions exist → split into multiple shots
- Keep visuals simple and focused
- No sequences inside a single shot

-----------------------------------
SHOT STRUCTURE RULES
-----------------------------------

- ONE subject + ONE action per shot
- Avoid "and", "then", "while"
- No multiple events in one prompt

-----------------------------------
DURATION RULES
-----------------------------------

- Only allowed: 5, 10, or 15 seconds
- 5 sec → static/simple
- 10 sec → moderate action
- 15 sec → emotional or slow movement

-----------------------------------
CAMERA RULES
-----------------------------------

Use ONLY one:
- "static"
- "slow pan"
- "slow zoom"
- "tracking"

-----------------------------------
PROMPT STYLE
-----------------------------------

- Cinematic, realistic, visually rich
- Include subject, environment, lighting, mood
- Keep it concise and focused
- NO multiple actions

-----------------------------------
OUTPUT FORMAT (STRICT JSON ONLY)
-----------------------------------

{
  "shots": [
    {
      "prompt": "single clear visual scene",
      "camera": "one simple camera movement",
      "duration": 5,
      "dialogue": ""
    }
  ]
}

-----------------------------------
FINAL RULES
-----------------------------------

- Do NOT merge actions
- Prefer MORE shots over complex shots
- Character consistency is mandatory
- If image exists → it overrides all character design

Script:
${script}
`;

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.3 }
    });

    // ✅ FIXED: handle multi-part responses
    const parts = result.candidates?.[0]?.content?.parts || [];

    let text = parts
      .map(p => p.text || '')
      .join('')
      .trim();

    // DEBUG
    console.log("RAW GEMINI RESPONSE:\n", text);

    if (!text) throw new Error('Empty response');

    // CLEAN
    text = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      parsed = JSON.parse(match[0]);
    }

    if (!parsed.shots || !Array.isArray(parsed.shots)) {
      throw new Error('Invalid format from AI');
    }

    return res.json(parsed);

  } catch (err) {
    console.error('[breakdown] ❌', err);

    return res.status(500).json({
      error: 'Breakdown failed',
      details: err.message
    });
  }
});
// ── STEP 1: Generate Image (Gemini) ─────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  const { prompt, referenceImageBase64, referenceImageMime, aspectRatio } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const hasRef    = !!referenceImageBase64;
  const model     = 'gemini-3.1-flash-image-preview';
  const isPortrait = aspectRatio === '9:16';
  const ratioLabel = isPortrait ? '9:16 vertical/portrait' : '16:9 landscape/cinematic';

  console.log(`\n[image] mode=${hasRef ? 'img2img' : 'txt2img'} ratio=${ratioLabel} prompt="${prompt.slice(0, 80)}"`);

  try {
    const parts = [];

    if (hasRef) {
      parts.push({
        text: `You are a professional film frame generator. Your task is to generate a single cinematic still frame that precisely continues from the attached reference image.

═══════════════════════════════════════
CRITICAL IDENTITY PRESERVATION RULES:
═══════════════════════════════════════
1. CHARACTER IDENTITY: The character's face, skin tone, facial structure, eye color, hair color, hairstyle, and all facial features MUST be IDENTICAL to the reference image. Any deviation is a failure.
2. CLOTHING: Every garment, accessory, color, texture, and style detail must be preserved exactly as in the reference. Do NOT add, remove, or change any clothing item.
3. BODY: Preserve the character's body type, proportions, and physique exactly.
4. STYLE: Maintain the same visual style, color grading, lighting quality, and artistic treatment as the reference image.

═══════════════════════════════════════
OUTPUT SPECIFICATIONS:
═══════════════════════════════════════
- Aspect ratio: ${ratioLabel}
- Quality: Photorealistic, 8K cinematic photography
- Lighting: Match the reference image lighting style
- Camera angle: As described in the prompt

═══════════════════════════════════════
SCENE PROMPT (apply ONLY these changes):
═══════════════════════════════════════
${prompt}

REMEMBER: Only change what the prompt explicitly asks for. Everything else stays identical to the reference.`
      });
      parts.push({
        inlineData: {
          mimeType: referenceImageMime || 'image/jpeg',
          data:     referenceImageBase64,
        }
      });
    } else {
      parts.push({
        text: `Generate a single cinematic still frame.

SPECIFICATIONS:
- Aspect ratio: ${ratioLabel}
- Quality: Photorealistic, 8K cinematic photography
- Style: Professional film production quality

SCENE:
${prompt}

Render as a high-quality, photorealistic cinematic frame with professional lighting and composition.`
      });
    }

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['TEXT', 'IMAGE'], temperature: hasRef ? 0.2 : 0.5 }
    });

    const responseParts = result.candidates?.[0]?.content?.parts ?? [];
    let imageB64  = null;
    let imageMime = 'image/png';

    for (const part of responseParts) {
      if (part.inlineData?.data)  { imageB64 = part.inlineData.data;  imageMime = part.inlineData.mimeType   || 'image/png'; break; }
      if (part.inline_data?.data) { imageB64 = part.inline_data.data; imageMime = part.inline_data.mime_type || 'image/png'; break; }
    }

    if (!imageB64) throw new Error('Gemini returned no image data');

    costLog.image.push({ ts: Date.now(), model, mode: hasRef ? 'reference' : 'text-only', cost: PRICE.imagenPerImage });
    console.log(`[image] ✅ done | cost=$${PRICE.imagenPerImage}`);
    return res.json({ imageBase64: imageB64, mimeType: imageMime });

  } catch (err) {
    console.error(`[image] ❌ ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ── STEP 2: Submit Video (Wan 2.6 via fal) ───────────────────────
app.post('/api/generate-shot-video', async (req, res) => {
  const { imageBase64, imageMime, prompt, duration, dialogueText, camera, aspectRatio } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt are required' });

  const durationStr  = snapDuration(duration);
  const mime         = imageMime || 'image/png';
  const localId      = makeLocalId();
  const ratio        = aspectRatio === '9:16' ? '9:16' : '16:9';
  const cameraNote   = camera ? `Camera: ${camera.trim()}.` : '';

  // Build the video motion prompt
  // If dialogue is provided, inject it as character speech for lip movement
  let speechNote = '';
  if (dialogueText && dialogueText.trim()) {
    speechNote = `The character looks toward the camera and speaks the following line with natural lip movement and facial expression(NO AUDIO): "${dialogueText.trim()}"`;
  }

  const wanPrompt = [
    `Photorealistic cinematic video. ${cameraNote}`,
    prompt.trim(),
    speechNote,
    `No audio. No sound. Silent video output.`,
    `The character's face, clothing, hair, skin tone, and all physical features must remain IDENTICAL to the first frame throughout the entire video. No character drift. No appearance changes.`,
    `Smooth natural motion. Cinematic lighting. Professional film quality. ${ratio} aspect ratio.`,
    `AVOID: morphing, warping, identity changes, costume changes, flickering faces, distorted features.`
  ].filter(Boolean).join(' ');

  console.log(`\n[video] localId=${localId} | duration=${durationStr}s | ratio=${ratio} | model=wan-2.6-i2v`);
  console.log(`[video] Prompt: "${wanPrompt.slice(0, 160)}"`);

  videoOps[localId] = { done: false, videoBase64: null, error: null, status: 'UPLOADING' };

  // Return immediately — background pipeline handles the rest
  res.json({ operationName: localId });

  runWanPipeline(localId, imageBase64, mime, wanPrompt, durationStr, ratio);
});

// ── Background pipeline ──────────────────────────────────────────
async function runWanPipeline(localId, imageBase64, mime, wanPrompt, durationStr, ratio) {
  try {

    // ── 1. Upload start frame to fal storage ────────────────────
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const imageUrl    = await uploadToFal(imageBuffer, mime);
    videoOps[localId].status = 'IN_QUEUE';

    // ── 2. Submit to Wan 2.6 queue ───────────────────────────────
    console.log(`[video] ${localId} — submitting to Wan 2.6 I2V…`);
    const { request_id } = await fal.queue.submit(WAN_ENDPOINT, {
      input: {
        prompt:                  wanPrompt,
        image_url:               imageUrl,
        duration:                durationStr,        // "5", "10", or "15"
        resolution:              '720p',
        aspect_ratio:            ratio,              // "16:9" or "9:16"
        enable_prompt_expansion: false,              // We craft the prompt ourselves
        multi_shots:             false,              // Single continuous shot per card
        negative_prompt:         'low resolution, blurry, distorted face, morphing, identity change, costume change, flickering, artifacts, watermark, text, subtitle, logo, worst quality',
        enable_safety_checker:   true,
      },
    });

    if (!request_id) throw new Error('No request_id from Wan 2.6 submit');
    console.log(`[video] ${localId} — queued | request_id=${request_id}`);
    videoOps[localId].falReqId = request_id;

    // ── 3. Poll until COMPLETED ─────────────────────────────────
    for (let i = 0; i < 120; i++) {   // 120 × 8s = 16 min max (longer for 10s/15s clips)
      await sleep(8000);

      try {
        const statusResult = await fal.queue.status(WAN_ENDPOINT, {
          requestId: request_id,
          logs: false,
        });

        const status  = statusResult.status;
        const elapsed = ((i + 1) * 8).toFixed(0);
        console.log(`[poll] ${localId} [${elapsed}s] → ${status}`);
        videoOps[localId].status = status || 'IN_PROGRESS';

        if (status === 'FAILED') {
          throw new Error(statusResult.error || 'Wan 2.6 job failed');
        }

        if (status === 'COMPLETED') {
          // ── 4. Fetch result ──────────────────────────────────
          const result   = await fal.queue.result(WAN_ENDPOINT, { requestId: request_id });
          const videoUrl = result?.data?.video?.url || result?.video?.url;
          if (!videoUrl) throw new Error(`No video URL in result: ${JSON.stringify(result).slice(0, 200)}`);

          // ── 5. Download MP4 as base64 ────────────────────────
          console.log(`[video] ${localId} — downloading MP4…`);
          const vidRes = await fetch(videoUrl);
          if (!vidRes.ok) throw new Error(`MP4 download failed [${vidRes.status}]`);
          const b64 = Buffer.from(await vidRes.arrayBuffer()).toString('base64');

          // Estimate cost: $0.15/s at 1080p
          const cost = parseFloat(durationStr) * 0.15;
          costLog.video.push({ ts: Date.now(), durationStr, cost, model: 'wan-2.6-i2v', resolution: '1080p' });

          videoOps[localId] = { done: true, videoBase64: b64, error: null, status: 'COMPLETED' };
          console.log(`[video] ✅ ${localId} | ~${durationStr}s | cost≈$${cost.toFixed(3)}`);
          return;
        }

      } catch (pollErr) {
        // Don't crash on transient poll errors — log and retry
        console.warn(`[poll] ${localId} transient error: ${pollErr.message}`);
      }
    }

    throw new Error('Timed out after 16 minutes');

  } catch (err) {
    console.error(`[video] ❌ ${localId} — ${err.message}`);
    videoOps[localId] = { done: true, error: err.message, status: 'FAILED' };
  }
}

// ── Poll endpoint ────────────────────────────────────────────────
app.get('/api/poll-video', (req, res) => {
  const { op } = req.query;
  const st = videoOps[op];
  if (!st)                       return res.status(404).json({ error: 'Operation not found' });
  if (st.done && st.error)       return res.status(500).json({ error: st.error });
  if (st.done && st.videoBase64) return res.json({ done: true, videoBase64: st.videoBase64 });
  return res.json({ done: false, status: st.status || 'IN_QUEUE' });
});

app.listen(PORT, () => console.log(`🎬 Frameforge · Wan 2.6 I2V · Ready on http://localhost:${PORT}`));
