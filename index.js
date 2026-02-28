/**
 * index.js - LINE bot + Notion (Action DB + Inbox DB)
 *
 * Env required:
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - NOTION_TOKEN
 * - NOTION_ACTION_DB_ID
 * - NOTION_INBOX_DB_ID
 */

const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { Client: NotionClient } = require("@notionhq/client");

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new Client(lineConfig);

const notion = new NotionClient({
  auth: process.env.NOTION_TOKEN,
});

// ---- Notion DB IDs (accept with/without dashes) ----
const ACTION_DB_ID = normalizeNotionId(process.env.NOTION_ACTION_DB_ID);
const INBOX_DB_ID = normalizeNotionId(process.env.NOTION_INBOX_DB_ID);

function normalizeNotionId(id) {
  if (!id) return "";
  // remove any non-hex chars (including dash)
  return String(id).replace(/[^a-fA-F0-9]/g, "");
}

// ---- Action DB property names (match your DB) ----
const ACTION_PROPS = {
  title: "Task",
  scope: "Scope",
  actionType: "Action Type",
  owner: "Owner",
  status: "Status",
  dueDate: "Due Date",
  priority: "Priority",
};

// ---- Inbox DB property names (match your new DB) ----
const INBOX_PROPS = {
  title: "Item",
  raw: "Raw",
  source: "Source",
};

// ---- Status values (match your status options) ----
const STATUS_VALUES = {
  OPEN: "OPEN",
  WAITING_INTERNAL: "Waiting- internal",
  WAITING_CUSTOMER: "Waiting- customer",
  IN_PROGRESS: "In progress",
};

const STATUS_INPUT_MAP = new Map([
  ["open", STATUS_VALUES.OPEN],
  ["waiting-internal", STATUS_VALUES.WAITING_INTERNAL],
  ["waiting internal", STATUS_VALUES.WAITING_INTERNAL],
  ["waiting- internal", STATUS_VALUES.WAITING_INTERNAL],
  ["waiting internal ", STATUS_VALUES.WAITING_INTERNAL],
  ["waiting-customer", STATUS_VALUES.WAITING_CUSTOMER],
  ["waiting customer", STATUS_VALUES.WAITING_CUSTOMER],
  ["waiting- customer", STATUS_VALUES.WAITING_CUSTOMER],
  ["inprogress", STATUS_VALUES.IN_PROGRESS],
  ["in progress", STATUS_VALUES.IN_PROGRESS],
  ["progress", STATUS_VALUES.IN_PROGRESS],
]);

// ---- Routes ----
app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  // Respond quickly to LINE, then process
  res.status(200).end();

  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEventSafely));
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

async function handleEventSafely(event) {
  try {
    await handleEvent(event);
  } catch (err) {
    console.error("Event handling error:", err);
  }
}

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (!event.message || event.message.type !== "text") return;

  const userText = (event.message.text || "").trim();
  if (!userText) return;

  // Commands
  if (userText.startsWith("/")) {
    const reply = await handleCommand(userText);
    if (reply) {
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: reply,
      });
    }
    return;
  }

  // Default behavior: store to Inbox DB
  const inboxResult = await createInboxItem(userText);

  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: inboxResult,
  });
}

// ---- Command handler ----
async function handleCommand(text) {
  const [cmdRaw, ...rest] = text.split(" ");
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "/help") {
    return getHelpText();
  }

  if (cmd === "/f") {
    if (!arg) return "用法：/f <要跟進的內容>\n例如：/f 明天回覆客人規格";
    const result = await createActionTask(arg);
    return result;
  }

  if (cmd === "/list") {
    // /list -> counts
    // /list open -> top 5
    // /list Waiting- internal -> top 5
    if (!arg) {
      return await listCountsByStatus();
    }
    const status = normalizeStatusArg(arg);
    if (!status) {
      return (
        "我看不懂你要列哪個狀態 😅\n" +
        "可用：\n" +
        "/list open\n" +
        `/list ${STATUS_VALUES.WAITING_INTERNAL}\n` +
        `/list ${STATUS_VALUES.WAITING_CUSTOMER}\n` +
        `/list ${STATUS_VALUES.IN_PROGRESS}`
      );
    }
    return await listTopTasksByStatus(status, 5);
  }

  if (cmd === "/find") {
    if (!arg) return "用法：/find <關鍵字>\n例如：/find DENSO";
    return await findTasksByKeyword(arg, 5);
  }

  // Unknown command
  return "我不認得這個指令。輸入 /help 看可用指令。";
}

// ---- Notion: Create Action Task (/f) ----
async function createActionTask(content) {
  ensureEnv();

  try {
    await notion.pages.create({
      parent: { database_id: ACTION_DB_ID },
      properties: {
        [ACTION_PROPS.title]: {
          title: [{ type: "text", text: { content } }],
        },
        [ACTION_PROPS.scope]: {
          select: { name: "Line" },
        },
        [ACTION_PROPS.actionType]: {
          select: { name: "Follow up" },
        },
        [ACTION_PROPS.owner]: {
          multi_select: [{ name: "Stacy" }],
        },
        [ACTION_PROPS.status]: {
          status: { name: STATUS_VALUES.OPEN },
        },
      },
    });

    return `已記錄：${content}\n（我會幫你建立到 Notion Action DB）`;
  } catch (err) {
    console.error("Notion createActionTask error:", err);
    return formatNotionError("建立 Action 失敗", err);
  }
}

// ---- Notion: Create Inbox item (default) ----
async function createInboxItem(content) {
  ensureEnv();

  // title: take first line / first 60 chars
  const title = content.split("\n")[0].slice(0, 60);

  try {
    await notion.pages.create({
      parent: { database_id: INBOX_DB_ID },
      properties: {
        [INBOX_PROPS.title]: {
          title: [{ type: "text", text: { content: title || "Inbox" } }],
        },
        [INBOX_PROPS.raw]: {
          rich_text: [{ type: "text", text: { content } }],
        },
        [INBOX_PROPS.source]: {
          select: { name: "Line" },
        },
      },
    });

    return `已收進 INBOX：${title}`;
  } catch (err) {
    console.error("Notion createInboxItem error:", err);
    return formatNotionError("寫入 INBOX 失敗", err);
  }
}

// ---- /list counts ----
async function listCountsByStatus() {
  ensureEnv();

  const statuses = [
    STATUS_VALUES.OPEN,
    STATUS_VALUES.WAITING_INTERNAL,
    STATUS_VALUES.WAITING_CUSTOMER,
    STATUS_VALUES.IN_PROGRESS,
  ];

  try {
    const counts = {};
    for (const s of statuses) {
      counts[s] = await countByStatus(s);
    }

    // Keep short for LINE
    return [
      "Status 數量：",
      `OPEN: ${counts[STATUS_VALUES.OPEN]}`,
      `Waiting- internal: ${counts[STATUS_VALUES.WAITING_INTERNAL]}`,
      `Waiting- customer: ${counts[STATUS_VALUES.WAITING_CUSTOMER]}`,
      `In progress: ${counts[STATUS_VALUES.IN_PROGRESS]}`,
      "",
      "看清單：",
      "/list open",
      `/list ${STATUS_VALUES.WAITING_INTERNAL}`,
      `/list ${STATUS_VALUES.WAITING_CUSTOMER}`,
      `/list ${STATUS_VALUES.IN_PROGRESS}`,
    ].join("\n");
  } catch (err) {
    console.error("listCountsByStatus error:", err);
    return formatNotionError("查詢失敗", err);
  }
}

async function countByStatus(statusName) {
  let count = 0;
  let cursor = undefined;

  while (true) {
    const resp = await notion.databases.query({
      database_id: ACTION_DB_ID,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        property: ACTION_PROPS.status,
        status: { equals: statusName },
      },
    });

    count += (resp.results || []).length;
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  return count;
}

// ---- /list <status> top 5 ----
async function listTopTasksByStatus(statusName, limit) {
  ensureEnv();

  try {
    const tasks = await queryTasks({
      filter: {
        property: ACTION_PROPS.status,
        status: { equals: statusName },
      },
      page_size: limit,
    });

    if (!tasks.length) return `${statusName}：目前沒有項目`;

    const lines = [`${statusName}（前 ${limit} 項）：`];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const due = t.due ? `（Due: ${t.due}）` : "";
      lines.push(`${i + 1}. ${t.title}${due}`);
    }

    return lines.join("\n");
  } catch (err) {
    console.error("listTopTasksByStatus error:", err);
    return formatNotionError("查詢失敗", err);
  }
}

// ---- /find keyword ----
async function findTasksByKeyword(keyword, limit) {
  ensureEnv();

  const kw = keyword.trim();
  if (!kw) return "用法：/find <關鍵字>";

  try {
    const tasks = await queryTasks({
      filter: {
        property: ACTION_PROPS.title,
        title: { contains: kw },
      },
      page_size: limit,
    });

    if (!tasks.length) return `找不到含「${kw}」的 Task`;

    const lines = [`搜尋「${kw}」（前 ${limit} 項）：`];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const due = t.due ? `（Due: ${t.due}）` : "";
      lines.push(`${i + 1}. ${t.title}${due}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.error("findTasksByKeyword error:", err);
    return formatNotionError("搜尋失敗", err);
  }
}

// ---- Shared Notion query helper (sort by Priority desc, then Due Date asc) ----
async function queryTasks({ filter, page_size }) {
  // Notion "status" filter / "title contains" filter
  const sorts = [];

  // Priority may not always exist or may be different type—try anyway; if Notion rejects, fallback.
  sorts.push({ property: ACTION_PROPS.priority, direction: "descending" });
  sorts.push({ property: ACTION_PROPS.dueDate, direction: "ascending" });

  try {
    const resp = await notion.databases.query({
      database_id: ACTION_DB_ID,
      filter,
      sorts,
      page_size: page_size || 5,
    });

    return (resp.results || []).map(extractTaskSummary).filter(Boolean);
  } catch (err) {
    // Fallback: no sorts (in case Priority sorting causes validation error)
    console.warn("queryTasks sort failed, fallback without sorts:", err?.message || err);
    const resp = await notion.databases.query({
      database_id: ACTION_DB_ID,
      filter,
      page_size: page_size || 5,
    });
    return (resp.results || []).map(extractTaskSummary).filter(Boolean);
  }
}

function extractTaskSummary(page) {
  try {
    const props = page.properties || {};

    const titleProp = props[ACTION_PROPS.title];
    const title =
      titleProp?.type === "title"
        ? (titleProp.title || []).map((t) => t.plain_text).join("").trim()
        : "";

    const dueProp = props[ACTION_PROPS.dueDate];
    const due =
      dueProp?.type === "date" && dueProp.date && dueProp.date.start
        ? dueProp.date.start
        : "";

    if (!title) return null;
    return { title, due };
  } catch {
    return null;
  }
}

// ---- Utilities ----
function normalizeStatusArg(arg) {
  const a = String(arg || "").trim();
  if (!a) return null;

  // exact match (allow user paste full status)
  const direct = [STATUS_VALUES.OPEN, STATUS_VALUES.WAITING_INTERNAL, STATUS_VALUES.WAITING_CUSTOMER, STATUS_VALUES.IN_PROGRESS].find(
    (s) => s.toLowerCase() === a.toLowerCase()
  );
  if (direct) return direct;

  const key = a.toLowerCase();
  if (STATUS_INPUT_MAP.has(key)) return STATUS_INPUT_MAP.get(key);

  // also allow "waiting-internal" typed with extra spaces
  const key2 = key.replace(/\s+/g, " ").trim();
  if (STATUS_INPUT_MAP.has(key2)) return STATUS_INPUT_MAP.get(key2);

  return null;
}

function getHelpText() {
  return [
    "可用指令：",
    "",
    "1) 建立跟進（寫入 Action DB）",
    "   /f <內容>",
    "   例：/f 明天回覆客人規格",
    "",
    "2) 列出狀態數量",
    "   /list",
    "",
    "3) 列出某狀態前五項（含 Due date，如有）",
    "   /list open",
    `   /list ${STATUS_VALUES.WAITING_INTERNAL}`,
    `   /list ${STATUS_VALUES.WAITING_CUSTOMER}`,
    `   /list ${STATUS_VALUES.IN_PROGRESS}`,
    "",
    "4) 關鍵字找 Task（Action DB）",
    "   /find <關鍵字>",
    "   例：/find DENSO",
    "",
    "5) 任何「不含 / 的訊息」會自動寫入 INBOX DB（分享連結/隨手記都可）",
  ].join("\n");
}

function ensureEnv() {
  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!ACTION_DB_ID) missing.push("NOTION_ACTION_DB_ID");
  if (!INBOX_DB_ID) missing.push("NOTION_INBOX_DB_ID");
  if (missing.length) {
    throw new Error("Missing env: " + missing.join(", "));
  }
}

function formatNotionError(prefix, err) {
  const msg = err?.body?.message || err?.message || String(err);
  return `${prefix}：${msg}`;
}

// ---- Start server ----
const PORT = process.env.PORT || 8888;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
