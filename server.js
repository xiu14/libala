const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fsSync = require('fs'); // 同步 fs 用于检测路径
const fs = require('fs').promises;
const app = express();

const PORT = process.env.PORT || 3000;

// --- 账号配置 ---
const USERS = {
    "libala": process.env.USER_PWD_LIBALA || "ouhao1992", 
    "dmj": process.env.USER_PWD_DMJ || "251128"
};
const ADMIN_USER = "libala";

// --- 数据存储配置 (保持之前的修复) ---
const MOUNT_PATH = '/app/data';
const DATA_DIR = fsSync.existsSync(MOUNT_PATH) 
    ? MOUNT_PATH 
    : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

console.log(`[System] Data storage path set to: ${DATA_DIR}`);

const DEFAULT_PRESETS = [
    { id: 'gemini', name: 'Gemini', desc: '3 Pro (Preview)', url: "https://whu.zeabur.app", key: "pwd", modelId: "gemini-3-pro-preview", icon: "💎" },
    { id: 'gpt', name: 'GPT', desc: '4.1 Mini', url: "https://x666.me", key: "sk-Pgj1iaG2ZvdKOxxrVHrvTio6vtKUGVOZbUgdUdqvFxp9RQow", modelId: "gpt-4.1-mini", icon: "🤖" }
];

// --- 数据库操作 ---
async function getDB() {
    try {
        if (!fsSync.existsSync(DATA_DIR)) await fs.mkdir(DATA_DIR, { recursive: true });
        const data = await fs.readFile(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        const initialDB = { presets: DEFAULT_PRESETS, usage: {}, chats: {} };
        await saveDB(initialDB);
        return initialDB;
    }
}

async function saveDB(data) {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error("[DB Error]", err);
    }
}

// --- 关键修改：禁用缓存中间件 ---
// 这个函数会给响应头加上“不要缓存”的标记
const noCache = (req, res, next) => {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');
    next();
};

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '.')));

const tokenMap = new Map();

// 1. 登录
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

// 2. 获取配置 (应用 noCache，防止修改预设后前端不更新)
app.get('/api/config', noCache, async (req, res) => {
    const db = await getDB();
    const safePresets = db.presets.map(p => ({
        id: p.id, name: p.name, desc: p.desc, icon: p.icon
    }));
    res.json({ success: true, presets: safePresets });
});

// 3. 聊天转发
app.post('/api/chat', async (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const username = tokenMap.get(token);
    if (!username) return res.status(403).json({ error: { message: "登录已过期" } });

    const { presetId, messages } = req.body;
    
    const db = await getDB();
    const preset = db.presets.find(p => p.id === presetId);
    
    if (!preset) return res.status(400).json({ error: { message: "模型配置不存在" } });

    // 统计 +1
    if (!db.usage[username]) db.usage[username] = {};
    if (!db.usage[username][preset.id]) db.usage[username][preset.id] = 0;
    db.usage[username][preset.id]++;
    await saveDB(db); 

    let apiUrl = preset.url;
    if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
    if (!apiUrl.includes('/chat/completions')) apiUrl += '/v1/chat/completions';

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${preset.key}` },
            body: JSON.stringify({ model: preset.modelId, messages: messages, temperature: 0.7 })
        });
        const data = await response.json();
        if (!response.ok) return res.status(response.status).json(data);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// --- 历史记录 (应用 noCache) ---
app.get('/api/history', noCache, async (req, res) => {
    const username = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!username) return res.status(403).json({ success: false });
    const db = await getDB();
    res.json({ success: true, data: db.chats[username] || [] });
});

app.post('/api/history', async (req, res) => {
    const username = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (!username) return res.status(403).json({ success: false });
    const db = await getDB();
    db.chats[username] = req.body.sessions;
    await saveDB(db);
    res.json({ success: true });
});

// --- 管理员接口 ---

// A. 获取统计 (重点：应用 noCache，确保每次刷新都是最新的数字)
app.get('/api/admin/data', noCache, async (req, res) => {
    const username = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (username !== ADMIN_USER) return res.status(403).json({ success: false, message: "无权访问" });

    const db = await getDB();
    // 可以在这里加个 console.log 确认每次刷新都触发了后端
    // console.log("Admin requesting data..."); 
    res.json({ success: true, presets: db.presets, usage: db.usage });
});

// B. 添加/修改预设
app.post('/api/admin/preset', async (req, res) => {
    const username = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (username !== ADMIN_USER) return res.status(403).json({ success: false, message: "无权访问" });

    const newPreset = req.body;
    if(!newPreset.id) newPreset.id = 'model_' + Date.now();
    if(!newPreset.icon) newPreset.icon = '⚡';
    if(!newPreset.desc) newPreset.desc = 'Custom Model';

    const db = await getDB();
    db.presets.push(newPreset);
    await saveDB(db);
    
    res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Data Directory: ${DATA_DIR}`);
});
