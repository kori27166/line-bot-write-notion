'use strict';

require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const { Client: NotionClient } = require('@notionhq/client');

const app = express();

// ========= ENV =========
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_ACTION_DB_ID = process.env.NOTION_ACTION_DB_ID;
const NOTION_INBOX_DB_ID = process.env.NOTION_INBOX_DB_ID;

const PORT = process.env.PORT || 8888;

if (!CHANNEL_ACCESS_TOKEN) throw new Error('no channel access token');
if (!CHANNEL_SECRET) throw new Error('no channel secret');
if (!NOTION_TOKEN) throw new Error('no notion token');
if (!NOTION_ACTION_DB_ID) throw new Error('no notion action db id');
if (!NOTION_INBOX_DB_ID) throw new Error('no notion inbox db id');

// ========= Clients =========
const lineConfig = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);
const notion = new NotionClient({ auth: NOTION_TOKEN });

// ========= Helpers =========
function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m) return null;
  // 去掉結尾常見標點
  return m[0].replace(/[)\].,!?;:]+$/g, '');
}

async function fetchTitle(url) {
  // Node 22 有 global fetch
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; LineNotionBot/1.0; +https://onrender.com)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) return null;

    const html = await resp.text();
    // 粗抓 <title>，避免引入 parser
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;

    const title = m[1]
      .replace(/\s+/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    return title || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function safePreview(text, maxLen = 60) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + '…';
}

function formatDueDate(prop) {
  // prop: Notion property object for date
  const d = prop?.date;
  if (!d?.start) return '';
  // start could be "YYYY-MM-DD" or ISO datetime
  return d.start.slice(0, 10);
}

function getPriorityRank(page) {
  // 你的 Action DB 欄位看起來叫 "Priority"（截圖顯示 Priority...）
  // 若你實際欄位名不同，改成你的欄位名即可。
  const p = page?.properties?.Priority;
  const name = p?.select?.name || '';
  const map = {
    High: 3,
    Medium: 2,
    Low: 1,
  };
  return map[name] || 0;
}

function getTaskTitle(page) {
  // 你的 Action DB title 欄位叫 Task（你已確認）
  const t = page?.properties?.Task?.title;
  if (!Array.isArray(t) || t.length === 0) return '';
  return (t[0]?.plain_text || '').trim();
}

// ========= Notion Actions =========
async function createActionFollowUp(taskText) {
  // 依你給的欄位設定：
  // Title 欄位：Task
  // Scope select：Line
  // Action Type select：Follow up
  // Owner multi-select：Stacy
  // Status（注意大小寫）欄位：Status（Notion 顯示是 Status）選項：OPEN
  return notion.pages.create({
    parent: { database_id: NOTION_ACTION_DB_ID },
    properties: {
      Task: {
        title: [{ text: { content: taskText } }],
      },
      Scope: {
        select: { name: 'Line' },
      },
      'Action Type': {
        select: { name: 'Follow up' },
      },
      Owner: {
        multi_select: [{ name: 'Stacy' }],
      },
      Status: {
        status: { name: 'OPEN' },
      },
    },
  });
}

async function searchActionTasks(keyword, limit = 5) {
  // 先抓較多筆再在程式端做 priority sort（Notion select sort 不一定符合 High/Medium/Low）
  const queryLimit = 20;

  const resp = await notion.databases.query({
    database_id: NOTION_ACTION_DB_ID,
    page_size: queryLimit,
    filter: {
      property: 'Task',
      title: {
        contains: keyword,
      },
    },
  });

  const pages = resp?.results || [];
  pages.sort((a, b) => getPriorityRank(b) - getPriorityRank(a));

  return pages.slice(0, limit);
}

// ========= Notion Inbox =========
async function createInboxItem(text) {
  const url = extractFirstUrl(text);
  let title = null;

  if (url) {
    title = await fetchTitle(url);
  }

  const itemTitle = title || safePreview(text, 60);

  // 依你 INBOX DB 欄位：
  // Item (title), 原文 (rich_text), URL (url), Source (select: Line)
  return notion.pages.create({
    parent: { database_id: NOTION_INBOX_DB_ID },
    properties: {
      Item: {
        title: [{ text: { content: itemTitle } }],
      },
      原文: {
        rich_text: [{ text: { content: text } }],
      },
      URL: url ? { url } : undefined,
      Source: {
        select: { name: 'Line' },
      },
    },
  });
}

// ========= LINE Handlers =========
async function replyText(replyToken, text) {
  if (!replyToken) return;
  return lineClient.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

async function handleTextMessage(event) {
  const replyToken = event.replyToken;
  const text = (event.message?.text || '').trim();

  if (!text) {
    return replyText(replyToken, '收到空白訊息，未寫入。');
  }

  // /help
  if (text === '/help' || text === '/h') {
    const msg =
      [
        '可用指令：',
        '/f <內容>  → 新增 Follow up 到 Action DB（Status=OPEN）',
        '? <關鍵字> → 搜尋 Action DB（Task contains），回傳前 5 筆（含 Due date）',
        '',
        '不打指令：',
        '- 直接寫入 INBOX DB',
        '- 若含 URL：自動抓標題→Item、原文→原文、網址→URL',
      ].join('\n');
    return replyText(replyToken, msg);
  }

  // /f
  if (text === '/f' || text.startsWith('/f ')) {
    const taskText = text.replace(/^\/f\s*/i, '').trim();
    if (!taskText) {
      return replyText(replyToken, '用法：/f <要追蹤的事項>');
    }

    try {
      await createActionFollowUp(taskText);
      return replyText(replyToken, `已記錄：${taskText}\n（我會幫你建立到 Notion Action DB）`);
    } catch (e) {
      console.error('Notion write error (Action DB):', e);
      return replyText(replyToken, '寫入 Action DB 失敗（請看 Render logs）。');
    }
  }

  // ? keyword  搜尋 Action DB
  if (text.startsWith('?')) {
    const keyword = text.replace(/^\?\s*/i, '').trim();
    if (!keyword) {
      return replyText(replyToken, '用法：? <關鍵字>');
    }

    try {
      const pages = await searchActionTasks(keyword, 5);
      if (!pages.length) {
        return replyText(replyToken, `找不到符合「${keyword}」的 Task。`);
      }

      // Due Date 欄位看起來叫 Due Date（你截圖有 Due Date）
      const lines = pages.map((p, idx) => {
        const title = getTaskTitle(p) || '(無標題)';
        const due = formatDueDate(p?.properties?.['Due Date']);
        return due ? `${idx + 1}. ${title} (${due})` : `${idx + 1}. ${title}`;
      });

      const msg = [`搜尋「${keyword}」前 5 筆：`, ...lines].join('\n');
      return replyText(replyToken, msg);
    } catch (e) {
      console.error('Notion search error (Action DB):', e);
      return replyText(replyToken, '搜尋失敗（請看 Render logs）。');
    }
  }

  // default → INBOX
  try {
    await createInboxItem(text);
    return replyText(replyToken, `已收進 INBOX：${safePreview(text, 60)}`);
  } catch (e) {
    console.error('Notion write error (INBOX DB):', e);
    return replyText(replyToken, '寫入 INBOX 失敗（請看 Render logs）。');
  }
}

async function handleEvent(event) {
  try {
    if (event.type === 'message' && event.message.type === 'text') {
      return handleTextMessage(event);
    }
    // 其他事件先忽略
    return null;
  } catch (e) {
    console.error('handleEvent error:', e);
    return null;
  }
}

// ========= Routes =========
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  // 先回 200，避免 LINE timeout
  res.sendStatus(200);

  const events = req.body?.events || [];
  console.log('LINE events:', events.map(e => e.type));

  Promise.allSettled(events.map(handleEvent)).catch((e) => {
    console.error('Promise.allSettled error:', e);
  });
});

// ========= Start =========
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Server running at http://localhost:${PORT}/`);
});
