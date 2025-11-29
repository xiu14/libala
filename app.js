let PRESETS = []; 
let currentSessionId = null;
let isRequesting = false;
let uploadedFiles = []; 
let authToken = localStorage.getItem('authToken');
let isAdmin = localStorage.getItem('isAdmin') === 'true';

marked.setOptions({
    highlight: function(code, lang) {
        const language = highlight.getLanguage(lang) ? lang : 'plaintext';
        return highlight.highlight(code, { language }).value;
    },
    langPrefix: 'hljs language-', breaks: true, gfm: true
});

window.onload = function() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    lucide.createIcons();
    if (authToken) initApp();
    document.getElementById('userInput').addEventListener('keydown', (e) => {
        if(e.key === 'Enter' && !e.shiftKey && !isTouchDevice()) { e.preventDefault(); sendMessage(); }
    });
    window.addEventListener('paste', handlePaste);
};

function isTouchDevice() { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }

async function handleLogin() {
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value.trim();
    try {
        const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username:u, password:p }) });
        const data = await res.json();
        if (data.success) {
            authToken = data.token; isAdmin = data.isAdmin;
            localStorage.setItem('authToken', authToken); localStorage.setItem('isAdmin', isAdmin);
            initApp();
        } else { alert(data.message); }
    } catch(e) { alert("网络错误"); }
}

function logout() { localStorage.removeItem('authToken'); localStorage.removeItem('isAdmin'); location.reload(); }

async function initApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    if(isAdmin) document.getElementById('adminBtn').style.display = 'flex';
    await fetchPresets(); await fetchSessions(); 
    lucide.createIcons();
    checkAnnouncement(false); 
}

// --- 公告系统 ---
let currentAnnounceTime = 0;

async function checkAnnouncement(forceShow) {
    try {
        const res = await fetch('/api/announcement', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        if (json.success && json.data) {
            const { content, timestamp } = json.data;
            currentAnnounceTime = timestamp;
            const lastRead = localStorage.getItem('lastReadAnnounce');
            
            if (forceShow || (!lastRead || parseInt(lastRead) < timestamp)) {
                document.getElementById('announceBody').innerHTML = DOMPurify.sanitize(marked.parse(content));
                document.getElementById('announceModal').classList.add('open');
            }
        } else if (forceShow) {
            alert("暂无公告");
        }
    } catch(e) { console.error(e); }
}

function closeAnnouncement() {
    document.getElementById('announceModal').classList.remove('open');
    if (currentAnnounceTime > 0) {
        localStorage.setItem('lastReadAnnounce', currentAnnounceTime);
    }
}

async function postAnnouncement() {
    const content = document.getElementById('announceInput').value;
    if (!content.trim()) return alert("内容不能为空");
    if (!confirm("确定发布此公告吗？所有用户下次登录将看到。")) return;
    
    await fetch('/api/admin/announcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ content })
    });
    alert("发布成功");
    document.getElementById('announceInput').value = '';
}

// --- 折叠面板逻辑 ---
function toggleAccordion(header) {
    const item = header.parentElement;
    item.classList.toggle('active');
}

// --- 搜索逻辑 ---
let searchTimeout;
async function handleSearch(query) {
    clearTimeout(searchTimeout);
    const normalList = document.getElementById('normalSidebarList');
    const searchList = document.getElementById('searchResultList');
    const output = document.getElementById('searchOutput');
    
    if (!query.trim()) {
        normalList.style.display = 'flex';
        searchList.style.display = 'none';
        return;
    }

    searchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            const json = await res.json();
            if (json.success) {
                normalList.style.display = 'none';
                searchList.style.display = 'block';
                output.innerHTML = '';
                if (json.data.length === 0) {
                    output.innerHTML = '<div style="padding:10px; color:var(--text-secondary); text-align:center; font-size:14px;">无相关记录</div>';
                    return;
                }
                json.data.forEach(item => {
                    const preview = item.content.length > 30 ? item.content.substring(0, 30) + '...' : item.content;
                    output.innerHTML += `
                        <div class="session-item" onclick="loadSession('${item.session_id}')">
                            <div>
                                <div style="font-weight:600;">${item.session_title}</div>
                                <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">${preview}</div>
                            </div>
                        </div>`;
                });
            }
        } catch(e) {}
    }, 300); 
}

function getDateLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    const oneDay = 24 * 60 * 60 * 1000;
    
    if (d.toDateString() === now.toDateString()) return '今天';
    if (diff < oneDay * 2 && d.getDate() !== now.getDate()) return '昨天';
    if (diff < oneDay * 7) return '7天内';
    return '更早';
}

async function fetchSessions() {
    try {
        const res = await fetch('/api/sessions', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        if (json.success) {
            const container = document.getElementById('sessionListContainer');
            container.innerHTML = '';
            document.getElementById('sessionCount').innerText = `${json.data.length}`;
            
            const groups = { '今天': [], '昨天': [], '7天内': [], '更早': [] };
            json.data.forEach(s => {
                const label = getDateLabel(s.updated_at);
                if (groups[label]) groups[label].push(s);
                else groups['更早'].push(s);
            });

            const groupOrder = ['今天', '昨天', '7天内', '更早'];
            
            groupOrder.forEach(label => {
                if (groups[label].length > 0) {
                    let html = `<div class="session-group"><div class="group-header">${label}</div>`;
                    groups[label].forEach(s => {
                        const preset = PRESETS.find(p => p.id === s.mode);
                        const active = s.id === currentSessionId ? 'active' : '';
                        html += `
                            <div class="session-item ${active}" onclick="loadSession('${s.id}')">
                                <div class="session-title">
                                    <span style="font-size:16px;">${preset?preset.icon:''}</span> 
                                    <span>${s.title}</span>
                                </div>
                                <div class="session-actions">
                                    <button class="icon-btn" style="padding:4px;" onclick="renameSession('${s.id}', '${s.title}'); event.stopPropagation();"><i data-lucide="edit-2" style="width:14px; height:14px;"></i></button>
                                    <button class="icon-btn" style="padding:4px; color:var(--danger-color);" onclick="deleteSession('${s.id}'); event.stopPropagation();"><i data-lucide="trash-2" style="width:14px; height:14px;"></i></button>
                                </div>
                            </div>`;
                    });
                    html += `</div>`;
                    container.innerHTML += html;
                }
            });

            if (!currentSessionId && json.data.length > 0) loadSession(json.data[0].id);
            lucide.createIcons();
        }
    } catch(e) {}
}

async function loadSession(id) {
    if(isRequesting) return;
    currentSessionId = id;
    document.getElementById('searchInput').value = '';
    document.getElementById('normalSidebarList').style.display = 'flex';
    document.getElementById('searchResultList').style.display = 'none';

    document.getElementById('chat-box').innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-secondary);">加载中...</div>';
    try {
        const res = await fetch(`/api/session/${id}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        if (json.success) {
            document.getElementById('headerTitle').innerText = json.session.title;
            const box = document.getElementById('chat-box'); box.innerHTML = '';
            if (json.messages.length === 0) box.innerHTML = '<div style="text-align:center; padding:80px; color:var(--text-secondary);"><i data-lucide="message-square-plus" style="width:48px;height:48px;opacity:0.2;margin-bottom:16px;"></i><br>开始新的对话</div>';
            
            json.messages.forEach(msg => {
                let text = ""; let imgs = [];
                if (typeof msg.content === 'string') text = msg.content;
                else {
                    msg.content.forEach(c => { if (c.type === 'text') text += c.text; if (c.type === 'image_url') imgs.push(c.image_url.url); });
                }
                appendUI(null, msg.role, text, imgs, false, msg.timestamp);
            });
            
            fetchSessions(); 
            lucide.createIcons();
            if(window.innerWidth < 1000) { document.getElementById('sidebar').classList.remove('open'); document.querySelector('.overlay').classList.remove('show'); }
        }
    } catch(e) { document.getElementById('chat-box').innerHTML = "加载失败"; }
}

async function createNewSession(presetId) {
    const res = await fetch('/api/session/new', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ presetId }) });
    const json = await res.json();
    if (json.success) { await fetchSessions(); loadSession(json.id); }
}

async function renameSession(id, oldTitle) {
    const t = prompt("新标题", oldTitle);
    if (t && t !== oldTitle) {
        await fetch('/api/session/rename', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id, title: t }) });
        fetchSessions();
        if(currentSessionId === id) document.getElementById('headerTitle').innerText = t;
    }
}

async function deleteSession(id) {
    if (!confirm("确定删除?")) return;
    await fetch('/api/session/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id }) });
    if(currentSessionId === id) { currentSessionId = null; document.getElementById('chat-box').innerHTML = ''; document.getElementById('headerTitle').innerText = 'AI Chat'; }
    fetchSessions();
}

async function sendMessage() {
    if (isRequesting || !currentSessionId) return;
    const input = document.getElementById('userInput');
    const text = input.value.trim();
    if (!text && uploadedFiles.length === 0) return;
    
    let payload = [];
    uploadedFiles.forEach(f => {
        if (f.type.startsWith('image/')) payload.push({ type: "image_url", image_url: { url: f.data } });
        else payload.push({ type: "text", text: `[文件 ${f.name}]:\n${f.data}\n` });
    });
    if (text) payload.push({ type: "text", text });

    appendUI(null, "user", text + (uploadedFiles.length > 0 ? `\n(📎 ${uploadedFiles.length} 附件)` : ""), uploadedFiles.filter(f=>f.type.startsWith('image/')).map(f=>f.data), false, Date.now());
    
    input.value = ''; uploadedFiles = []; renderPreviews(); autoResize(input);
    isRequesting = true;
    const sendBtn = document.getElementById('sendBtn'); sendBtn.disabled = true;

    const aiMsgId = appendUI(null, "ai", "", [], true); 
    const aiContentDiv = document.querySelector(`#${aiMsgId} .message-content`);
    let aiFullText = "";

    try {
        const sessRes = await fetch(`/api/session/${currentSessionId}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const sessData = await sessRes.json();
        let msgs = sessData.messages || [];
        
        const cleanMsgs = msgs.map(m => ({ role: m.role, content: m.content }));
        cleanMsgs.push({ role: "user", content: payload });

        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ sessionId: currentSessionId, presetId: sessData.session.mode, messages: cleanMsgs })
        });

        if (!response.ok) throw new Error("API Error");

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line.startsWith('data: ')) {
                     const dataStr = line.slice(6).trim();
                     if (dataStr === '[DONE]') continue;
                     try {
                         const json = JSON.parse(dataStr);
                         if (json.error) throw new Error(json.error.message);
                         
                         // 兼容不同的返回结构 (有些是 choices[0].delta.content, 有些可能是 content)
                         let delta = "";
                         if(json.choices && json.choices[0] && json.choices[0].delta) {
                             delta = json.choices[0].delta.content || "";
                         } else if (json.content) {
                             delta = json.content;
                         }
                         
                         aiFullText += delta;
                     } catch (e) { }
                }
            }
            // Update UI efficiently
            aiContentDiv.innerHTML = DOMPurify.sanitize(marked.parse(aiFullText));
            const chatBox = document.getElementById('chat-box');
            if(chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 200) {
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        }
        
        // Final render
        aiContentDiv.innerHTML = DOMPurify.sanitize(marked.parse(aiFullText));
        const metaDiv = document.createElement('div');
        metaDiv.className = 'msg-meta';
        metaDiv.innerText = formatTime(Date.now());
        document.getElementById(aiMsgId).querySelector('.message-bubble').appendChild(metaDiv);
        
        fetchSessions(); 

    } catch (e) {
        aiContentDiv.innerHTML += `<br><span style="color:var(--danger-color)">Error: ${e.message}</span>`;
    } finally {
        isRequesting = false; sendBtn.disabled = false;
    }
}

function formatTime(ts) {
    if (!ts) return '';
    const date = new Date(ts);
    return `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
}

function appendUI(id, role, text, images = [], isLoading = false, timestamp = null) {
    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = `message-row ${role === 'user' ? 'user' : 'ai'}`;
    div.id = id || ('msg-' + Date.now());
    
    let contentHtml = "";
    if (role === 'user') {
        if (images && images.length > 0) images.forEach(u => contentHtml += `<img src="${u}"><br>`);
        contentHtml += text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    } else {
        if (isLoading) contentHtml = `<span style="color:var(--text-secondary)">Thinking...</span>`;
        else contentHtml = DOMPurify.sanitize(marked.parse(text));
    }
    
    const avatarIcon = role === 'user' ? 'user' : 'bot';
    
    let html = `
        <div class="avatar ${role === 'user' ? 'user-avatar' : 'ai-avatar'}">
            <i data-lucide="${avatarIcon}" style="width:18px; height:18px;"></i>
        </div>
        <div class="message-bubble">
            <div class="message-content">${contentHtml}</div>
            ${(timestamp && !isLoading) ? `<div class="msg-meta">${formatTime(timestamp)}</div>` : ''}
        </div>
    `;
    
    div.innerHTML = html;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    lucide.createIcons({ root: div }); 
    return div.id;
}

function handlePaste(e) {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) { if (item.kind === 'file') processFile(item.getAsFile()); }
}
function handleFileSelect(input) { if (input.files.length) Array.from(input.files).forEach(processFile); input.value = ''; }
function processFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => { uploadedFiles.push({ name: file.name, type: file.type, data: e.target.result }); renderPreviews(); };
    if (file.type.startsWith('image/')) reader.readAsDataURL(file); else reader.readAsText(file);
}
function renderPreviews() {
    const area = document.getElementById('preview-area'); area.innerHTML = '';
    uploadedFiles.forEach((f, i) => {
        area.innerHTML += `
        <div class="preview-item">
            ${f.type.startsWith('image/') ? `<img src="${f.data}">` : '<i data-lucide="file-text" style="color:var(--text-secondary)"></i>'}
            <div class="remove-file" onclick="uploadedFiles.splice(${i},1);renderPreviews()"><i data-lucide="x" style="width:14px"></i></div>
        </div>`;
    });
    lucide.createIcons();
}

function autoResize(el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight) + 'px'; }

// --- Admin ---
async function fetchPresets() {
    try { const res = await fetch('/api/config'); const data = await res.json(); if(data.success) { PRESETS = data.presets; renderPresetsSidebar(); } } catch(e){}
}
function renderPresetsSidebar() {
    const list = document.getElementById('presetList'); list.innerHTML = '';
    PRESETS.forEach(p => {
        list.innerHTML += `
        <div class="mode-card" onclick="createNewSession('${p.id}')">
            <div class="mode-icon">${p.icon||'⚡'}</div>
            <div class="mode-info">
                <div>${p.name}</div>
                <div>${p.desc}</div>
            </div>
        </div>`;
    });
}

async function openAdmin() {
    document.getElementById('adminModal').classList.add('open');
    const res = await fetch('/api/admin/data', { headers: { 'Authorization': `Bearer ${authToken}` } });
    const data = await res.json();
    
    const grid = document.getElementById('statGrid'); grid.innerHTML = '';
    if (data.usage) {
        for (const [user, usage] of Object.entries(data.usage)) {
            let total = 0; let listHtml = '';
            for (const [mid, count] of Object.entries(usage)) {
                total += count;
                const preset = PRESETS.find(p => p.id === mid);
                const displayName = preset ? `${preset.icon} ${preset.name}` : `<span style="color:var(--text-secondary);font-style:italic;">${mid}</span>`;
                listHtml += `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px dashed var(--border-color);"><span>${displayName}</span><span style="font-weight:600;">${count}</span></div>`;
            }
            grid.innerHTML += `<div style="background:var(--bg-color);border:1px solid var(--border-color);padding:16px;border-radius:12px;"><div style="font-weight:600;margin-bottom:12px;display:flex;justify-content:space-between;"><span>👤 ${user}</span><span style="background:var(--primary-color);color:var(--my-msg-text);padding:2px 8px;border-radius:10px;font-size:12px;">${total}</span></div><div>${listHtml}</div></div>`;
        }
    }

    const pList = document.getElementById('adminPresetList'); pList.innerHTML = '';
    data.presets.forEach(p => {
        const presetJson = JSON.stringify(p).replace(/"/g, '&quot;');
        pList.innerHTML += `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;background:var(--bg-color);border:1px solid var(--border-color);border-radius:8px;">
                <div><strong style="margin-right:8px;">${p.name}</strong> <span style="font-size:12px;color:var(--text-secondary);">${p.modelId}</span></div>
                <div style="display:flex;gap:4px;">
                    <button class="icon-btn" onclick="editPreset('${presetJson}')"><i data-lucide="edit-3" style="width:16px;"></i></button>
                    <button class="icon-btn" style="color:var(--danger-color);" onclick="deletePreset('${p.id}')"><i data-lucide="trash-2" style="width:16px;"></i></button>
                </div>
            </div>`;
    });
    lucide.createIcons();
}

function editPreset(jsonStr) {
    const p = JSON.parse(jsonStr);
    document.getElementById('addId').value = p.id;
    document.getElementById('addName').value = p.name;
    document.getElementById('addDesc').value = p.desc;
    document.getElementById('addUrl').value = p.url;
    document.getElementById('addKey').value = p.key;
    document.getElementById('addModelId').value = p.modelId;
    document.getElementById('addFormTitle').innerText = "编辑预设: " + p.name;
    document.getElementById('savePresetBtn').innerText = "保存";
    
    const accordions = document.querySelectorAll('.accordion-item');
    if (accordions.length > 2) {
            accordions.forEach(i => i.classList.remove('active'));
            accordions[2].classList.add('active'); 
    }
}

function resetPresetForm() {
    document.getElementById('addId').value = '';
    document.querySelectorAll('#adminModal input[type="text"]').forEach(i => i.value = '');
    document.getElementById('addFormTitle').innerText = "添加新预设";
    document.getElementById('savePresetBtn').innerText = "保存";
}

async function savePreset() {
    const id = document.getElementById('addId').value;
    const name = document.getElementById('addName').value;
    const url = document.getElementById('addUrl').value;
    const key = document.getElementById('addKey').value;
    const modelId = document.getElementById('addModelId').value;
    const desc = document.getElementById('addDesc').value;
    if(!name || !url || !key || !modelId) return alert("请填写完整");
    await fetch('/api/admin/preset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id, name, url, key, modelId, desc }) });
    alert("保存成功"); resetPresetForm(); openAdmin(); fetchPresets();
}

async function deletePreset(id) {
    if(!confirm("确定删除此预设吗？")) return;
    await fetch('/api/admin/preset/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id }) });
    openAdmin(); fetchPresets();
}

async function forceMigrate() {
    if(!confirm("⚠️ 确定要从旧的 database.json 导入数据吗？")) return;
    try {
        const res = await fetch('/api/admin/migrate', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        alert(json.message); location.reload();
    } catch(e) { alert("导入失败: " + e.message); }
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.querySelector('.overlay').classList.toggle('show'); }
function toggleTheme() { 
    const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; 
    document.documentElement.setAttribute('data-theme', n); 
    localStorage.setItem('theme', n);
    lucide.createIcons();
}
