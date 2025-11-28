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
const DB_FILE = path.join(DATA_DIR, 'chat.db'); // 新的 SQLite 文件
const OLD_DB_FILE = path.join(DATA_DIR, 'database.json'); // 旧文件用于迁移

// 默认预设
const DEFAULT_PRESETS = [
    { id: 'gemini', name: 'Gemini', desc: '3 Pro (Preview)', url: "https://whu.zeabur.app", key: "pwd", modelId: "gemini-3-pro-preview", icon: "💎" },
    { id: 'gpt', name: 'GPT', desc: '4.1 Mini', url: "https://x666.me", key: "sk-Pgj1iaG2ZvdKOxxrVHrvTio6vtKUGVOZbUgdUdqvFxp9RQow", modelId: "gpt-4.1-mini", icon: "🤖" }
];

app.use(express.json({ limit: '50mb' })); // 调大限制以支持图片上传
app.use(express.static(path.join(__dirname, '.')));

// --- SQLite 数据库封装 ---
let db;

function initDB() {
    return new Promise(async (resolve, reject) => {
        // 确保目录存在
        try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}

        db = new sqlite3.Database(DB_FILE, async (err) => {
            if (err) return reject(err);
            console.log('Connected to SQLite database.');
            
            // 建表
            db.serialize(() => {
                // 1. 预设表
                db.run(`CREATE TABLE IF NOT EXISTS presets (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    desc TEXT,
                    url TEXT,
                    key TEXT,
                    modelId TEXT,
                    icon TEXT
                )`);

                // 2. 会话表 (增加 updated_at 用于排序)
                db.run(`CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user TEXT,
                    title TEXT,
                    mode TEXT,
                    created_at INTEGER,
                    updated_at INTEGER
                )`);

                // 3. 消息表
                db.run(`CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    role TEXT,
                    content TEXT,
                    timestamp INTEGER,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )`);

                // 4. 统计表
                db.run(`CREATE TABLE IF NOT EXISTS usage (
                    user TEXT,
                    model_id TEXT,
                    count INTEGER,
                    PRIMARY KEY (user, model_id)
                )`);
            });

            // 检查是否需要迁移旧数据
            await checkAndMigrateData();
            // 检查是否需要初始化默认预设
            checkDefaultPresets();
            resolve();
        });
    });
}

// 辅助：Promise 化的 db.all / db.run
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// --- 数据迁移逻辑 (旧 JSON -> 新 SQLite) ---
async function checkAndMigrateData() {
    try {
        const sessionCount = await dbGet("SELECT count(*) as count FROM sessions");
        if (sessionCount.count > 0) return; // 数据库不为空，无需迁移

        if (fsDirect.existsSync(OLD_DB_FILE)) {
            console.log("检测到旧数据库文件，开始迁移数据...");
            const oldDataRaw = await fs.readFile(OLD_DB_FILE, 'utf8');
            const oldData = JSON.parse(oldDataRaw);

            // 1. 迁移预设
            if (oldData.presets && Array.isArray(oldData.presets)) {
                const stmt = db.prepare("INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon) VALUES (?, ?, ?, ?, ?, ?, ?)");
                oldData.presets.forEach(p => {
                    stmt.run(p.id, p.name, p.desc, p.url, p.key, p.modelId, p.icon || '⚡');
                });
                stmt.finalize();
            }

            // 2. 迁移统计
            if (oldData.usage) {
                const stmt = db.prepare("INSERT OR REPLACE INTO usage (user, model_id, count) VALUES (?, ?, ?)");
                for (const [user, usageMap] of Object.entries(oldData.usage)) {
                    for (const [modelId, count] of Object.entries(usageMap)) {
                        stmt.run(user, modelId, count);
                    }
                }
                stmt.finalize();
            }

            // 3. 迁移会话和消息 (最关键部分)
            if (oldData.chats) {
                const sessStmt = db.prepare("INSERT INTO sessions (id, user, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
                const msgStmt = db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
                
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    for (const [user, sessions] of Object.entries(oldData.chats)) {
                        sessions.forEach((s, idx) => {
                            // 使用旧ID或生成新ID
                            const sId = s.id || `sess_${Date.now()}_${idx}`;
                            const now = Date.now();
                            sessStmt.run(sId, user, s.title, s.mode, now, now);

                            if (s.messages && Array.isArray(s.messages)) {
                                s.messages.forEach(m => {
                                    // 确保存储为字符串
                                    const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                                    msgStmt.run(sId, m.role, contentStr, now);
                                });
                            }
                        });
                    }
                    db.run("COMMIT");
                });
                sessStmt.finalize();
                msgStmt.finalize();
                console.log("数据迁移完成！");
            }
        }
    } catch (e) {
        console.error("迁移失败:", e);
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

// --- 认证 Map ---
const tokenMap = new Map();

// --- 1. 登录 ---
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

// --- 2. 获取配置 (Presets) ---
app.get('/api/config', async (req, res) => {
    try {
        const presets = await dbAll("SELECT id, name, desc, icon FROM presets");
        res.json({ success: true, presets });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- 3. 会话管理 (核心修改) ---

// 获取会话列表 (仅元数据，不含消息)
app.get('/api/sessions', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });

    // 按更新时间倒序
    const sessions = await dbAll("SELECT id, title, mode, updated_at FROM sessions WHERE user = ? ORDER BY updated_at DESC", [user]);
    res.json({ success: true, data: sessions });
});

// 获取特定会话的详细消息
app.get('/api/session/:id', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });

    const sessionId = req.params.id;
    // 验证归属权
    const session = await dbGet("SELECT * FROM sessions WHERE id = ? AND user = ?", [sessionId, user]);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    const messages = await dbAll("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC", [sessionId]);
    
    // 解析 JSON 内容 (因为可能包含图片对象)
    const parsedMessages = messages.map(m => {
        try {
            return { role: m.role, content: JSON.parse(m.content) };
        } catch (e) {
            return { role: m.role, content: m.content };
        }
    });

    res.json({ success: true, session, messages: parsedMessages });
});

// 创建新会话 (包含 100 个窗口限制逻辑)
app.post('/api/session/new', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });

    const { presetId, title } = req.body;
    const sessionId = 'sess-' + Date.now();
    const now = Date.now();

    try {
        // 1. 检查数量限制
        const countRes = await dbGet("SELECT count(*) as count FROM sessions WHERE user = ?", [user]);
        if (countRes.count >= 100) {
            // 删除最旧的一个
            const oldest = await dbGet("SELECT id FROM sessions WHERE user = ? ORDER BY updated_at ASC LIMIT 1", [user]);
            if (oldest) {
                await dbRun("DELETE FROM sessions WHERE id = ?", [oldest.id]);
                // 级联删除消息由数据库外键处理，或者手动删
                await dbRun("DELETE FROM messages WHERE session_id = ?", [oldest.id]); 
            }
        }

        // 2. 创建新会话
        const preset = await dbGet("SELECT name FROM presets WHERE id = ?", [presetId]);
        const finalTitle = title || (preset ? preset.name : "新会话");
        
        await dbRun("INSERT INTO sessions (id, user, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
            [sessionId, user, finalTitle, presetId, now, now]);
            
        res.json({ success: true, id: sessionId, title: finalTitle });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 修改会话标题
app.post('/api/session/rename', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { id, title } = req.body;
    await dbRun("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user = ?", [title, Date.now(), id, user]);
    res.json({ success: true });
});

// 删除会话
app.post('/api/session/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ success: false });
    const { id } = req.body;
    
    // 手动清理消息 (如果SQLite版本不支持级联)
    await dbRun("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE id = ? AND user = ?)", [id, user]);
    await dbRun("DELETE FROM sessions WHERE id = ? AND user = ?", [id, user]);
    res.json({ success: true });
});

// --- 4. 聊天接口 (流式与保存) ---
app.post('/api/chat', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!user) return res.status(403).json({ error: { message: "登录已过期" } });

    const { sessionId, presetId, messages } = req.body; // messages 包含历史上下文 + 新消息

    try {
        const preset = await dbGet("SELECT * FROM presets WHERE id = ?", [presetId]);
        if (!preset) return res.status(400).json({ error: { message: "模型配置不存在" } });

        // 更新使用统计
        const usageCheck = await dbGet("SELECT * FROM usage WHERE user = ? AND model_id = ?", [user, presetId]);
        if (usageCheck) {
            await dbRun("UPDATE usage SET count = count + 1 WHERE user = ? AND model_id = ?", [user, presetId]);
        } else {
            await dbRun("INSERT INTO usage (user, model_id, count) VALUES (?, ?, 1)", [user, presetId]);
        }

        // 保存用户最新一条消息 (假设 messages 数组最后一条是用户的新消息)
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
            const contentStr = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
            await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", 
                [sessionId, 'user', contentStr, Date.now()]);
            // 更新会话时间
            await dbRun("UPDATE sessions SET updated_at = ? WHERE id = ?", [Date.now(), sessionId]);
        }

        // 构造请求 API
        let apiUrl = preset.url;
        if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
        if (!apiUrl.includes('/chat/completions')) apiUrl += '/v1/chat/completions';

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${preset.key}` },
            body: JSON.stringify({ model: preset.modelId, messages: messages, temperature: 0.7 })
        });
        
        const data = await response.json();
        if (!response.ok) return res.status(response.status).json(data);

        // 保存 AI 回复
        const aiContent = data.choices[0].message.content;
        await dbRun("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)", 
            [sessionId, 'assistant', aiContent, Date.now()]);

        res.json(data);

    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// --- 管理员接口 ---

app.get('/api/admin/data', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });

    const presets = await dbAll("SELECT * FROM presets");
    const usageRows = await dbAll("SELECT * FROM usage");
    
    // 格式化 Usage 为前端需要的格式: { user: { modelId: count } }
    const usage = {};
    usageRows.forEach(row => {
        if (!usage[row.user]) usage[row.user] = {};
        usage[row.user][row.model_id] = row.count;
    });

    res.json({ success: true, presets, usage });
});

// 添加/更新预设
app.post('/api/admin/preset', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });

    const { id, name, url, key, modelId, desc, icon } = req.body;
    const finalId = id || 'model_' + Date.now();
    const finalIcon = icon || '⚡';

    await dbRun(`INSERT OR REPLACE INTO presets (id, name, desc, url, key, modelId, icon) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        [finalId, name, desc || 'Custom Model', url, key, modelId, finalIcon]);
    
    res.json({ success: true });
});

// 删除预设
app.post('/api/admin/preset/delete', async (req, res) => {
    const user = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (user !== ADMIN_USER) return res.status(403).json({ success: false });

    const { id } = req.body;
    await dbRun("DELETE FROM presets WHERE id = ?", [id]);
    res.json({ success: true });
});

// --- 启动服务 ---
app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 启动并初始化
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} with SQLite storage.`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
});
