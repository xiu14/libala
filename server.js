const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const fsDirect = require('fs');
const sqlite3 = require('sqlite3').verbose();
const app = express();

const PORT = process.env.PORT || 3000;

// --- 账号配置 ---
const USERS = {
    "libala": process.env.USER_PWD_LIBALA || "ouhao1992", 
    "dmj": process.env.USER_PWD_DMJ || "251128"
};
const ADMIN_USER = "libala";

// --- 数据存储配置 ---
const DATA_DIR = '/app/data'; 
const DB_FILE = path.join(DATA_DIR, 'chat.db'); 
const OLD_DB_FILE = path.join(DATA_DIR, 'database.json');

// 默认预设
const DEFAULT_PRESETS = [
    { id: 'gemini', name: 'Gemini', desc: '3 Pro (Preview)', url: "https://whu.zeabur.app", key: "pwd", modelId: "gemini-3-pro-preview", icon: "💎" },
    { id: 'gpt', name: 'GPT', desc: '4.1 Mini', url: "https://x666.me", key: "sk-Pgj1iaG2ZvdKOxxrVHrvTio6vtKUGVOZbUgdUdqvFxp9RQow", modelId: "gpt-4.1-mini", icon: "🤖" }
];

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.')));

// --- SQLite 数据库封装 ---
let db;

function initDB() {
    return new Promise(async (resolve, reject) => {
        try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}

        db = new sqlite3.Database(DB_FILE, async (err) => {
            if (err) return reject(err);
            console.log('Connected to SQLite database.');
            
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT, desc TEXT, url TEXT, key TEXT, modelId TEXT, icon TEXT)`);
                db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT, title TEXT, mode TEXT, created_at INTEGER, updated_at INTEGER)`);
                db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE)`);
                db.run(`CREATE TABLE IF NOT EXISTS usage (user TEXT, model_id TEXT, count INTEGER, PRIMARY KEY (user, model_id))`);
            });

            await checkAndMigrateData(false);
            checkDefaultPresets();
            resolve();
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
    });
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
}

// --- 数据迁移逻辑 ---
async function checkAndMigrateData(force = false) {
    try {
        if (!fsDirect.existsSync(OLD_DB_FILE)) return { success: false, message: "未找到旧文件" };
        if (!force) {
            const sessionCount = await dbGet("SELECT count(*) as count FROM sessions");
            if (sessionCount.count > 0) return { success: true, message: "数据库非空，跳过自动迁移" };
        }

        console.log("开始迁移旧数据...");
        const oldDataRaw = await fs.readFile(OLD_DB_FILE, 'utf8');
        const oldData = JSON.parse(oldDataRaw);

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            if (oldData.presets && Array.isArray(oldData.presets)) {
                const stmt = db.prepare("INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)");
                oldData.presets.forEach(p => stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon || '⚡'));
                stmt.finalize();
            }
            if (oldData.usage) {
                const stmt = db.prepare("INSERT OR REPLACE INTO usage (user, model_id, count) VALUES (?, ?, ?)");
                for (const [user, usageMap] of Object.entries(oldData.usage)) {
                    for (const [modelId, count] of Object.entries(usageMap)) {
                        stmt.run(user, modelId, count);
                    }
                }
                stmt.finalize();
            }
            if (oldData.chats) {
                const sessStmt = db.prepare("INSERT OR IGNORE INTO sessions (id, user, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
                const msgStmt = db.prepare("INSERT OR IGNORE INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
                let offset = 0;
                for (const [user, sessions] of Object.entries(oldData.chats)) {
                    sessions.forEach((s, idx) => {
                        const sId = s.id || `sess_${Date.now()}_${idx}`;
                        const now = Date.now() - (offset * 1000); 
                        offset++;
                        sessStmt.run(sId, user, s.title, s.mode, now, now);
                        if (s.messages && Array.isArray(s.messages)) {
                            s.messages.forEach(m => {
                                const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                                msgStmt.run(sId, m.role, contentStr, now);
                            });
                        }
                    });
                }
                sessStmt.finalize();
                msgStmt.finalize();
            }
            db.run("COMMIT");
        });
        return { success: true, message: "迁移成功" };
    } catch (e) {
        if (db) db.run("ROLLBACK");
        return { success: false, message: e.message };
    }
}

async function checkDefaultPresets() {
    const count = await dbGet("SELECT count(*) as c FROM presets");
    if (count.c === 0) {
        const stmt = db.prepare("INSERT INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)");
        DEFAULT_PRESETS.forEach(p => stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon));
        stmt.finalize();
    }
}

const tokenMap = new Map();

// --- API 接口 ---

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (USERS[username] && USERS[username] === password) {
        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        tokenMap.set(token, username);
        res.json({ success: true, token: token, isAdmin: username === ADMIN_USER });
    } else {
        res.status(401).json({ success: false, message: "账号或密码错误" });
    }
});

app.get('/api/config', async (req, res) => {
    try {
        const presets = await dbAll("SELECT id, name, desc, icon FROM presets");
        res.json({ success: true, presets });
    } catch (e) { res.status(500).json({ success: false }); }
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
    const sessionId = req.params.id;
    const session = await dbGet("SELECT * FROM sessions WHERE id = ? AND user = ?", [sessionId, user]);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    const messages = await dbAll("SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC", [sessionId]);
    const parsedMessages = messages.map(m => {
        try { return { role: m.role, content: JSON.parse(m.content), timestamp: m.timestamp }; } 
        catch (e) { return { role: m.role, content: m.content, timestamp: m.timestamp }; }
    });
    res.json({ success: true, session, messages: parsedMessages });
});

app.post('/api/session/new', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { presetId, title } = req.body;
    const sessionId = 'sess-' + Date.now();
    const now = Date.now();
    try {
        const countRes = await dbGet("SELECT count(*) as count FROM sessions WHERE user = ?", [user]);
        if (countRes.count >= 100) {
            const oldest = await dbGet("SELECT id FROM sessions WHERE user = ? ORDER BY updated_at ASC LIMIT 1", [user]);
            if (oldest) {
                await dbRun("DELETE FROM sessions WHERE id = ?", [oldest.id]);
                await dbRun("DELETE FROM messages WHERE session_id = ?", [oldest.id]); 
            }
        }
        const preset = await dbGet("SELECT name FROM presets WHERE id = ?", [presetId]);
        const finalTitle = title || (preset ? preset.name : "新会话");
        await dbRun("INSERT INTO sessions (id, user, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
            [sessionId, user, finalTitle, presetId, now, now]);
        res.json({ success: true, id: sessionId, title: finalTitle });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/session/rename', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { id, title } = req.body;
    await dbRun("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user = ?", [title, Date.now(), id, user]);
    res.json({ success: true });
});

app.post('/api/session/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { id } = req.body;
    await dbRun("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE id = ? AND user = ?)", [id, user]);
    await dbRun("DELETE FROM sessions WHERE id = ? AND user = ?", [id, user]);
    res.json({ success: true });
});

// --- 核心修复：聊天接口 (修复计费逻辑) ---
app.post('/api/chat', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ error: { message: "登录已过期" } });

    const { sessionId, presetId, messages } = req.body; 
    const now = Date.now();

    try {
        const preset = await dbGet("SELECT * FROM presets WHERE id = ?", [presetId]);
        if (!preset) return res.status(400).json({ error: { message: "模型配置不存在" } });

        // 1. 先保存用户的提问（不管成功与否，用户的发言要记录）
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
            const contentStr = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
            await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", 
                [sessionId, 'user', contentStr, now]);
            await dbRun("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
        }

        // 2. 处理 URL
        let apiUrl = preset.url;
        // 如果用户填写了完整的 .../chat/completions (比如火山引擎)，则不修改
        // 如果用户只填写了域名 (如 https://api.openai.com)，则补全
        if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
        if (!apiUrl.includes('/chat/completions')) apiUrl += '/v1/chat/completions';

        // 3. 发起请求
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${preset.key}` },
            body: JSON.stringify({ model: preset.modelId, messages: messages, temperature: 0.7 })
        });
        
        const data = await response.json();
        
        // 4. 如果失败，直接返回错误，不计费
        if (!response.ok) return res.status(response.status).json(data);

        // 5. 只有成功了，才增加计数 (移到了这里)
        const usageCheck = await dbGet("SELECT * FROM usage WHERE user = ? AND model_id = ?", [user, presetId]);
        if (usageCheck) await dbRun("UPDATE usage SET count = count + 1 WHERE user = ? AND model_id = ?", [user, presetId]);
        else await dbRun("INSERT INTO usage (user, model_id, count) VALUES (?, ?, 1)", [user, presetId]);

        // 6. 保存 AI 回复
        const aiContent = data.choices[0].message.content;
        await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", 
            [sessionId, 'assistant', aiContent, Date.now()]);

        res.json(data);
    } catch (error) { res.status(500).json({ error: { message: error.message } }); }
});

// --- 管理员接口 ---
app.get('/api/admin/data', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const presets = await dbAll("SELECT * FROM presets");
    const usageRows = await dbAll("SELECT * FROM usage");
    const usage = {};
    usageRows.forEach(row => {
        if (!usage[row.user]) usage[row.user] = {};
        usage[row.user][row.model_id] = row.count;
    });
    res.json({ success: true, presets, usage });
});

app.post('/api/admin/preset', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const { id, name, url, key, modelId, desc, icon } = req.body;
    const finalId = id || 'model_' + Date.now();
    await dbRun(`INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        [finalId, name, desc || 'Custom Model', url, key, modelId, icon || '⚡']);
    res.json({ success: true });
});

app.post('/api/admin/preset/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    await dbRun("DELETE FROM presets WHERE id = ?", [req.body.id]);
    res.json({ success: true });
});

app.post('/api/admin/migrate', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });
    const result = await checkAndMigrateData(true);
    res.json(result);
});

app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, 'index.html'));
});

initDB().then(() => {
    app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
}).catch(err => { console.error("DB Init Failed:", err); });
