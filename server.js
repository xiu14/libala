require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const sqlite3 = require('sqlite3').verbose();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 0. R2 对象存储配置 (已修复签名问题) ---
// 必须在 Zeabur 环境变量中配置: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_DOMAIN
const hasR2Config = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_DOMAIN;

if (!hasR2Config) {
    console.log("提示: 未检测到完整的 R2 配置，将使用本地/Base64 存储模式。");
} else {
    console.log("提示: R2 对象存储已启用。");
}

const r2Client = hasR2Config ? new S3Client({
    // 关键修复 1: R2 必须使用 us-east-1 区域以兼容 AWS SDK 签名
    region: 'us-east-1', 
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // 关键修复 2: 禁用 SDK 自动计算 Checksum，防止 R2 签名不匹配 (SignatureDoesNotMatch)
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    forcePathStyle: true 
}) : null;

const R2_DOMAIN = process.env.R2_DOMAIN; 

// --- 1. 动态账号配置 ---
const USERS = {};
for (const key in process.env) {
    if (key.startsWith('ACC_')) {
        USERS[key.slice(4)] = process.env[key];
    }
}
const ADMIN_USER = process.env.ADMIN_USER || "libala";

// --- 2. 数据存储 ---
// Zeabur 等容器环境建议使用 /app/data
const DATA_DIR = '/app/data'; 
const LOCAL_DATA_DIR = path.join(__dirname, 'data');
// 自动判断环境
const DB_DIR = fs.existsSync('/app') ? DATA_DIR : LOCAL_DATA_DIR;
const DB_FILE = path.join(DB_DIR, 'chat.db'); 
const OLD_DB_FILE = path.join(DB_DIR, 'database.json');

// --- 默认预设 ---
const DEFAULT_PRESETS = [
    { 
        id: 'libala_main', 
        name: '✨ 左耳 - 黎吧啦', 
        desc: '倾听你的心声，用我的方式解析世界。', 
        url: "https://whu.zeabur.app", 
        key: "pwd", 
        modelId: "gemini-3-pro-preview", 
        icon: "💜",
        system_prompt: "你现在扮演黎吧啦，一个内心充满故事、敢爱敢恨的角色。你的对话风格要直接、略带叛逆，但充满真诚。你对《左耳》的剧情和人物了如指掌，并能引用经典台词。请以'左耳'的意境与用户交流，保持这种强烈的角色感。"
    },
    { id: 'gemini', name: 'Gemini', desc: '3 Pro (Preview)', url: "https://whu.zeabur.app", key: "pwd", modelId: "gemini-3-pro-preview", icon: "💎", system_prompt: null },
    { id: 'gpt', name: 'GPT', desc: '4.1 Mini', url: "https://x666.me", key: "sk-Pgj1iaG2ZvdKOxxrVHrvTio6vtKUGVOZbUgdUdqvFxp9RQow", modelId: "gpt-4.1-mini", icon: "🤖", system_prompt: null }
];

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '.')));

// --- 辅助函数：获取标准北京时间字符串 ---
function getBeijingTime() {
    const now = new Date();
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
        full: `${yyyy}-${mm}-${dd} ${hh}:${min}`,
        desc: `${yyyy}年${mm}月${dd}日 ${hh}:${min} 星期${weekday}`
    };
}

// --- SQLite ---
let db;
function initDB() {
    return new Promise(async (resolve, reject) => {
        try { 
            if (!fs.existsSync(DB_DIR)) await fsPromises.mkdir(DB_DIR, { recursive: true }); 
        } catch (e) {
            console.error("创建数据目录失败:", e);
        }

        db = new sqlite3.Database(DB_FILE, async (err) => {
            if (err) return reject(err);
            console.log(`Database connected: ${DB_FILE}`);
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT, desc TEXT, url TEXT, key TEXT, modelId TEXT, icon TEXT, system_prompt TEXT)`);
                db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT, title TEXT, mode TEXT, created_at INTEGER, updated_at INTEGER)`);
                db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE)`);
                db.run(`CREATE TABLE IF NOT EXISTS usage (user TEXT, model_id TEXT, count INTEGER, PRIMARY KEY (user, model_id))`);
                db.run(`CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, timestamp INTEGER)`);
                db.run(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, is_admin INTEGER DEFAULT 0)`);
                db.run(`CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT)`);
                db.run(`CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_at INTEGER, used_by TEXT, used_at INTEGER)`);
                
                db.run(`INSERT OR IGNORE INTO system_config (key, value) VALUES ('invite_required', 'false')`);

                db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
            });
            
            await checkAndMigrateData(false);
            await syncEnvUsersToDB();
            checkDefaultPresets();
            
            resolve();
        });
    });
}

function dbRun(sql, params = []) { return new Promise((resolve, reject) => { db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); }); }); }
function dbGet(sql, params = []) { return new Promise((resolve, reject) => { db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); }); }); }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => { db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); }); }); }

// --- 辅助逻辑 ---
function syncEnvUsersToDB() {
    return new Promise((resolve) => {
        const stmt = db.prepare("INSERT OR IGNORE INTO users (username, password, is_admin) VALUES (?, ?, ?)");
        for (const user in USERS) { stmt.run(user, USERS[user], 0); }
        if (ADMIN_USER) { db.run("UPDATE users SET is_admin = 1 WHERE username = ?", [ADMIN_USER], (err) => {}); }
        stmt.finalize();
        resolve();
    });
}

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
                const stmt = db.prepare("INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
                oldData.presets.forEach(p => stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon || '⚡', p.system_prompt || null));
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
        const stmt = db.prepare("INSERT INTO presets (id, name, desc, url, key, modelId, icon, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        DEFAULT_PRESETS.forEach(p => stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon, p.system_prompt));
        stmt.finalize();
    }
}

// --- R2 上传逻辑 ---
async function uploadToR2(base64Data) {
    if (!hasR2Config) return null;

    try {
        // 1. 解析 Base64
        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return null;

        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        
        // 2. 生成文件名
        const ext = mimeType.split('/')[1] || 'bin';
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '/'); // year/month/day
        const filename = `${dateStr}/${crypto.randomUUID()}.${ext}`;

        // 3. 上传到 R2
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME || 'libala-chat', 
            Key: filename,
            Body: buffer,
            ContentType: mimeType
        });

        await r2Client.send(command);

        // 4. 返回完整 URL
        return `https://${R2_DOMAIN}/${filename}`;
    } catch (e) {
        console.error("R2 Upload Error:", e);
        return null;
    }
}

// 处理消息数组：将 Base64 转换为 R2 链接
async function processMessagesForR2(messages) {
    if (!hasR2Config) return messages;

    const newMessages = JSON.parse(JSON.stringify(messages)); // 深拷贝
    let modified = false;

    const processContentItem = async (item) => {
        if (item.type === 'image_url' && item.image_url && item.image_url.url && item.image_url.url.startsWith('data:')) {
            const r2Url = await uploadToR2(item.image_url.url);
            if (r2Url) {
                console.log(`[R2] Image uploaded: ${r2Url}`);
                item.image_url.url = r2Url;
                modified = true;
            }
        }
    };

    for (const msg of newMessages) {
        if (Array.isArray(msg.content)) {
            await Promise.all(msg.content.map(processContentItem));
        }
    }
    return newMessages; 
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

// 获取系统状态
app.get('/api/system/status', async (req, res) => {
    const config = await dbGet("SELECT value FROM system_config WHERE key = 'invite_required'");
    const inviteRequired = config ? config.value === 'true' : false;
    res.json({ success: true, inviteRequired });
});

// 注册
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    if (!username || !password) return res.json({ success: false, message: "账号或密码不能为空" });
    if (username.length < 3) return res.json({ success: false, message: "账号至少需要3个字符" });

    const config = await dbGet("SELECT value FROM system_config WHERE key = 'invite_required'");
    const isInviteRequired = config && config.value === 'true';

    if (isInviteRequired) {
        if (!inviteCode) return res.json({ success: false, message: "本站已开启邀请注册，请输入邀请码" });
        const invite = await dbGet("SELECT * FROM invites WHERE code = ? AND used_by IS NULL", [inviteCode.trim()]);
        if (!invite) return res.json({ success: false, message: "邀请码无效或已被使用" });
    }

    const exist = await dbGet("SELECT username FROM users WHERE username = ?", [username]);
    if (exist) return res.json({ success: false, message: "该账号已被注册" });

    try {
        db.serialize(async () => {
            db.run("BEGIN TRANSACTION");
            db.run("INSERT INTO users (username, password, is_admin) VALUES (?, ?, 0)", [username, password]);
            if (isInviteRequired && inviteCode) {
                db.run("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?", [username, Date.now(), inviteCode.trim()]);
            }
            db.run("COMMIT", (err) => {
                if (err) res.status(500).json({ success: false, message: "注册事务失败" });
                else res.json({ success: true, message: "注册成功，请登录" });
            });
        });
    } catch (e) {
        if(db) db.run("ROLLBACK");
        res.status(500).json({ success: false, message: "注册失败: " + e.message });
    }
});

// 登录
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const userRow = await dbGet("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
    const isEnvUser = USERS[username] && USERS[username] === password;

    if (userRow || isEnvUser) {
        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        tokenMap.set(token, username);
        const isAdmin = (userRow && userRow.is_admin === 1) || (username === ADMIN_USER);
        res.json({ success: true, token, isAdmin: isAdmin });
    } else {
        res.status(401).json({ success: false, message: "账号或密码错误" });
    }
});

// 管理员邀请码接口
app.get('/api/admin/invite/info', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const config = await dbGet("SELECT value FROM system_config WHERE key = 'invite_required'");
    const inviteRequired = config ? config.value === 'true' : false;
    const codes = await dbAll("SELECT code FROM invites WHERE used_by IS NULL ORDER BY created_at DESC");
    res.json({ success: true, inviteRequired, codes: codes.map(c => c.code) });
});

app.post('/api/admin/invite/toggle', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const current = await dbGet("SELECT value FROM system_config WHERE key = 'invite_required'");
    const newVal = (current && current.value === 'true') ? 'false' : 'true';
    await dbRun("INSERT OR REPLACE INTO system_config (key, value) VALUES ('invite_required', ?)", [newVal]);
    res.json({ success: true, inviteRequired: newVal === 'true' });
});

app.post('/api/admin/invite/generate', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await dbRun("INSERT INTO invites (code, created_at) VALUES (?, ?)", [code, Date.now()]);
    res.json({ success: true, code });
});

app.get('/api/config', async (req, res) => {
    const presets = await dbAll("SELECT id, name, desc, icon, system_prompt FROM presets");
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

app.get('/api/announcements/history', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const list = await dbAll("SELECT id, content, timestamp FROM announcements ORDER BY id DESC");
    res.json({ success: true, data: list });
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

// --- Chat (自动处理新图片的 R2 上传) ---
app.post('/api/chat', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ error: { message: "登录已过期" } });
    
    let { sessionId, presetId, messages, useSearch } = req.body;
    const now = Date.now();

    try {
        const preset = await dbGet("SELECT * FROM presets WHERE id=?", [presetId]);
        if (!preset) return res.status(400).json({ error: { message: "无此模型" } });

        // 处理 R2 上传：只处理最后一条用户消息
        const lastMsg = messages[messages.length-1];
        if (lastMsg && lastMsg.role === 'user') {
            const processedMsgs = await processMessagesForR2([lastMsg]); 
            const msgToSave = processedMsgs[0];

            await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", 
                [sessionId, 'user', typeof msgToSave.content==='string' ? msgToSave.content : JSON.stringify(msgToSave.content), now]);
            
            await dbRun("UPDATE sessions SET updated_at=? WHERE id=?", [now, sessionId]);
            messages[messages.length-1] = msgToSave; // 更新内存中的消息用于发送给AI
        }

        let finalMsgs = [...messages];
        if (preset.system_prompt) finalMsgs.unshift({ role: 'system', content: preset.system_prompt });
        
        const bjTime = getBeijingTime();
        finalMsgs.unshift({ role: 'system', content: `当前北京时间: ${bjTime.desc}。` }); 

        if (useSearch && lastMsg && lastMsg.role === 'user') {
            let q = typeof lastMsg.content === 'string' ? lastMsg.content : lastMsg.content.find(c=>c.type==='text')?.text;
            if (q) {
                const sRes = await searchGoogle(q);
                if (sRes) {
                    finalMsgs.splice(finalMsgs.length-1, 0, { role: 'system', content: `[联网搜索结果]:\n${sRes}\n请结合上述搜索结果回答用户问题。` });
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

        let fullText = "";
        apiRes.body.on('data', chunk => {
            const lines = chunk.toString().split('\n');
            for(const line of lines) {
                if (line.startsWith('data: ')) {
                    const d = line.slice(6).trim();
                    if (d === '[DONE]') continue;
                    try { const j = JSON.parse(d); const c = j.choices?.[0]?.delta?.content || j.content || ""; if (c) { fullText += c; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`); } } catch {}
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
    const { id, name, url, key, modelId, desc, icon, system_prompt } = req.body;
    const fid = id || 'model_' + Date.now();
    await dbRun("INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [fid, name, desc, url, key, modelId, icon||'⚡', system_prompt]);
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

// --- 新增：历史图片迁移接口 (将数据库中的 Base64 迁移到 R2) ---
app.post('/api/admin/migrate-images', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false, message: "权限不足" });
    
    if (!hasR2Config) return res.status(400).json({ success: false, message: "未配置 R2 环境变量，无法迁移。" });

    try {
        console.log("开始扫描历史图片...");
        // 查找所有包含 'data:image' 的消息
        const rows = await dbAll("SELECT id, content FROM messages WHERE content LIKE '%data:image%'");
        let migratedCount = 0;

        for (const row of rows) {
            try {
                // 尝试解析 JSON
                const contentJson = JSON.parse(row.content);
                if (!Array.isArray(contentJson)) continue;

                let modified = false;
                
                // 处理数组中的每个项目
                const processItem = async (item) => {
                    if (item.type === 'image_url' && item.image_url && item.image_url.url && item.image_url.url.startsWith('data:')) {
                        console.log(`正在上传图片 (Msg ID: ${row.id})...`);
                        const r2Url = await uploadToR2(item.image_url.url);
                        if (r2Url) {
                            item.image_url.url = r2Url;
                            modified = true;
                        }
                    }
                };

                await Promise.all(contentJson.map(processItem));

                if (modified) {
                    await dbRun("UPDATE messages SET content = ? WHERE id = ?", [JSON.stringify(contentJson), row.id]);
                    migratedCount++;
                }
            } catch (e) {
                // 如果 content 不是 JSON 或解析失败，跳过
                continue;
            }
        }
        
        // 瘦身数据库 (释放 Base64 占用的空间)
        if (migratedCount > 0) {
            await dbRun("VACUUM"); 
        }

        res.json({ success: true, message: `迁移完成，共处理 ${migratedCount} 条包含图片的消息。` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "迁移失败: " + e.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
initDB().then(() => app.listen(PORT, () => console.log(`Running on ${PORT}`)));
