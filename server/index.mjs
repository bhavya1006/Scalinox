import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

// Normalize possible misformatted .env keys with spaces
function getEnv(name) {
  return process.env[name] || process.env[`${name} `] || process.env[` ${name}`];
}

// Lightning API URL (ngrok or deployed URL)
const LIGHTNING_API_URL = getEnv('LIGHTNING_API_URL') || 'https://unthrobbing-norma-premonitory.ngrok-free.dev';

if (!LIGHTNING_API_URL) {
  console.warn('[WARN] LIGHTNING_API_URL not found. Using default ngrok URL.');
}
if (!getEnv('AKASH_CHAT_API_KEY')) {
  console.warn('[WARN] AKASH_CHAT_API_KEY not found. Ensure .env lines use KEY=value without spaces around =');
}

// Akash Chat client for prompt refinement
const akashClient = new OpenAI({
  apiKey: getEnv('AKASH_CHAT_API_KEY'),
  baseURL: 'https://chatapi.akash.network/api/v1',
});

// Simple in-memory cache to reduce API calls
const generationCache = new Map();

// Supported styles mapping (pulling Scalinox client styles + legacy ones)
const stylePrompts = {
  sketch: 'Create a clean, high-quality line art rendering of the subject from the provided sketch. Keep lines confident and readable, refine proportions, and clarify forms. Use subtle variation in line weight. Background minimal. Output should look like polished concept art linework.',
  watercolor: 'Render the subject suggested by the sketch as a soft watercolor painting. Use flowing gradients, soft edges, gentle bleeding, and natural paper texture. Harmonious palette, subtle highlights, and artistic wash. Preserve composition while elevating mood and atmosphere.',
  pencil: 'Recreate the subject as a realistic graphite pencil illustration. Add fine shading, cross-hatching, and tonal depth. Emphasize form, texture, and subtle highlights. Keep it monochrome and elegant, like a finished sketchbook plate.',
  ink: 'Produce a bold black ink illustration of the subject. Crisp, confident lines with expressive brushwork. High contrast, precise contours, limited hatching for depth. Clean white background. Composition should be graphic and readable.',
  charcoal: 'Interpret the subject as a dramatic charcoal drawing. Deep shadows, rich texture, soft blending, and atmospheric edges. Focus on mood and chiaroscuro lighting. Grain of paper should be subtly visible.',
  pastel: 'Render the subject as a dreamy soft pastel artwork. Gentle chalk texture, airy gradients, warm ambient light, and a soothing palette. Soft edges with selective sharp accents. Composition remains faithful to the sketch.',
  digital: 'Create a high-fidelity digital concept art render of the subject. Sharp details, cinematic lighting, and polished finish. Subtle depth of field and professional color grading. Suitable for production artwork.',
  anime: 'Transform the subject into a classic anime-style illustration. Clean lines, expressive eyes, cel shading with crisp highlights, and vibrant colors. Dynamic but readable pose. Respect the composition while elevating style consistency.',
  cyberpunk: 'Reimagine the subject in a neon-drenched cyberpunk aesthetic. Futuristic details, holographic UI elements, neon rim lights, and moody rain-soaked ambience. High-tech textures, magenta/cyan glow, and dystopian skyline hints.',
  fantasy: 'Render the subject in an epic high-fantasy style. Magical lighting, ornate details, mythic atmosphere, and cinematic composition. Subtle particles and ethereal glow. Palette evokes wonder and adventure.'
};

const customPromptPrefix = 'Interpret the provided sketch only for composition and subject, then generate a new high-quality image that follows this user description: ';

const systemRefine = `You are an AI assistant for creative prompt engineering for image generation models.
Refine the user's prompt by adding vivid, concrete visual details about subject, setting, lighting, mood, style, composition.
Do not change the core subject. Output ONLY the refined prompt.`;

const app = express();

const explicitOrigins = (process.env.FRONTEND_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const baseOrigins = ['http://localhost:5183','http://localhost:3030','http://127.0.0.1:5183','http://127.0.0.1:3030'];
const originsSet = new Set([...(explicitOrigins.length? explicitOrigins : baseOrigins)]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allowOrigin = null;
  if (origin) {
    if (originsSet.has(origin) || /^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '25mb' }));

app.get('/health', async (_req, res) => {
  // Check Lightning API health
  try {
    const response = await fetch(`${LIGHTNING_API_URL}/health`);
    if (response.ok) {
      const data = await response.json();
      res.json({ status: 'ok', model: 'lightning', lightningStatus: data, styles: Object.keys(stylePrompts) });
    } else {
      res.json({ status: 'ok', model: 'lightning', lightningStatus: 'unavailable', styles: Object.keys(stylePrompts) });
    }
  } catch (e) {
    res.json({ status: 'ok', model: 'lightning', lightningStatus: 'connection_error', styles: Object.keys(stylePrompts) });
  }
});

// Prompt refinement via Akash Chat
app.post('/refinePrompt', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt required' });
    }
    const response = await akashClient.chat.completions.create({
      model: 'gpt-oss-120b',
      messages: [
        { role: 'system', content: systemRefine },
        { role: 'user', content: prompt },
      ],
    });
    const refined = response.choices?.[0]?.message?.content?.trim();
    if (!refined) return res.status(502).json({ error: 'Refinement failed' });
    // If identical, append a subtle enhancement
    const finalPrompt = refined.toLowerCase() === prompt.toLowerCase().trim()
      ? `${prompt.trim()}, cinematic lighting, richly detailed, ultra high quality`
      : refined;
    res.json({ prompt: finalPrompt });
  } catch (e) {
    console.error('Refine error:', e);
    res.status(500).json({ error: 'Refine service error' });
  }
});

// Image generation using Lightning API
app.post('/generate', async (req, res) => {
  try {
    const { prompt, style, imageDataUri } = req.body || {};
    const mode = (req.body && req.body.mode) === 'prompt' ? 'prompt' : 'style';
    const steps = req.body.steps || 10;
    const guidance = req.body.guidance || 1.5;
    const negativePrompt = req.body.negativePrompt || 'blurred, low quality, distortion';

    // 1. Check Cache
    const cacheKey = JSON.stringify({ prompt, style, mode, imageDataUri, steps, guidance });
    if (generationCache.has(cacheKey)) {
      console.log('[CACHE] Serving cached response');
      return res.json(generationCache.get(cacheKey));
    }

    let finalPrompt = '';
    if (mode === 'style') {
      if (!style || !stylePrompts[style]) {
        return res.status(400).json({ error: 'Unknown or missing style' });
      }
      finalPrompt = stylePrompts[style];
    } else {
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt required for dream mode' });
      }
      finalPrompt = `${customPromptPrefix}"${prompt.trim()}"`;
    }

    // Validate image data URI
    if (!imageDataUri || typeof imageDataUri !== 'string' || !imageDataUri.startsWith('data:')) {
      return res.status(400).json({ error: 'Valid image data URI required' });
    }

    // Extract image data from data URI
    const match = imageDataUri.match(/^data:(.+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image data URI format' });
    }
    const mimeType = match[1];
    const base64Data = match[2];
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Prepare FormData for Lightning API (using native FormData + Blob)
    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: mimeType });
    formData.append('file', blob, 'image.png');
    formData.append('prompt', finalPrompt);
    formData.append('negative_prompt', negativePrompt);
    formData.append('steps', String(steps));
    formData.append('guidance', String(guidance));

    console.log(`[Lightning] Sending request with prompt: "${finalPrompt.substring(0, 50)}..."`);

    let result;
    let retries = 3;
    let delay = 5000; // Start with 5 seconds wait for errors

    while (true) {
      try {
        const response = await fetch(`${LIGHTNING_API_URL}/lightning`, {
          method: 'POST',
          body: formData,
          // Don't set Content-Type header - fetch sets it automatically with boundary
        });

        if (response.ok) {
          result = await response.arrayBuffer();
          break; // Success, exit loop
        } else if (response.status === 429 && retries > 0) {
          console.warn(`[429] Rate limit hit. Retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retries--;
          delay *= 2; // Exponential backoff
        } else {
          const errorText = await response.text();
          console.error(`[Lightning] Error ${response.status}: ${errorText}`);
          return res.status(response.status).json({ error: `Lightning API error: ${errorText}` });
        }
      } catch (e) {
        if (retries > 0) {
          console.warn(`[Network] Connection error. Retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retries--;
          delay *= 2;
        } else {
          throw e;
        }
      }
    }

    // Convert result to base64 data URI
    const outputBuffer = Buffer.from(result);
    const outputBase64 = outputBuffer.toString('base64');
    const outputDataUri = `data:image/png;base64,${outputBase64}`;

    const responseData = { imageDataUri: outputDataUri, mode };
    
    // 2. Save to Cache
    generationCache.set(cacheKey, responseData);
    // Keep cache size manageable
    if (generationCache.size > 100) {
      const firstKey = generationCache.keys().next().value;
      generationCache.delete(firstKey);
    }

    console.log('[Lightning] Generation successful');
    res.json(responseData);
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: 'Generation service error' });
  }
});

const PORT = process.env.PORT || 7003;
app.listen(PORT, () => {
  console.log(`Scalinox Gemini server running on :${PORT}`);
});
