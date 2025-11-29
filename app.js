let PRESETS = [], currentSessionId = null, isRequesting = false, uploadedFiles = [];
let authToken = localStorage.getItem('authToken'), isAdmin = localStorage.getItem('isAdmin') === 'true';
let isSearchEnabled = false;

marked.setOptions({ highlight: (c,l) => highlight.highlight(c, {language: highlight.getLanguage(l)?l:'plaintext'}).value, breaks: true, gfm: true });

window.onload = function() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    lucide.createIcons();
    if (authToken) initApp();
    document.getElementById('userInput').addEventListener('keydown', (e) => { if(e.key==='Enter' && !e.shiftKey && !isTouchDevice()) { e.preventDefault(); sendMessage(); } });
    window.addEventListener('paste', handlePaste);
};

function isTouchDevice() { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }
async function handleLogin() {
    try {
        const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username:document.getElementById('loginUser').value.trim(), password:document.getElementById('loginPass').value.trim() }) });
        const data = await res.json();
        if (data.success) {
            authToken = data.token; isAdmin = data.isAdmin;
            localStorage.setItem('authToken', authToken); localStorage.setItem('isAdmin', isAdmin);
            initApp();
        } else alert(data.message);
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

function toggleSearch() {
    isSearchEnabled = !isSearchEnabled;
    const btn = document.getElementById('searchToggleBtn');
    if (isSearchEnabled) {
        btn.style.color = '#10b981'; btn.style.background = 'rgba(16, 185, 129, 0.1)';
    } else {
        btn.style.color = ''; btn.style.background = '';
    }
}

let currentAnnounceTime = 0;
async function checkAnnouncement(force) {
    try {
        const res = await fetch('/api/announcement', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        if (json.success && json.data) {
            const { content, timestamp } = json.data;
            currentAnnounceTime = timestamp;
            const last = localStorage.getItem('lastReadAnnounce');
            if (force || (!last || parseInt(last) < timestamp)) {
                document.getElementById('announceBody').innerHTML = DOMPurify.sanitize(marked.parse(content));
                document.getElementById('announceModal').classList.add('open');
            }
        } else if (force) alert("暂无公告");
    } catch(e) {}
}
function closeAnnouncement() {
    document.getElementById('announceModal').classList.remove('open');
    if (currentAnnounceTime > 0) localStorage.setItem('lastReadAnnounce', currentAnnounceTime);
}
async function postAnnouncement() {
    const content = document.getElementById('announceInput').value;
    if (!content.trim()) return alert("内容不能为空");
    if (!confirm("确定发布？会自动追加当前时间。")) return;
    await fetch('/api/admin/announcement', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ content }) });
    alert("发布成功"); document.getElementById('announceInput').value = ''; fetchAdminAnnouncements();
}
async function fetchAdminAnnouncements() {
    const res = await fetch('/api/admin/announcement/list', { headers: { 'Authorization': `Bearer ${authToken}` } });
    const json = await res.json();
    const div = document.getElementById('adminAnnounceList'); div.innerHTML = '';
    if(json.success && json.data) {
        json.data.forEach(a => {
            div.innerHTML += `
            <div style="padding:8px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-color); font-size:13px; display:flex; justify-content:space-between; align-items:center;">
                <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80%;">${a.content.substring(0,30)}...</div>
                <button class="icon-btn" style="color:var(--danger-color); padding:4px;" onclick="deleteAnnouncement(${a.id})"><i data-lucide="trash-2" style="width:14px"></i></button>
            </div>`;
        });
        lucide.createIcons();
    }
}
async function deleteAnnouncement(id) {
    if(!confirm("确定删除此公告？")) return;
    await fetch('/api/admin/announcement/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id }) });
    fetchAdminAnnouncements();
}

function toggleAccordion(header) { header.parentElement.classList.toggle('active'); }
let searchTimeout;
async function handleSearch(query) {
    clearTimeout(searchTimeout);
    if (!query.trim()) { document.getElementById('normalSidebarList').style.display = 'flex'; document.getElementById('searchResultList').style.display = 'none'; return; }
    searchTimeout = setTimeout(async () => {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        if (json.success) {
            document.getElementById('normalSidebarList').style.display = 'none'; document.getElementById('searchResultList').style.display = 'block';
            document.getElementById('searchOutput').innerHTML = json.data.map(item => 
                `<div class="session-item" onclick="loadSession('${item.session_id}')"><div><div style="font-weight:600;">${item.session_title}</div><div style="font-size:12px; color:var(--text-secondary);">${item.content.substring(0,30)}...</div></div></div>`
            ).join('') || '<div style="padding:10px;text-align:center;font-size:13px;">无记录</div>';
        }
    }, 300); 
}
async function fetchSessions() {
    const res = await fetch('/api/sessions', { headers: { 'Authorization': `Bearer ${authToken}` } });
    const json = await res.json();
    if (json.success) {
        const container = document.getElementById('sessionListContainer'); container.innerHTML = '';
        document.getElementById('sessionCount').innerText = `${json.data.length}`;
        const groups = { '今天': [], '昨天': [], '7天内': [], '更早': [] };
        json.data.forEach(s => {
            const d = new Date(s.updated_at), now = new Date(), diff = now - d, oneDay = 86400000;
            let label = '更早';
            if (d.toDateString() === now.toDateString()) label = '今天';
            else if (diff < oneDay * 2 && d.getDate() !== now.getDate()) label = '昨天';
            else if (diff < oneDay * 7) label = '7天内';
            groups[label].push(s);
        });
        ['今天', '昨天', '7天内', '更早'].forEach(label => {
            if (groups[label].length) {
                container.innerHTML += `<div class="session-group"><div class="group-header">${label}</div>` + groups[label].map(s => {
                    const p = PRESETS.find(x => x.id === s.mode);
                    return `<div class="session-item ${s.id === currentSessionId ? 'active' : ''}" onclick="loadSession('${s.id}')"><div class="session-title"><span style="font-size:16px;">${p?p.icon:''}</span><span>${s.title}</span></div><div class="session-actions"><button class="icon-btn" onclick="renameSession('${s.id}','${s.title}');event.stopPropagation()"><i data-lucide="edit-2" style="width:14px"></i></button><button class="icon-btn" style="color:var(--danger-color)" onclick="deleteSession('${s.id}');event.stopPropagation()"><i data-lucide="trash-2" style="width:14px"></i></button></div></div>`;
                }).join('') + `</div>`;
            }
        });
        if (!currentSessionId && json.data.length) loadSession(json.data[0].id);
        lucide.createIcons();
    }
}
async function loadSession(id) {
    if(isRequesting) return;
    currentSessionId = id;
    document.getElementById('searchInput').value = '';
    document.getElementById('normalSidebarList').style.display = 'flex'; document.getElementById('searchResultList').style.display = 'none';
    document.getElementById('chat-box').innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-secondary);">加载中...</div>';
    try {
        const res = await fetch(`/api/session/${id}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        document.getElementById('headerTitle').innerText = json.session.title;
        const box = document.getElementById('chat-box'); box.innerHTML = '';
        if (json.messages.length === 0) 
            box.innerHTML = '<div id="emptyState" style="text-align:center; padding:80px; color:var(--text-secondary);"><i data-lucide="message-square-plus" style="width:48px;height:48px;opacity:0.2;margin-bottom:16px;"></i><br>开始新的对话</div>';
        json.messages.forEach(m => appendUI(null, m.role, typeof m.content==='string'?m.content:m.content.map(c=>c.type==='text'?c.text:'').join(''), m.content.filter?m.content.filter(c=>c.type==='image_url').map(c=>c.image_url.url):[], false, m.timestamp));
        fetchSessions(); lucide.createIcons();
        if(window.innerWidth < 1000) { document.getElementById('sidebar').classList.remove('open'); document.querySelector('.overlay').classList.remove('show'); }
    } catch(e) { document.getElementById('chat-box').innerHTML = "加载失败"; }
}
async function createNewSession(pid) {
    const res = await fetch('/api/session/new', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ presetId: pid }) });
    const json = await res.json();
    if (json.success) { await fetchSessions(); loadSession(json.id); }
}
async function renameSession(id, old) {
    const t = prompt("新标题", old);
    if (t && t !== old) {
        await fetch('/api/session/rename', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id, title: t }) });
        fetchSessions(); if(currentSessionId===id) document.getElementById('headerTitle').innerText = t;
    }
}
async function deleteSession(id) {
    if (!confirm("确定删除?")) return;
    await fetch('/api/session/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id }) });
    if(currentSessionId===id) { currentSessionId=null; document.getElementById('chat-box').innerHTML=''; document.getElementById('headerTitle').innerText='AI Chat'; }
    fetchSessions();
}

async function sendMessage() {
    if (isRequesting || !currentSessionId) return;
    const input = document.getElementById('userInput');
    const text = input.value.trim();
    if (!text && uploadedFiles.length === 0) return;
    
    const payload = uploadedFiles.map(f => f.type.startsWith('image/') ? {type:"image_url", image_url:{url:f.data}} : {type:"text", text:`[文件 ${f.name}]:\n${f.data}\n`});
    if (text) payload.push({ type: "text", text });
    
    appendUI(null, "user", text + (uploadedFiles.length?`\n(📎 ${uploadedFiles.length} 附件)`:''), uploadedFiles.filter(f=>f.type.startsWith('image/')).map(f=>f.data), false, Date.now());
    input.value = ''; uploadedFiles = []; renderPreviews(); autoResize(input);
    isRequesting = true; document.getElementById('sendBtn').disabled = true;
    
    const aiMsgId = appendUI(null, "ai", "", [], true); 
    const aiContentDiv = document.querySelector(`#${aiMsgId} .message-content`);
    let aiFullText = "";

    try {
        const sessRes = await fetch(`/api/session/${currentSessionId}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const sessData = await sessRes.json();
        const msgs = sessData.messages.map(m => ({ role: m.role, content: m.content }));
        msgs.push({ role: "user", content: payload });

        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ sessionId: currentSessionId, presetId: sessData.session.mode, messages: msgs, useSearch: isSearchEnabled })
        });
        if (!res.ok) throw new Error("API Error");

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const lines = decoder.decode(value, { stream: true }).split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const d = line.slice(6).trim();
                    if (d === '[DONE]') continue;
                    try { const j = JSON.parse(d); aiFullText += (j.choices?.[0]?.delta?.content || j.content || ""); } catch {}
                }
            }
            aiContentDiv.innerHTML = DOMPurify.sanitize(marked.parse(aiFullText));
            const box = document.getElementById('chat-box');
            if(box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight;
        }
        aiContentDiv.innerHTML = DOMPurify.sanitize(marked.parse(aiFullText));
        document.querySelector(`#${aiMsgId} .message-bubble`).insertAdjacentHTML('beforeend', `<div class="msg-meta">${formatTime(Date.now())}</div>`);
        fetchSessions();
    } catch (e) { aiContentDiv.innerHTML += `<br><span style="color:var(--danger-color)">Error: ${e.message}</span>`; } 
    finally { isRequesting = false; document.getElementById('sendBtn').disabled = false; }
}

function formatTime(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

function appendUI(id, role, text, images=[], isLoading=false, timestamp=null) {
    const empty = document.getElementById('emptyState');
    if (empty) empty.remove();
    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = `message-row ${role === 'user' ? 'user' : 'ai'}`;
    div.id = id || ('msg-' + Date.now());
    let cHtml = role==='user' ? (images.map(u=>`<img src="${u}"><br>`).join('') + text.replace(/</g, "&lt;")) : (isLoading ? '<span style="color:var(--text-secondary)">Thinking...</span>' : DOMPurify.sanitize(marked.parse(text)));
    div.innerHTML = `<div class="avatar ${role==='user'?'user-avatar':'ai-avatar'}"><i data-lucide="${role==='user'?'user':'bot'}" style="width:18px"></i></div><div class="message-bubble"><div class="message-content">${cHtml}</div>${(timestamp&&!isLoading)?`<div class="msg-meta">${formatTime(timestamp)}</div>`:''}</div>`;
    box.appendChild(div); box.scrollTop = box.scrollHeight; lucide.createIcons({ root: div });
    return div.id;
}

function handlePaste(e) { Array.from(e.clipboardData.items).forEach(i => { if(i.kind==='file') processFile(i.getAsFile()); }); }
function handleFileSelect(input) { Array.from(input.files).forEach(processFile); input.value = ''; }
function processFile(file) {
    const r = new FileReader();
    r.onload = e => { uploadedFiles.push({ name: file.name, type: file.type, data: e.target.result }); renderPreviews(); };
    file.type.startsWith('image/') ? r.readAsDataURL(file) : r.readAsText(file);
}
function renderPreviews() {
    const area = document.getElementById('preview-area'); area.innerHTML = '';
    uploadedFiles.forEach((f, i) => {
        area.innerHTML += `<div class="preview-item">${f.type.startsWith('image/')?`<img src="${f.data}">`:'<i data-lucide="file-text"></i>'}<div class="remove-file" onclick="uploadedFiles.splice(${i},1);renderPreviews()"><i data-lucide="x" style="width:14px"></i></div></div>`;
    }); lucide.createIcons();
}
function autoResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

async function fetchPresets() {
    try { const res = await fetch('/api/config'); const data = await res.json(); if(data.success) { PRESETS = data.presets; renderPresetsSidebar(); } } catch(e){}
}
function renderPresetsSidebar() {
    const list = document.getElementById('presetList'); list.innerHTML = '';
    PRESETS.forEach(p => { list.innerHTML += `<div class="mode-card" onclick="createNewSession('${p.id}')"><div class="mode-icon">${p.icon||'⚡'}</div><div class="mode-info"><div>${p.name}</div><div>${p.desc}</div></div></div>`; });
}
async function openAdmin() {
    document.getElementById('adminModal').classList.add('open');
    const res = await fetch('/api/admin/data', { headers: { 'Authorization': `Bearer ${authToken}` } });
    const data = await res.json();
    const grid = document.getElementById('statGrid'); grid.innerHTML = '';
    if (data.usage) {
        for (const [u, map] of Object.entries(data.usage)) {
            let t = 0, list = '';
            for (const [mid, c] of Object.entries(map)) { 
                t+=c; 
                // --- 修复：根据ID查找名称 ---
                const preset = data.presets.find(p => p.id === mid);
                const name = preset ? `${preset.icon||''} ${preset.name}` : mid;
                list+=`<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;"><span>${name}</span><strong>${c}</strong></div>`; 
            }
            grid.innerHTML += `<div style="background:var(--bg-color);border:1px solid var(--border-color);padding:16px;border-radius:12px;"><div style="font-weight:600;margin-bottom:8px;">${u} <span style="float:right;background:var(--primary-color);color:#fff;padding:0 6px;border-radius:8px;font-size:12px;">${t}</span></div>${list}</div>`;
        }
    }
    const pl = document.getElementById('adminPresetList'); pl.innerHTML = '';
    data.presets.forEach(p => {
        pl.innerHTML += `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px;background:var(--bg-color);border:1px solid var(--border-color);border-radius:8px;"><div><strong>${p.name}</strong></div><div><button class="icon-btn" onclick='editPreset(${JSON.stringify(JSON.stringify(p))})'><i data-lucide="edit-3" style="width:16px;"></i></button><button class="icon-btn" style="color:var(--danger-color);" onclick="deletePreset('${p.id}')"><i data-lucide="trash-2" style="width:16px;"></i></button></div></div>`;
    });
    lucide.createIcons();
}
function editPreset(jsonStr) {
    const p = JSON.parse(jsonStr);
    document.getElementById('addId').value=p.id; document.getElementById('addName').value=p.name; document.getElementById('addDesc').value=p.desc; document.getElementById('addUrl').value=p.url; document.getElementById('addKey').value=p.key; document.getElementById('addModelId').value=p.modelId;
    document.getElementById('addFormTitle').innerText="编辑预设"; document.getElementById('savePresetBtn').innerText="保存";
    document.querySelectorAll('.accordion-item')[2].classList.add('active');
}
function resetPresetForm() {
    document.getElementById('addId').value=''; document.querySelectorAll('#adminModal input[type="text"]').forEach(i=>i.value='');
    document.getElementById('addFormTitle').innerText="添加新预设"; document.getElementById('savePresetBtn').innerText="保存";
}
async function savePreset() {
    const p = { id:document.getElementById('addId').value, name:document.getElementById('addName').value, url:document.getElementById('addUrl').value, key:document.getElementById('addKey').value, modelId:document.getElementById('addModelId').value, desc:document.getElementById('addDesc').value };
    if(!p.name||!p.url||!p.key||!p.modelId) return alert("请填写完整");
    await fetch('/api/admin/preset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify(p) });
    resetPresetForm(); openAdmin(); fetchPresets();
}
async function deletePreset(id) { if(confirm("删除?")) { await fetch('/api/admin/preset/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id }) }); openAdmin(); fetchPresets(); } }
async function forceMigrate() { if(confirm("导入旧数据?")) { const res=await fetch('/api/admin/migrate', { method:'POST', headers: { 'Authorization': `Bearer ${authToken}` } }); alert((await res.json()).message); location.reload(); } }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.querySelector('.overlay').classList.toggle('show'); }
function toggleTheme() { const n = document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark'; document.documentElement.setAttribute('data-theme',n); localStorage.setItem('theme',n); lucide.createIcons(); }
