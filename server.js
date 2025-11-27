const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
// 引入同步 fs 用于启动时检测路径
const fsSync = require('fs'); 
const fs = require('fs').promises;
const app = express();

const PORT = process.env.PORT || 3000;

// --- 账号配置 ---
const USERS = {
    "libala": process.env.USER_PWD_LIBALA || "ouhao1992", 
    "dmj": process.env.USER_PWD_DMJ || "251128"
};
const ADMIN_USER = "libala"; // 定义管理员账号

// --- 数据存储配置 (关键修改) ---
// Zeabur 挂载的硬盘路径通常是绝对路径 /app/data
const MOUNT_PATH = '/app/data';

// 判断逻辑：如果 /app/data 存在（说明在服务器且挂载成功），就用它。
// 否则（说明在本地开发），使用当前目录下的 data 文件夹。
const DATA_DIR = fsSync.existsSync(MOUNT_PATH) 
    ? MOUNT_PATH 
    : path.join(__dirname, 'data');

const DB_FILE = path.join(DATA_DIR, 'database.json');

console.log(`[System] Data storage path set to: ${DATA_DIR}`);

// 默认预设 (初始化数据库时使用)
const DEFAULT_PRESETS = [
    { id: 'gemini', name: 'Gemini', desc: '3 Pro (Preview)', url: "https://whu.zeabur.app", key: "pwd", modelId: "gemini-3-pro-preview", icon: "💎" },
    { id: 'gpt', name: 'GPT', desc: '4.1 Mini', url: "https://x666.me", key: "sk-Pgj1iaG2ZvdKOxxrVHrvTio6vtKUGVOZbUgdUdqvFxp9RQow", modelId: "gpt-4.1-mini", icon: "🤖" }
];

// --- 数据库操作封装 ---
async function getDB() {
    try {
        // 确保目录存在
        if (!fsSync.existsSync(DATA_DIR)) {
             await fs.mkdir(DATA_DIR, { recursive: true });
        }
        
        const data = await fs.readFile(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.log("[DB] Database not found or error, initializing new one...");
        // 如果文件不存在，初始化默认数据
        const initialDB = {
            presets: DEFAULT_PRESETS,
            usage: {}, // 格式: { username: { modelId: count } }
            chats: {}  // 格式: { username: [sessions] }
        };
        await saveDB(initialDB);
        return initialDB;
    }
}

async function saveDB(data) {
    try {
        // 二次确保存储目录存在（防止运行中被删除）
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error("[DB Error] Failed to save database:", err);
    }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '.')));

const tokenMap = new Map(); // Token -> Username

// 1. 登录接口 (返回是否为管理员)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (USERS[username] && USERS[username] === password) {
        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        tokenMap.set(token, username);
        res.json({ 
            success: true, 
            token: token,
            isAdmin: username === ADMIN_USER // 告诉前端是不是管理员
        });
    } else {
        res.status(401).json({ success: false, message: "账号或密码错误" });
    }
});

// 2. 获取配置 (所有用户可用，用于渲染侧边栏)
app.get('/api/config', async (req, res) => {
    const db = await getDB();
    // 只返回前端需要的信息，隐藏 Key
    const safePresets = db.presets.map(p => ({
        id: p.id, name: p.name, desc: p.desc, icon: p.icon
    }));
    res.json({ success: true, presets: safePresets });
});

// 3. 聊天转发 (自动计费)
app.post('/api/chat', async (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const username = tokenMap.get(token);
    if (!username) return res.status(403).json({ error: { message: "登录已过期" } });

    const { presetId, messages } = req.body; // 前端现在只传 presetId
    
    const db = await getDB();
    const preset = db.presets.find(p => p.id === presetId);
    
    if (!preset) return res.status(400).json({ error: { message: "模型配置不存在" } });

    // --- 统计计数 +1 ---
    if (!db.usage[username]) db.usage[username] = {};
    if (!db.usage[username][preset.id]) db.usage[username][preset.id] = 0;
    db.usage[username][preset.id]++;
    await saveDB(db); // 保存统计数据
    // ----------------

    // 构造 API 地址
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

// --- 历史记录存取 ---
app.get('/api/history', async (req, res) => {
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

// --- 管理员专用接口 ---

// A. 获取统计和完整配置
app.get('/api/admin/data', async (req, res) => {
    const username = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (username !== ADMIN_USER) return res.status(403).json({ success: false, message: "无权访问" });

    const db = await getDB();
    res.json({ success: true, presets: db.presets, usage: db.usage });
});

// B. 添加/修改预设
app.post('/api/admin/preset', async (req, res) => {
    const username = tokenMap.get(req.headers['authorization']?.replace('Bearer ', ''));
    if (username !== ADMIN_USER) return res.status(403).json({ success: false, message: "无权访问" });

    const newPreset = req.body; // { name, url, key, modelId, ... }
    // 生成 ID 和 图标
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
    console.log(`Data Directory: ${DATA_DIR}`); // 打印路径方便调试
});

