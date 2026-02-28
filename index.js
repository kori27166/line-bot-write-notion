const express = require("express");
const line = require("@line/bot-sdk");
const { Client } = require("@notionhq/client");

const app = express();

// ===== LINE CONFIG =====
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// ===== NOTION CONFIG =====
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const ACTION_DB = process.env.NOTION_ACTION_DB_ID;

// ===== HEALTH CHECK =====
app.get("/", (req, res) => res.status(200).send("OK"));

// ===== WEBHOOK =====
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message") continue;
    if (event.message.type !== "text") continue;

    const text = event.message.text.trim();

    // Only process commands starting with /
    if (!text.startsWith("/")) continue;

    try {
      await handleCommand(text, event.source.userId);
    } catch (err) {
      console.error("Notion write error:", err);
    }
  }
});

// ===== COMMAND HANDLER =====
async function handleCommand(text, userId) {
  let type = "General";
  let content = text;

  if (text.startsWith("/f")) {
    type = "Follow";
    content = text.replace("/f", "").trim();
  } else if (text.startsWith("/d")) {
    type = "Delegate";
    content = text.replace("/d", "").trim();
  } else if (text.startsWith("/r")) {
    type = "Reference";
    content = text.replace("/r", "").trim();
  }

  await notion.pages.create({
    parent: { database_id: ACTION_DB },
    properties: {
      Title: {
        title: [
          {
            text: {
              content: content,
            },
          },
        ],
      },
      Type: {
        select: { name: type },
      },
      Source: {
        select: { name: "LINE" },
      },
      User: {
        rich_text: [
          {
            text: { content: userId || "unknown" },
          },
        ],
      },
      Status: {
        select: { name: "New" },
      },
    },
  });
}

const port = process.env.PORT || 8888;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
