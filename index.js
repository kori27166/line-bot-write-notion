/**
 * index.js - LINE webhook -> Notion Action DB
 *
 * Env vars needed on Render:
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   LINE_CHANNEL_SECRET
 *   NOTION_TOKEN
 *   NOTION_ACTION_DB_ID   (32字元，不含 -)
 *
 * Optional:
 *   PORT (Render will provide)
 */

const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { Client: NotionClient } = require("@notionhq/client");

// ---------- ENV (support both naming styles just in case) ----------
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET =
  process.env.LINE_CHANNEL_SECRET || process.env.CHANNEL_SECRET;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_ACTION_DB_ID = process.env.NOTION_ACTION_DB_ID;

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
if (!LINE_CHANNEL_SECRET) throw new Error("Missing LINE_CHANNEL_SECRET");
if (!NOTION_TOKEN) throw new Error("Missing NOTION_TOKEN");
if (!NOTION_ACTION_DB_ID) throw new Error("Missing NOTION_ACTION_DB_ID");

// ---------- Clients ----------
const lineClient = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

const notion = new NotionClient({ auth: NOTION_TOKEN });

// ---------- App ----------
const app = express();

// Health check (Render用)
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("healthy"));

// Webhook (LINE -> POST /webhook)
app.post(
  "/webhook",
  middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  async (req, res) => {
    // 先回 200，避免 LINE timeout
    res.status(200).end();

    const events = req.body.events || [];
    // 逐一處理事件（不影響已回 200）
    await Promise.allSettled(events.map(handleLineEvent));
  }
);

// ---------- Handlers ----------
async function handleLineEvent(event) {
  try {
    // 只處理文字訊息
    if (event.type !== "message") return;
    if (!event.message || event.message.type !== "text") return;

    const rawText = (event.message.text || "").trim();
    const replyToken = event.replyToken;

    // 指令格式：/f 內容
    // 例：/f 明天回覆客人規格
    if (!rawText.toLowerCase().startsWith("/f")) {
      // 非 /f：回覆提示（你也可以改成不回覆）
      if (replyToken) {
        await safeReply(replyToken, [
          {
            type: "text",
            text: '要建立 follow up，請用格式：\n/f 你要記錄的事項\n例如：/f 明天回覆客人規格',
          },
        ]);
      }
      return;
    }

    // 取出 /f 後面的內容
    const content = rawText.replace(/^\/f\b/i, "").trim();

    if (!content) {
      if (replyToken) {
        await safeReply(replyToken, [
          { type: "text", text: "請在 /f 後面輸入要記錄的內容，例如：/f 明天回覆客人規格" },
        ]);
      }
      return;
    }

    // 先回覆 LINE（避免 user 不確定有沒有成功）
    if (replyToken) {
      await safeReply(replyToken, [
        { type: "text", text: `已記錄：${content}\n（我會幫你建立到 Notion Action DB）` },
      ]);
    }

    // 寫入 Notion
    await createActionInNotion({
      taskTitle: content,
    });

  } catch (err) {
    console.error("handleLineEvent error:", err);
    // LINE reply token 有效期短，這裡不強求回覆
  }
}

async function safeReply(replyToken, messages) {
  try {
    await lineClient.replyMessage(replyToken, messages);
  } catch (err) {
    console.error("LINE reply error:", err?.message || err);
  }
}

// ---------- Notion write ----------
async function createActionInNotion({ taskTitle }) {
  // 你提供的欄位設定：
  // Title: Task (title)
  // Scope: select -> Line
  // Action Type: select -> Follow up
  // Owner: multi_select -> Stacy
  // Status: status -> OPEN

  const properties = {
    // ✅ Title 欄位名稱必須精準等於 Notion 顯示的欄名：Task
    "Task": {
      title: [{ text: { content: taskTitle } }],
    },

    "Scope": {
      select: { name: "Line" },
    },

    // ⚠️ 這欄位名稱若你 DB 實際不是 "Action Type"（可能有空格/不同字）
    // 就要把這裡改成 DB 真正的欄位名稱（大小寫、空格都要一致）
    "Action Type": {
      select: { name: "Follow up" },
    },

    "Owner": {
      multi_select: [{ name: "Stacy" }],
    },

    // ✅ Notion status property 一定要用 status（不能用 select）
    "Status": {
      status: { name: "OPEN" },
    },
  };

  try {
    const resp = await notion.pages.create({
      parent: { database_id: NOTION_ACTION_DB_ID },
      properties,
    });

    console.log("Notion created page:", resp?.id);
    return resp;
  } catch (err) {
    // 把 Notion API 的錯誤印清楚
    const data = err?.body || err;
    console.error("Notion write error:", JSON.stringify(data));
    throw err;
  }
}

// ---------- Start server ----------
const port = process.env.PORT || 8888;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
