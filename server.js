require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const sqlite3 = require('sqlite3').verbose();
const app = express();

const PORT = process.env.PORT || 3000;

// --- 1. 动态账号配置 ---
const USERS = {};
let userCount = 0;
for (const key in process.env) {
    if (key.startsWith('ACC_')) {
        USERS[key.slice(4)] = process.env[key];
        userCount++;
    }
}
const ADMIN_USER = process.env.ADMIN_USER || "libala";

// --- 2. 数据存储 ---
const DATA_DIR = '/app/data'; 
const DB_FILE = path.join(DATA_DIR, 'chat.db'); 
const OLD_DB_FILE = path.join(DATA_DIR, 'database.json');

const DEFAULT_PRESETS = [
    { id: 'gemini', name: 'Gemini', desc: '3 Pro (Preview)', url: "https://whu.zeabur.app", key: "pwd", modelId: "gemini-3-pro-preview", icon: "💎" },
    { id: 'gpt', name: 'GPT', desc: '4.1 Mini', url: "https://x666.me", key: "sk-Pgj1iaG2ZvdKOxxrVHrvTio6vtKUGVOZbUgdUdqvFxp9RQow", modelId: "gpt-4.1-mini", icon: "🤖" }
];

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '.')));

// --- 辅助函数：获取标准北京时间字符串 ---
function getBeijingTime() {
    const now = new Date();
    // 计算 UTC+8 偏移
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const bjMs = utc + (3600000 * 8);
    const date = new Date(bjMs);
    
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
    
    return {
        full: `${yyyy}-${mm}-${dd} ${hh}:${min}`, // 2025-11-29 21:42
        desc: `${yyyy}年${mm}月${dd}日 ${hh}:${min} 星期${weekday}` // 用于喂给 AI
    };
}

// --- SQLite ---
let db;
function initDB() {
    return new Promise(async (resolve, reject) => {
        try { if (!fs.existsSync(DATA_DIR)) await fsPromises.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
        db = new sqlite3.Database(DB_FILE, async (err) => {
            if (err) return reject(err);
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT, desc TEXT, url TEXT, key TEXT, modelId TEXT, icon TEXT)`);
                db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT, title TEXT, mode TEXT, created_at INTEGER, updated_at INTEGER)`);
                db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE)`);
                db.run(`CREATE TABLE IF NOT EXISTS usage (user TEXT, model_id TEXT, count INTEGER, PRIMARY KEY (user, model_id))`);
                db.run(`CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, timestamp INTEGER)`);
                
                db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
            });
            await checkAndMigrateData(false);
            checkDefaultPresets();
            resolve();
        });
    });
}

function dbRun(sql, params = []) { return new Promise((resolve, reject) => { db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); }); }); }
function dbGet(sql, params = []) { return new Promise((resolve, reject) => { db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); }); }); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => { db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); }); }); }

// --- 辅助逻辑 ---
async function checkAndMigrateData(force = false) {
    try {
        if (!fs.existsSync(OLD_DB_FILE)) return { success: false, message: "未找到旧文件" };
        if (!force) {
            const c = await dbGet("SELECT count(*) as count FROM sessions");
            if (c.count > 0) return { success: true, message: "数据库非空，跳过" };
        }
        const oldData = JSON.parse(await fsPromises.readFile(OLD_DB_FILE, 'utf8'));
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            if (oldData.presets) {
                const stmt = db.prepare("INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)");
                oldData.presets.forEach(p => stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon || '⚡'));
                stmt.finalize();
            }
            if (oldData.chats) {
                const sStmt = db.prepare("INSERT OR IGNORE INTO sessions (id, user, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
                const mStmt = db.prepare("INSERT OR IGNORE INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
                let offset = 0;
                for (const [user, sessions] of Object.entries(oldData.chats)) {
                    sessions.forEach((s, idx) => {
                        const sId = s.id || `sess_${Date.now()}_${idx}`;
                        const now = Date.now() - (offset++ * 1000);
                        sStmt.run(sId, user, s.title, s.mode, now, now);
                        if (s.messages) s.messages.forEach(m => mStmt.run(sId, m.role, typeof m.content==='string'?m.content:JSON.stringify(m.content), now));
                    });
                }
                sStmt.finalize(); mStmt.finalize();
            }
            db.run("COMMIT");
        });
        return { success: true, message: "迁移成功" };
    } catch (e) { if (db) db.run("ROLLBACK"); return { success: false, message: e.message }; }
}

async function checkDefaultPresets() {
    const c = await dbGet("SELECT count(*) as c FROM presets");
    if (c.c === 0) {
        const stmt = db.prepare("INSERT INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)");
        DEFAULT_PRESETS.forEach(p => stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon));
        stmt.finalize();
    }
}

// --- Google Search ---
async function searchGoogle(query) {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return null;
    try {
        const response = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn' })
        });
        const json = await response.json();
        if (json.organic) {
            return json.organic.map((item, index) => `[${index + 1}] 标题: ${item.title}\n链接: ${item.link}\n摘要: ${item.snippet}`).join('\n\n');
        }
        return null;
    } catch (e) { return null; }
}

// --- API ---
const tokenMap = new Map();
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (USERS[username] && USERS[username] === password) {
        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        tokenMap.set(token, username);
        res.json({ success: true, token, isAdmin: username === ADMIN_USER });
    } else res.status(401).json({ success: false });
});

app.get('/api/config', async (req, res) => {
    const presets = await dbAll("SELECT id, name, desc, icon FROM presets");
    res.json({ success: true, presets });
});

app.get('/api/sessions', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const sessions = await dbAll("SELECT id, title, mode, updated_at FROM sessions WHERE user = ? ORDER BY updated_at DESC", [user]);
    res.json({ success: true, data: sessions });
});

app.get('/api/session/:id', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const s = await dbGet("SELECT * FROM sessions WHERE id = ? AND user = ?", [req.params.id, user]);
    if (!s) return res.status(404).json({ success: false });
    const msgs = await dbAll("SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC", [req.params.id]);
    const parsed = msgs.map(m => {
        try { return { role: m.role, content: JSON.parse(m.content), timestamp: m.timestamp }; }
        catch { return { role: m.role, content: m.content, timestamp: m.timestamp }; }
    });
    res.json({ success: true, session: s, messages: parsed });
});

app.post('/api/session/new', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { presetId, title } = req.body;
    const sid = 'sess-' + Date.now();
    const now = Date.now();
    const c = await dbGet("SELECT count(*) as count FROM sessions WHERE user = ?", [user]);
    if (c.count >= 100) {
        const old = await dbGet("SELECT id FROM sessions WHERE user = ? ORDER BY updated_at ASC LIMIT 1", [user]);
        if (old) { await dbRun("DELETE FROM sessions WHERE id=?", [old.id]); await dbRun("DELETE FROM messages WHERE session_id=?", [old.id]); }
    }
    const p = await dbGet("SELECT name FROM presets WHERE id=?", [presetId]);
    const ft = title || (p ? p.name : "新会话");
    await dbRun("INSERT INTO sessions (id, user, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [sid, user, ft, presetId, now, now]);
    res.json({ success: true, id: sid, title: ft });
});

app.post('/api/session/rename', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    await dbRun("UPDATE sessions SET title=?, updated_at=? WHERE id=? AND user=?", [req.body.title, Date.now(), req.body.id, user]);
    res.json({ success: true });
});

app.post('/api/session/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    await dbRun("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE id=? AND user=?)", [req.body.id, user]);
    await dbRun("DELETE FROM sessions WHERE id=? AND user=?", [req.body.id, user]);
    res.json({ success: true });
});

app.get('/api/search', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });
    const k = `%${q.trim()}%`;
    const rows = await dbAll(`SELECT m.id, m.content, m.timestamp, m.role, s.id as sid, s.title FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.user=? AND (m.content LIKE ? OR s.title LIKE ?) ORDER BY m.timestamp DESC LIMIT 50`, [user, k, k]);
    const resData = rows.map(r => {
        let t = r.content;
        try { const p = JSON.parse(r.content); if(Array.isArray(p)) t = p.filter(x=>x.type==='text').map(x=>x.text).join(' '); } catch{}
        return { ...r, content: t, session_id: r.sid, session_title: r.title };
    });
    res.json({ success: true, data: resData });
});

// --- 公告 API ---
app.get('/api/announcement', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const ann = await dbGet("SELECT content, timestamp FROM announcements ORDER BY id DESC LIMIT 1");
    res.json({ success: true, data: ann });
});

app.get('/api/admin/announcement/list', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const list = await dbAll("SELECT * FROM announcements ORDER BY id DESC LIMIT 20");
    res.json({ success: true, data: list });
});

app.post('/api/admin/announcement', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    let { content } = req.body;
    
    // 1. 强制附加北京时间
    const bjTime = getBeijingTime();
    content += `\n\n> 发布于 ${bjTime.full}`;

    await dbRun("INSERT INTO announcements (content, timestamp) VALUES (?, ?)", [content, Date.now()]);
    res.json({ success: true });
});

app.post('/api/admin/announcement/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    await dbRun("DELETE FROM announcements WHERE id = ?", [req.body.id]);
    res.json({ success: true });
});

// --- Chat ---
app.post('/api/chat', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ error: { message: "登录已过期" } });
    const { sessionId, presetId, messages, useSearch } = req.body;
    const now = Date.now();

    try {
        const preset = await dbGet("SELECT * FROM presets WHERE id=?", [presetId]);
        if (!preset) return res.status(400).json({ error: { message: "无此模型" } });

        const lastMsg = messages[messages.length-1];
        if (lastMsg && lastMsg.role === 'user') {
            await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", 
                [sessionId, 'user', typeof lastMsg.content==='string'?lastMsg.content:JSON.stringify(lastMsg.content), now]);
            await dbRun("UPDATE sessions SET updated_at=? WHERE id=?", [now, sessionId]);
        }

        let finalMsgs = [...messages];

        // 2. 强制注入当前北京时间 (无论是否搜索，AI都需要知道时间)
        const bjTime = getBeijingTime();
        const timeContext = {
            role: 'system',
            content: `当前北京时间: ${bjTime.desc}。`
        };
        
        // 将时间提示放在最前面
        finalMsgs.unshift(timeContext);

        if (useSearch && lastMsg && lastMsg.role === 'user') {
            let q = typeof lastMsg.content === 'string' ? lastMsg.content : lastMsg.content.find(c=>c.type==='text')?.text;
            if (q) {
                const sRes = await searchGoogle(q);
                if (sRes) {
                    // 插入搜索结果
                    finalMsgs.splice(finalMsgs.length-1, 0, { 
                        role: 'system', 
                        content: `[联网搜索结果]:\n${sRes}\n请结合上述搜索结果回答用户问题。` 
                    });
                }
            }
        }

        let url = preset.url;
        if (url.endsWith('/')) url = url.slice(0, -1);
        if (!url.includes('/chat/completions')) url += '/v1/chat/completions';

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        const apiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${preset.key}` },
            body: JSON.stringify({ model: preset.modelId, messages: finalMsgs, temperature: 0.7, stream: true })
        });

        if (!apiRes.ok) { res.write(`data: ${JSON.stringify({ error: await apiRes.json() })}\n\n`); return res.end(); }

        let fullText = "", buffer = "";
        apiRes.body.on('data', chunk => {
            buffer += chunk.toString();
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line.startsWith('data: ')) {
                    const d = line.slice(6);
                    if (d === '[DONE]') continue;
                    try {
                        const j = JSON.parse(d);
                        const c = j.choices?.[0]?.delta?.content || j.content || "";
                        if (c) { fullText += c; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`); }
                    } catch {}
                }
            }
        });
        apiRes.body.on('end', async () => {
            res.write('data: [DONE]\n\n'); res.end();
            if (fullText.trim()) {
                const u = await dbGet("SELECT * FROM usage WHERE user=? AND model_id=?", [user, presetId]);
                if (u) await dbRun("UPDATE usage SET count=count+1 WHERE user=? AND model_id=?", [user, presetId]);
                else await dbRun("INSERT INTO usage (user, model_id, count) VALUES (?, ?, 1)", [user, presetId]);
                await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", [sessionId, 'assistant', fullText, Date.now()]);
            }
        });
    } catch (e) { if(!res.headersSent) res.status(500).json({ error: e.message }); else res.end(); }
});

// --- Admin ---
app.get('/api/admin/data', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const presets = await dbAll("SELECT * FROM presets");
    const uRows = await dbAll("SELECT * FROM usage");
    const usage = {};
    uRows.forEach(r => { if(!usage[r.user]) usage[r.user]={}; usage[r.user][r.model_id]=r.count; });
    res.json({ success: true, presets, usage });
});

app.post('/api/admin/preset', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const { id, name, url, key, modelId, desc, icon } = req.body;
    const fid = id || 'model_' + Date.now();
    await dbRun("INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)", [fid, name, desc, url, key, modelId, icon||'⚡']);
    res.json({ success: true });
});

app.post('/api/admin/preset/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    await dbRun("DELETE FROM presets WHERE id=?", [req.body.id]);
    res.json({ success: true });
});

app.post('/api/admin/migrate', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    res.json(await checkAndMigrateData(true));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
initDB().then(() => app.listen(PORT, () => console.log(`Running on ${PORT}`)));
