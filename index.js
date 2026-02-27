const express = require("express");
const line = require("@line/bot-sdk");

// LINE config (these must exist in Render Environment Variables)
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Webhook endpoint (LINE will POST here)
// IMPORTANT: middleware verifies signature and parses body
app.post("/webhook", line.middleware(config), (req, res) => {
  // Always respond quickly
  res.status(200).send("OK");

  // For now we just log events (next step: write to Notion)
  try {
    console.log("LINE events:", JSON.stringify(req.body.events || []));
  } catch (e) {
    console.error("Log error:", e);
  }
});

// Error handler (avoid 502)
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(200).send("OK");
});

const port = process.env.PORT || 8888;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
