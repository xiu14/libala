let PRESETS = [], currentSessionId = null, isRequesting = false, uploadedFiles = [];
let authToken = localStorage.getItem('authToken'), isAdmin = localStorage.getItem('isAdmin') === 'true';
let isSearchEnabled = false;

// 注册模式状态
let isRegisterMode = false;

marked.setOptions({ highlight: (c,l) => highlight.highlight(c, {language: highlight.getLanguage(l)?l:'plaintext'}).value, breaks: true, gfm: true });

window.onload = function() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    lucide.createIcons();
    if (authToken) initApp();
    
    document.getElementById('userInput').addEventListener('keydown', (e) => { 
        if(e.key==='Enter' && !e.shiftKey && !isTouchDevice()) { e.preventDefault(); sendMessage(); } 
    });
    
    // 登录页回车提交
    const loginInputs = document.querySelectorAll('.login-input');
    loginInputs.forEach(input => {
        input.addEventListener('keydown', (e) => {
            if(e.key === 'Enter') handleSubmit();
        });
    });

    window.addEventListener('paste', handlePaste);
};

function isTouchDevice() { return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }

// --- 切换 登录/注册 模式 ---
function toggleRegisterMode() {
    isRegisterMode = !isRegisterMode;
    const btn = document.getElementById('actionBtn');
    const switchText = document.querySelector('.switch-mode-text');
    const user = document.getElementById('loginUser');
    const pass = document.getElementById('loginPass');
    const confirmPass = document.getElementById('loginPassConfirm');
    const inviteInput = document.getElementById('regInviteCode'); 
    
    btn.classList.remove('fade-in');
    void btn.offsetWidth;
    btn.classList.add('fade-in');

    if (isRegisterMode) {
        btn.innerText = "注册账号";
        switchText.innerHTML = '已有账号？<span style="color: #9c74ff; font-weight:600;">返回登录</span>';
        user.placeholder = "起个响亮的名字...";
        confirmPass.style.display = 'block';
        inviteInput.style.display = 'block'; 
        pass.value = '';
        confirmPass.value = '';
        inviteInput.value = '';
    } else {
        btn.innerText = "进入站点";
        switchText.innerHTML = '没有通行证？<span style="color: #9c74ff; font-weight:600;">立即注册</span>';
        user.placeholder = "写上你的代号，黎吧啦在听。";
        confirmPass.style.display = 'none';
        inviteInput.style.display = 'none'; 
    }
}

async function handleSubmit() {
    if (isRegisterMode) {
        await handleRegister();
    } else {
        await handleLogin();
    }
}

// --- 注册处理 ---
async function handleRegister() {
    const userVal = document.getElementById('loginUser').value.trim();
    const passVal = document.getElementById('loginPass').value.trim();
    const confirmVal = document.getElementById('loginPassConfirm').value.trim();
    const inviteVal = document.getElementById('regInviteCode').value.trim(); 

    if (!userVal || !passVal) return alert("代号和暗号都不能少。");
    if (passVal !== confirmVal) return alert("两次输入的暗号不一致。");

    try {
        const btn = document.getElementById('actionBtn');
        const originalText = btn.innerText;
        btn.innerText = "注册中...";
        btn.disabled = true;

        const res = await fetch('/api/register', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({ username: userVal, password: passVal, inviteCode: inviteVal }) 
        });
        const data = await res.json();
        
        btn.innerText = originalText;
        btn.disabled = false;

        if (data.success) {
            alert(data.message);
            toggleRegisterMode();
            document.getElementById('loginUser').value = userVal;
            document.getElementById('loginPass').value = '';
            document.getElementById('loginPass').focus();
        } else {
            alert(data.message);
        }
    } catch(e) { 
        alert("信号中断，无法连接注册中心。"); 
        document.getElementById('actionBtn').disabled = false;
    }
}

async function handleLogin() {
    const userVal = document.getElementById('loginUser').value.trim();
    const passVal = document.getElementById('loginPass').value.trim();

    if (!userVal || !passVal) return alert("请输入账号和密码");

    try {
        const btn = document.getElementById('actionBtn');
        const originalText = btn.innerText;
        btn.innerText = "验证中...";
        btn.disabled = true;

        const res = await fetch('/api/login', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({ username: userVal, password: passVal }) 
        });
        const data = await res.json();
        
        btn.innerText = originalText;
        btn.disabled = false;

        if (data.success) {
            authToken = data.token; 
            isAdmin = data.isAdmin;
            localStorage.setItem('authToken', authToken); 
            localStorage.setItem('isAdmin', isAdmin);
            initApp();
        } else {
            alert(data.message || "账号或密码错误");
        }
    } catch(e) { 
        alert("网络错误，请检查连接"); 
        document.getElementById('actionBtn').disabled = false;
    }
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

// --- 公告系统逻辑 ---
let currentAnnounceTime = 0;

function switchAnnounceTab(tab) {
    document.querySelectorAll('.announce-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');

    document.getElementById('view-latest').style.display = tab === 'latest' ? 'block' : 'none';
    document.getElementById('view-history').style.display = tab === 'history' ? 'block' : 'none';

    if (tab === 'history') {
        fetchHistoryAnnouncements();
    }
}

async function fetchHistoryAnnouncements() {
    const container = document.getElementById('announceHistoryList');
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary);">加载中...</div>';

    try {
        const res = await fetch('/api/announcements/history', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        
        if (json.success && json.data && json.data.length > 0) {
            container.innerHTML = json.data.map(item => {
                const dateStr = new Date(item.timestamp).toLocaleString();
                const htmlContent = DOMPurify.sanitize(marked.parse(item.content));
                return `
                    <div style="background:var(--bg-color); border:1px solid var(--border-color); border-radius:8px; padding:16px; font-size:14px;">
                        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:8px; border-bottom:1px solid var(--border-color); padding-bottom:8px; display:flex; justify-content:space-between;">
                            <span>${dateStr}</span>
                            <span style="opacity:0.5">#${item.id}</span>
                        </div>
                        <div style="line-height:1.6; color:var(--text-color);">${htmlContent}</div>
                    </div>
                `;
            }).join('');
        } else {
            container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary);">暂无历史公告</div>';
        }
    } catch(e) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--danger-color);">加载失败</div>';
    }
}

async function checkAnnouncement(force) {
    switchAnnounceTab('latest');

    try {
        const res = await fetch('/api/announcement', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await res.json();
        const contentDiv = document.getElementById('view-latest'); 

        if (json.success && json.data) {
            const { content, timestamp } = json.data;
            currentAnnounceTime = timestamp;
            const last = localStorage.getItem('lastReadAnnounce');
            
            contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(content));

            if (force || (!last || parseInt(last) < timestamp)) {
                document.getElementById('announceModal').classList.add('open');
            }
        } else {
            contentDiv.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-secondary);">暂无最新公告</div>';
            if (force) document.getElementById('announceModal').classList.add('open');
        }
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

// --- 管理后台：邀请码逻辑 ---
async function fetchInviteInfo() {
    try {
        const res = await fetch('/api/admin/invite/info', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (data.success) {
            const statusText = document.getElementById('inviteStatusText');
            const toggleBtn = document.getElementById('inviteToggleBtn');
            if (data.inviteRequired) {
                statusText.innerText = '已开启'; statusText.style.color = '#10b981'; 
                toggleBtn.innerText = '关闭'; toggleBtn.style.background = 'var(--danger-color)';
            } else {
                statusText.innerText = '已关闭'; statusText.style.color = 'var(--text-secondary)';
                toggleBtn.innerText = '开启'; toggleBtn.style.background = 'var(--text-secondary)';
            }
            const listDiv = document.getElementById('inviteCodeList');
            if (data.codes.length === 0) listDiv.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:10px; opacity:0.5;">暂无可用邀请码</div>';
            else listDiv.innerHTML = data.codes.map(code => `<div onclick="copyText('${code}')" style="background:var(--bg-color); border:1px solid var(--border-color); border-radius:6px; padding:8px; text-align:center; cursor:pointer; font-family:monospace; letter-spacing:1px; position:relative;" title="点击复制">${code}</div>`).join('');
        }
    } catch(e) { console.error(e); }
}
async function toggleInviteSystem() {
    try { const res = await fetch('/api/admin/invite/toggle', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } }); const data = await res.json(); if (data.success) fetchInviteInfo(); } catch(e) { alert("操作失败"); }
}
async function generateInviteCode() {
    try { const res = await fetch('/api/admin/invite/generate', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } }); const data = await res.json(); if (data.success) fetchInviteInfo(); } catch(e) { alert("生成失败"); }
}
function copyText(text) { navigator.clipboard.writeText(text).then(() => { alert("邀请码已复制: " + text); }); }

// --- 模型预设逻辑 (修改：置顶和 System Prompt 处理) ---
async function fetchPresets() {
    try { 
        const res = await fetch('/api/config'); 
        const data = await res.json(); 
        if(data.success) { 
            let presets = data.presets;

            // 1. 置顶逻辑：找到 'libala_main' 并置顶
            const libalaIndex = presets.findIndex(p => p.id === 'libala_main');
            if (libalaIndex !== -1) {
                const libalaPreset = presets.splice(libalaIndex, 1)[0];
                presets.unshift(libalaPreset); // 放到数组最前面
            }
            
            PRESETS = presets;
            renderPresetsSidebar(); 
        } 
    } catch(e){}
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

// 修改：填充 system_prompt
function editPreset(jsonStr) {
    const p = JSON.parse(jsonStr);
    document.getElementById('addId').value=p.id; 
    document.getElementById('addName').value=p.name; 
    document.getElementById('addDesc').value=p.desc; 
    document.getElementById('addPrompt').value=p.system_prompt || ''; // 新增
    document.getElementById('addUrl').value=p.url; 
    document.getElementById('addKey').value=p.key; 
    document.getElementById('addModelId').value=p.modelId;
    document.getElementById('addFormTitle').innerText="编辑预设"; 
    document.getElementById('savePresetBtn').innerText="保存";
    document.querySelectorAll('.accordion-item')[3].classList.add('active'); 
}

// 修改：清空 system_prompt
function resetPresetForm() {
    document.getElementById('addId').value=''; 
    document.getElementById('addPrompt').value=''; // 新增
    document.querySelectorAll('#adminModal input[type="text"]').forEach(i=>i.value='');
    document.getElementById('addFormTitle').innerText="添加新预设"; 
    document.getElementById('savePresetBtn').innerText="保存";
}

// 修改：保存 system_prompt
async function savePreset() {
    const p = { 
        id:document.getElementById('addId').value, 
        name:document.getElementById('addName').value, 
        url:document.getElementById('addUrl').value, 
        key:document.getElementById('addKey').value, 
        modelId:document.getElementById('addModelId').value, 
        desc:document.getElementById('addDesc').value,
        system_prompt: document.getElementById('addPrompt').value.trim() // 新增
    };
    if(!p.name||!p.url||!p.key||!p.modelId) return alert("请填写完整");
    await fetch('/api/admin/preset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify(p) });
    resetPresetForm(); openAdmin(); fetchPresets();
}
async function deletePreset(id) { if(confirm("删除?")) { await fetch('/api/admin/preset/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ id }) }); openAdmin(); fetchPresets(); } }
async function forceMigrate() { if(confirm("导入旧数据?")) { const res=await fetch('/api/admin/migrate', { method:'POST', headers: { 'Authorization': `Bearer ${authToken}` } }); alert((await res.json()).message); location.reload(); } }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.querySelector('.overlay').classList.toggle('show'); }
function toggleTheme() { const n = document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark'; document.documentElement.setAttribute('data-theme',n); localStorage.setItem('theme',n); lucide.createIcons(); }
