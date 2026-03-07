const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

// ── Groq chat ──────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const body = JSON.stringify(req.body);
  const apiKey = process.env.GROQ_API_KEY;

  const options = {
    hostname: "api.groq.com",
    path: "/openai/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", chunk => data += chunk);
    response.on("end", () => {
      try { res.json(JSON.parse(data)); }
      catch (e) { res.status(500).json({ error: "Failed to parse response" }); }
    });
  });
  request.on("error", (err) => res.status(500).json({ error: err.message }));
  request.write(body);
  request.end();
});

// ── ElevenLabs TTS ─────────────────────────────────────────────────────────────
// Voice: Rachel (warm, natural female) — voice_id: 21m00Tcm4TlvDq8ikWAM
const ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

app.post("/speak", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const body = JSON.stringify({
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true }
  });

  const options = {
    hostname: "api.elevenlabs.io",
    path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const request = https.request(options, (response) => {
    if (response.statusCode !== 200) {
      let err = "";
      response.on("data", c => err += c);
      response.on("end", () => {
        console.error("ElevenLabs status:", response.statusCode, "body:", err);
        res.status(500).json({ error: "ElevenLabs error", status: response.statusCode, detail: err });
      });
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");
    response.pipe(res);
  });

  request.on("error", (err) => res.status(500).json({ error: err.message }));
  request.write(body);
  request.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
