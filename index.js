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
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const ACTION_DB = process.env.NOTION_ACTION_DB_ID;

// ===== HEALTH CHECK =====
app.get("/", (req, res) => res.status(200).send("OK"));

// ===== WEBHOOK =====
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  // LINE 要求快速回 200
  res.status(200).send("OK");

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message") continue;
    if (!event.message || event.message.type !== "text") continue;

    const rawText = (event.message.text || "").trim();

    // 你目前用 /f 來代表 Follow up（也可擴充其他指令）
    if (!rawText.startsWith("/f")) continue;

    const taskText = rawText.replace("/f", "").trim();
    if (!taskText) continue;

    try {
      await createActionInNotion({
        taskText,
      });
      console.log("Notion created:", taskText);
    } catch (err) {
      console.error("Notion write error:", err?.body || err);
    }
  }
});

// ===== NOTION WRITE =====
async function createActionInNotion({ taskText }) {
  // 這裡完全對應你 Action DB 的欄位名稱與選項
  return notion.pages.create({
    parent: { database_id: ACTION_DB },
    properties: {
      // Title 欄位（你叫 TASK）
      TASK: {
        title: [
          {
            text: { content: taskText },
          },
        ],
      },

      // Select: Scope -> Line
      Scope: {
        select: { name: "Line" },
      },

      // Select: Action Type -> Follow up
      "Action Type": {
        select: { name: "Follow up" },
      },

      // Multi-select: Owner -> Stacy
      Owner: {
        multi_select: [{ name: "Stacy" }],
      },

      // Select: Status -> OPEN
      Status: {
        select: { name: "OPEN" },
      },
    },
  });
}

// ===== ERROR HANDLER (avoid 502) =====
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(200).send("OK");
});

const port = process.env.PORT || 8888;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
