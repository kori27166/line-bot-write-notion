'use strict';

require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const { Client: NotionClient } = require('@notionhq/client');
const crypto = require('crypto');

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

// ========= Notion property names =========
// Action DB
const ACTION_PROP_TASK_TITLE = 'Task';
const ACTION_PROP_STATUS = 'Status';
const ACTION_PROP_PRIORITY = 'Priority Level';
const ACTION_PROP_DUE = 'Due date';

// Inbox DB
const INBOX_PROP_TITLE = 'Item';        // title
const INBOX_PROP_RAW = '原文';          // rich_text
const INBOX_PROP_URL = 'URL';           // url
const INBOX_PROP_SOURCE = 'Source';     // select
const INBOX_PROP_FILES = 'Attachment';  // files (optional)

// ========= Clients =========
const lineConfig = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);
const notion = new NotionClient({ auth: NOTION_TOKEN });

// ========= Optional: Cloudinary =========
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'line-notion-bot';

const CLOUDINARY_ENABLED =
  !!CLOUDINARY_CLOUD_NAME && !!CLOUDINARY_API_KEY && !!CLOUDINARY_API_SECRET;

// ========= DB schema cache =========
let inboxDbProps = null;

async function loadInboxDbSchema() {
  const db = await notion.databases.retrieve({ database_id: NOTION_INBOX_DB_ID });
  inboxDbProps = db?.properties || {};
  console.log('[INBOX DB] props:', Object.keys(inboxDbProps));
}

function pickExistingInboxProps(props) {
  if (!inboxDbProps) return props;
  const filtered = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (inboxDbProps[k]) filtered[k] = v;
  }
  return filtered;
}

// ========= Simple per-user mode state (in-memory) =========
const userMode = new Map(); // key: userId, value: {mode:'FOLLOWUP'|'SEARCH', ts:number}

function setMode(userId, mode) {
  if (!userId) return;
  if (!mode) userMode.delete(userId);
  else userMode.set(userId, { mode, ts: Date.now() });
}

function getMode(userId) {
  const v = userMode.get(userId);
  if (!v) return null;
  if (Date.now() - v.ts > 5 * 60 * 1000) {
    userMode.delete(userId);
    return null;
  }
  return v.mode;
}

// ========= Helpers =========
function safePreview(text, maxLen = 60) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + '…';
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m) return null;
  return m[0].replace(/[)\].,!?;:]+$/g, '');
}

async function fetchTitle(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; LineNotionBot/1.0; +https://onrender.com)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) return null;

    const html = await resp.text();
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
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function formatDueDate(prop) {
  const d = prop?.date;
  if (!d?.start) return '';
  return d.start.slice(0, 10);
}

function getTaskTitle(page) {
  const t = page?.properties?.[ACTION_PROP_TASK_TITLE]?.title;
  if (!Array.isArray(t) || t.length === 0) return '';
  return (t[0]?.plain_text || '').trim();
}

function getPriorityRank(page) {
  const p = page?.properties?.[ACTION_PROP_PRIORITY];
  const name = p?.select?.name || '';
  const map = { High: 3, Medium: 2, Low: 1, P0: 4, P1: 3, P2: 2, P3: 1 };
  return map[name] || 0;
}

function normalizeStatusArg(raw) {
  return (raw || '').trim();
}

// ========= Postback helpers =========
function pb(dataObj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(dataObj)) params.set(k, String(v));
  return params.toString();
}

function parsePostbackData(data) {
  const params = new URLSearchParams(data || '');
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

// ========= Quick Reply (postback actions, no “send message”) =========
function getQuickReply() {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '📋 Menu', data: pb({ nav: 'main' }) } },
      { type: 'action', action: { type: 'postback', label: '➕ Follow up', data: pb({ act: 'followup_start' }) } },
      { type: 'action', action: { type: 'postback', label: '🔍 Search', data: pb({ act: 'search_start' }) } },
      { type: 'action', action: { type: 'postback', label: '📊 List', data: pb({ act: 'list_count' }) } },
      { type: 'action', action: { type: 'postback', label: '📂 Status', data: pb({ nav: 'status_menu' }) } },
      { type: 'action', action: { type: 'postback', label: '❌ Cancel', data: pb({ act: 'cancel_mode' }) } },
      { type: 'action', action: { type: 'postback', label: 'ℹ️ Help', data: pb({ act: 'help' }) } },
    ],
  };
}

// ========= Reply helpers =========
async function replyText(replyToken, text) {
  if (!replyToken) return;
  return lineClient.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply: getQuickReply(),
  });
}

async function replyFlex(replyToken, altText, contents) {
  if (!replyToken) return;
  return lineClient.replyMessage(replyToken, {
    type: 'flex',
    altText: altText || 'Menu',
    contents,
    quickReply: getQuickReply(),
  });
}

// ========= Flex Menus =========
function flexMainMenu() {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'LINE → Notion', weight: 'bold', size: 'xl' },
        { type: 'text', text: '選擇要操作的資料庫', size: 'sm', color: '#666666', wrap: true },
        { type: 'separator', margin: 'md' },

        { type: 'button', style: 'primary', action: { type: 'postback', label: 'Action DB', data: pb({ nav: 'action' }) } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: 'Inbox DB', data: pb({ nav: 'inbox' }) } },

        { type: 'separator', margin: 'md' },
        { type: 'button', style: 'link', action: { type: 'postback', label: 'Help', data: pb({ act: 'help' }) } },
      ],
    },
  };
}

function flexActionMenu() {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'Action DB', weight: 'bold', size: 'xl' },
        { type: 'text', text: '選擇動作', size: 'sm', color: '#666666' },
        { type: 'separator', margin: 'md' },

        { type: 'button', style: 'primary', action: { type: 'postback', label: 'List Count', data: pb({ act: 'list_count' }) } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: 'List Top 5 (by status)', data: pb({ nav: 'status_menu' }) } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: 'Follow up (新增)', data: pb({ act: 'followup_start' }) } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: 'Search Action (搜尋)', data: pb({ act: 'search_start' }) } },

        { type: 'separator', margin: 'md' },
        { type: 'button', style: 'link', action: { type: 'postback', label: 'Back', data: pb({ nav: 'main' }) } },
      ],
    },
  };
}

function flexStatusMenu() {
  const statuses = [
    { label: 'Open', value: 'open' },
    { label: 'Waiting- internal', value: 'Waiting- internal' },
    { label: 'Waiting- customer', value: 'Waiting- customer' },
    { label: 'In progress', value: 'In progress' },
  ];

  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'List Top 5', weight: 'bold', size: 'xl' },
        { type: 'text', text: '選擇 Status', size: 'sm', color: '#666666' },
        { type: 'separator', margin: 'md' },
        ...statuses.map((s) => ({
          type: 'button',
          style: 'secondary',
          action: { type: 'postback', label: s.label, data: pb({ act: 'list_status', status: s.value }) },
        })),
        { type: 'separator', margin: 'md' },
        { type: 'button', style: 'link', action: { type: 'postback', label: 'Back', data: pb({ nav: 'action' }) } },
      ],
    },
  };
}

function flexInboxMenu() {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'Inbox DB', weight: 'bold', size: 'xl' },
        { type: 'text', text: '直接打字/分享連結/傳圖會自動寫入', size: 'sm', color: '#666666', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: '說明', data: pb({ act: 'inbox_help' }) } },
        { type: 'separator', margin: 'md' },
        { type: 'button', style: 'link', action: { type: 'postback', label: 'Back', data: pb({ nav: 'main' }) } },
      ],
    },
  };
}

// ========= Cloudinary upload =========
function cloudinarySign(paramsToSign, apiSecret) {
  const keys = Object.keys(paramsToSign).sort();
  const toSign = keys
    .filter((k) => paramsToSign[k] !== undefined && paramsToSign[k] !== null && paramsToSign[k] !== '')
    .map((k) => `${k}=${paramsToSign[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

async function uploadToCloudinary(buffer, filenameBase = 'line-image') {
  if (!CLOUDINARY_ENABLED) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${CLOUDINARY_FOLDER}/${filenameBase}-${Date.now()}`;
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

  const params = { folder: CLOUDINARY_FOLDER, public_id: publicId, timestamp };
  const signature = cloudinarySign(params, CLOUDINARY_API_SECRET);

  const form = new FormData();
  form.append('file', new Blob([buffer]), `${filenameBase}.jpg`);
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('folder', CLOUDINARY_FOLDER);
  form.append('public_id', publicId);
  form.append('signature', signature);

  const resp = await fetch(endpoint, { method: 'POST', body: form });
  if (!resp.ok) return null;

  const json = await resp.json();
  return json?.secure_url || json?.url || null;
}

// ========= Notion Actions =========
async function createActionFollowUp(taskText) {
  return notion.pages.create({
    parent: { database_id: NOTION_ACTION_DB_ID },
    properties: {
      [ACTION_PROP_TASK_TITLE]: { title: [{ text: { content: taskText } }] },
      Scope: { select: { name: 'Line' } },
      'Action Type': { select: { name: 'Follow up' } },
      Owner: { multi_select: [{ name: 'Stacy' }] },
      [ACTION_PROP_STATUS]: { status: { name: 'OPEN' } },
    },
  });
}

async function getTopTasksByStatus(statusName, limit = 5) {
  const resp = await notion.databases.query({
    database_id: NOTION_ACTION_DB_ID,
    page_size: 30,
    filter: { property: ACTION_PROP_STATUS, status: { equals: statusName } },
  });

  const pages = resp?.results || [];
  pages.sort((a, b) => {
    const pr = getPriorityRank(b) - getPriorityRank(a);
    if (pr !== 0) return pr;
    const da = a?.properties?.[ACTION_PROP_DUE]?.date?.start || '';
    const db = b?.properties?.[ACTION_PROP_DUE]?.date?.start || '';
    return da.localeCompare(db);
  });

  return pages.slice(0, limit);
}

async function countByStatus(statusNames) {
  const counts = {};
  for (const statusName of statusNames) {
    let total = 0;
    let cursor = undefined;

    while (true) {
      const resp = await notion.databases.query({
        database_id: NOTION_ACTION_DB_ID,
        page_size: 100,
        start_cursor: cursor,
        filter: { property: ACTION_PROP_STATUS, status: { equals: statusName } },
      });

      total += (resp?.results || []).length;
      if (!resp?.has_more) break;
      cursor = resp?.next_cursor;
      if (!cursor) break;
    }

    counts[statusName] = total;
  }
  return counts;
}

async function searchActionTasks(keyword, limit = 5) {
  const resp = await notion.databases.query({
    database_id: NOTION_ACTION_DB_ID,
    page_size: 20,
    filter: { property: ACTION_PROP_TASK_TITLE, title: { contains: keyword } },
  });

  const pages = resp?.results || [];
  pages.sort((a, b) => getPriorityRank(b) - getPriorityRank(a));
  return pages.slice(0, limit);
}

// ========= Notion Inbox =========
function buildInboxPropsBase({ itemTitle, rawText, url, files }) {
  const props = {
    [INBOX_PROP_TITLE]: { title: [{ text: { content: itemTitle } }] },
    [INBOX_PROP_RAW]: rawText ? { rich_text: [{ text: { content: rawText } }] } : { rich_text: [] },
    [INBOX_PROP_SOURCE]: { select: { name: 'Line' } },
  };

  if (url) props[INBOX_PROP_URL] = { url };

  if (Array.isArray(files) && files.length > 0) {
    props[INBOX_PROP_FILES] = {
      files: files.map((f) => ({
        name: f.name || 'attachment',
        type: 'external',
        external: { url: f.url },
      })),
    };
  }

  return props;
}

async function createInboxTextItem(text) {
  const url = extractFirstUrl(text);
  let title = null;
  if (url) title = await fetchTitle(url);

  const itemTitle = title || safePreview(text, 60);
  const properties = pickExistingInboxProps(buildInboxPropsBase({ itemTitle, rawText: text, url, files: [] }));

  return notion.pages.create({
    parent: { database_id: NOTION_INBOX_DB_ID },
    properties,
  });
}

async function createInboxImageItem({ imageUrl, rawNote }) {
  const properties = pickExistingInboxProps(
    buildInboxPropsBase({
      itemTitle: 'Image',
      rawText: rawNote,
      url: null,
      files: imageUrl ? [{ name: 'image', url: imageUrl }] : [],
    })
  );

  return notion.pages.create({
    parent: { database_id: NOTION_INBOX_DB_ID },
    properties,
  });
}

async function fetchLineMessageContentBuffer(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ========= Help text =========
function buildHelpText() {
  return [
    'Flex 操作：用下方按鈕（Menu / Follow up / Search / List）',
    '',
    'Commands（備援）：',
    '/menu       → 打開 Flex 主選單',
    '/followup   → 進入 Follow up 輸入模式',
    '/search     → 進入 Search 輸入模式',
    '/f <內容>   → 直接新增 Follow up',
    '? <關鍵字>  → 直接搜尋 Action DB',
    '/list       → status count',
    '/list <status> → top 5',
  ].join('\n');
}

async function handleListCommand(replyToken, fullText) {
  const args = fullText.split(' ').filter(Boolean);

  if (args.length === 1) {
    const statuses = ['open', 'Waiting- internal', 'Waiting- customer', 'In progress'];
    try {
      const counts = await countByStatus(statuses);
      const lines = statuses.map((s) => `${s}: ${counts[s] ?? 0}`);
      return replyText(replyToken, ['Status count:', ...lines].join('\n'));
    } catch (e) {
      console.error('List count error:', e);
      return replyText(replyToken, '讀取 /list 統計失敗（請看 logs）。');
    }
  }

  const status = normalizeStatusArg(fullText.replace(/^\/list\s*/i, ''));

  try {
    const pages = await getTopTasksByStatus(status, 5);
    if (!pages.length) return replyText(replyToken, `「${status}」沒有資料。`);

    const lines = pages.map((p, idx) => {
      const title = getTaskTitle(p) || '(無標題)';
      const due = formatDueDate(p?.properties?.[ACTION_PROP_DUE]);
      return due ? `${idx + 1}. ${title} (${due})` : `${idx + 1}. ${title}`;
    });

    return replyText(replyToken, [`${status} top 5:`, ...lines].join('\n'));
  } catch (e) {
    console.error('List status error:', e);
    return replyText(replyToken, '讀取 /list 失敗（請看 logs）。');
  }
}

// ========= Postback handler =========
async function handlePostback(event) {
  const replyToken = event.replyToken;
  const userId = event?.source?.userId || '';
  const data = parsePostbackData(event.postback?.data || '');

  console.log('[POSTBACK]', data);

  // navigation
  if (data.nav === 'main') return replyFlex(replyToken, 'Main menu', flexMainMenu());
  if (data.nav === 'action') return replyFlex(replyToken, 'Action menu', flexActionMenu());
  if (data.nav === 'status_menu') return replyFlex(replyToken, 'Status menu', flexStatusMenu());
  if (data.nav === 'inbox') return replyFlex(replyToken, 'Inbox menu', flexInboxMenu());

  // actions
  if (data.act === 'help') return replyText(replyToken, buildHelpText());

  if (data.act === 'cancel_mode') {
    setMode(userId, null);
    return replyText(replyToken, '已取消輸入模式。');
  }

  if (data.act === 'inbox_help') {
    return replyText(replyToken, ['Inbox DB：', '- 直接打字/分享連結 → 自動寫入', '- 傳圖片 → 自動寫入（Attachment 需 Cloudinary）'].join('\n'));
  }

  if (data.act === 'list_count') {
    const statuses = ['open', 'Waiting- internal', 'Waiting- customer', 'In progress'];
    try {
      const counts = await countByStatus(statuses);
      const lines = statuses.map((s) => `${s}: ${counts[s] ?? 0}`);
      return replyText(replyToken, ['Status count:', ...lines].join('\n'));
    } catch (e) {
      console.error('List count error:', e);
      return replyText(replyToken, '讀取統計失敗（請看 logs）。');
    }
  }

  if (data.act === 'list_status') {
    const status = normalizeStatusArg(data.status || '');
    if (!status) return replyText(replyToken, '缺少 status 參數。');
    try {
      const pages = await getTopTasksByStatus(status, 5);
      if (!pages.length) return replyText(replyToken, `「${status}」沒有資料。`);

      const lines = pages.map((p, idx) => {
        const title = getTaskTitle(p) || '(無標題)';
        const due = formatDueDate(p?.properties?.[ACTION_PROP_DUE]);
        return due ? `${idx + 1}. ${title} (${due})` : `${idx + 1}. ${title}`;
      });

      return replyText(replyToken, [`${status} top 5:`, ...lines].join('\n'));
    } catch (e) {
      console.error('List status error:', e);
      return replyText(replyToken, '讀取清單失敗（請看 logs）。');
    }
  }

  if (data.act === 'followup_start') {
    setMode(userId, 'FOLLOWUP');
    return replyText(replyToken, '請輸入要 Follow up 的內容（下一則訊息會建立到 Action DB）。');
  }

  if (data.act === 'search_start') {
    setMode(userId, 'SEARCH');
    return replyText(replyToken, '請輸入要搜尋的關鍵字（下一則訊息會搜尋 Action DB）。');
  }

  return replyText(replyToken, '未識別的操作（請按 Menu 重新開啟）。');
}

// ========= Message handlers =========
async function handleTextMessage(event) {
  const replyToken = event.replyToken;
  const text = (event.message?.text || '').trim();
  const userId = event?.source?.userId || '';

  if (!text) return replyText(replyToken, '收到空白訊息，未寫入。');

  // Flex menu entry
  if (text === '/menu') return replyFlex(replyToken, 'Main menu', flexMainMenu());

  // keep old habits
  if (text === '/followup') {
    setMode(userId, 'FOLLOWUP');
    return replyText(replyToken, '請輸入要 Follow up 的內容（下一則訊息會建立到 Action DB）。');
  }
  if (text === '/search') {
    setMode(userId, 'SEARCH');
    return replyText(replyToken, '請輸入要搜尋的關鍵字（下一則訊息會搜尋 Action DB）。');
  }

  if (text === '/help' || text === '/h') return replyText(replyToken, buildHelpText());

  // consume mode
  const mode = getMode(userId);
  const maybeUrl = extractFirstUrl(text);

  if (mode && maybeUrl) {
    setMode(userId, null);
    try {
      await createInboxTextItem(text);
      return replyText(replyToken, `已收進 INBOX（自動退出模式）：${safePreview(text, 60)}`);
    } catch (e) {
      console.error('Notion write error (INBOX text in mode):', e);
      return replyText(replyToken, '寫入 INBOX 失敗（請看 logs）。');
    }
  }

  if (mode === 'FOLLOWUP') {
    setMode(userId, null);
    try {
      await createActionFollowUp(text);
      return replyText(replyToken, `已記錄到 Action DB：${safePreview(text, 80)}`);
    } catch (e) {
      console.error('Notion write error (Action DB):', e);
      return replyText(replyToken, '寫入 Action DB 失敗（請看 logs）。');
    }
  }

  if (mode === 'SEARCH') {
    setMode(userId, null);
    const keyword = text.trim();
    if (!keyword) return replyText(replyToken, '請輸入關鍵字。');

    try {
      const pages = await searchActionTasks(keyword, 5);
      if (!pages.length) return replyText(replyToken, `找不到「${keyword}」相關 Task。`);

      const lines = pages.map((p, idx) => {
        const title = getTaskTitle(p) || '(無標題)';
        const due = formatDueDate(p?.properties?.[ACTION_PROP_DUE]);
        return due ? `${idx + 1}. ${title} (${due})` : `${idx + 1}. ${title}`;
      });

      return replyText(replyToken, [`搜尋「${keyword}」前 5 筆：`, ...lines].join('\n'));
    } catch (e) {
      console.error('Action search error:', e);
      return replyText(replyToken, '搜尋 Action DB 失敗（請看 logs）。');
    }
  }

  // legacy: /f
  if (text.startsWith('/f ')) {
    const taskText = text.replace(/^\/f\s*/i, '').trim();
    if (!taskText) return replyText(replyToken, '用法：/f <要追蹤的事項>');

    try {
      await createActionFollowUp(taskText);
      return replyText(replyToken, `已記錄到 Action DB：${safePreview(taskText, 80)}`);
    } catch (e) {
      console.error('Notion write error (Action DB):', e);
      return replyText(replyToken, '寫入 Action DB 失敗（請看 logs）。');
    }
  }

  // legacy: ?keyword
  if (text.startsWith('?')) {
    const keyword = text.replace(/^\?\s*/i, '').trim();
    if (!keyword) return replyText(replyToken, '用法：? <關鍵字>');

    try {
      const pages = await searchActionTasks(keyword, 5);
      if (!pages.length) return replyText(replyToken, `找不到「${keyword}」相關 Task。`);

      const lines = pages.map((p, idx) => {
        const title = getTaskTitle(p) || '(無標題)';
        const due = formatDueDate(p?.properties?.[ACTION_PROP_DUE]);
        return due ? `${idx + 1}. ${title} (${due})` : `${idx + 1}. ${title}`;
      });

      return replyText(replyToken, [`搜尋「${keyword}」前 5 筆：`, ...lines].join('\n'));
    } catch (e) {
      console.error('Action search error:', e);
      return replyText(replyToken, '搜尋 Action DB 失敗（請看 logs）。');
    }
  }

  // legacy: /list
  if (text === '/list' || text.startsWith('/list ')) {
    return handleListCommand(replyToken, text);
  }

  // default → INBOX
  try {
    await createInboxTextItem(text);
    return replyText(replyToken, `已收進 INBOX：${safePreview(text, 60)}`);
  } catch (e) {
    console.error('Notion write error (INBOX text):', e);
    return replyText(replyToken, '寫入 INBOX 失敗（請看 logs）。');
  }
}

async function handleImageMessage(event) {
  const replyToken = event.replyToken;
  const messageId = event.message?.id;

  if (!messageId) return replyText(replyToken, '圖片處理失敗：缺少 message id。');

  try {
    const buf = await fetchLineMessageContentBuffer(messageId);

    let publicUrl = null;
    if (CLOUDINARY_ENABLED) publicUrl = await uploadToCloudinary(buf, `line-${messageId}`);

    const rawNote = [
      '[Image]',
      `messageId=${messageId}`,
      publicUrl ? `uploaded=${publicUrl}` : 'uploaded=SKIPPED (no Cloudinary env)',
    ].join('\n');

    await createInboxImageItem({ imageUrl: publicUrl, rawNote });

    if (publicUrl) return replyText(replyToken, '已收進 INBOX（含 Attachment 圖片檔）。');
    return replyText(replyToken, '已收進 INBOX（Attachment 需要 Cloudinary 才能寫入公開檔案 URL）。');
  } catch (e) {
    console.error('Notion/LINE image handling error:', e);
    return replyText(replyToken, '圖片寫入 INBOX 失敗（請看 logs）。');
  }
}

async function handleNonTextMessage(event) {
  const replyToken = event.replyToken;
  const type = event.message?.type || 'unknown';
  const messageId = event.message?.id || '';
  const rawText = `[${type}]\nmessageId=${messageId}`;

  try {
    const properties = pickExistingInboxProps(
      buildInboxPropsBase({ itemTitle: `${type}`, rawText, url: null, files: [] })
    );

    await notion.pages.create({
      parent: { database_id: NOTION_INBOX_DB_ID },
      properties,
    });

    return replyText(replyToken, `已收進 INBOX：${type}`);
  } catch (e) {
    console.error('Notion write error (INBOX non-text):', e);
    return replyText(replyToken, '寫入 INBOX 失敗（請看 logs）。');
  }
}

async function handleEvent(event) {
  try {
    console.log('[EVENT]', {
      type: event.type,
      msgType: event.message?.type,
      hasPostback: !!event.postback,
      textLen: (event.message?.text || '').length,
      textPreview: (event.message?.text || '').slice(0, 120),
    });

    if (event.type === 'postback') return handlePostback(event);

    if (event.type !== 'message') return null;

    const msgType = event.message?.type;
    if (msgType === 'text') return handleTextMessage(event);
    if (msgType === 'image') return handleImageMessage(event);

    return handleNonTextMessage(event);
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
  res.sendStatus(200);

  console.log('[WEBHOOK HIT] at', new Date().toISOString());
  console.log(
    '[WEBHOOK HEADERS]',
    req.headers['user-agent'],
    req.headers['x-line-signature'] ? 'has-signature' : 'no-signature'
  );

  const events = req.body?.events || [];
  console.log('LINE events:', events.map((e) => `${e.type}:${e.message?.type || ''}`));

  Promise.allSettled(events.map(handleEvent)).catch((e) => {
    console.error('Promise.allSettled error:', e);
  });
});

// ========= Start =========
async function boot() {
  await loadInboxDbSchema();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`CLOUDINARY_ENABLED=${CLOUDINARY_ENABLED}`);
  });
}

boot().catch((e) => {
  console.error('Startup error:', e);
  process.exit(1);
});
