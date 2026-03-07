const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  const body = JSON.stringify(req.body);

  const options = {
    hostname: "api.groq.com",
    path: "/openai/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.GROQ_API_KEY,
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", chunk => data += chunk);
    response.on("end", () => {
      try {
        res.json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: "Failed to parse response" });
      }
    });
  });

  request.on("error", (err) => {
    res.status(500).json({ error: err.message });
  });

  request.write(body);
  request.end();
});

app.listen(3001, () => console.log("Proxy running on port 3001"));
