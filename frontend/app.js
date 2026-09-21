// 从配置文件获取API地址
const API_BASE = CONFIG.API_BASE;

let currentShareFileId = null;
let currentShareLink = null;

/* =========================================================================
 * 统一流转规则（所有页面行为共用）：
 *   1. 状态判断：一律以 SessionManager.getState() 为准，不各自读 localStorage/探活
 *   2. 权限校验：受保护操作先走 withSession() 门禁，凭据请求一律走 authedFetch()
 *   3. 交互反馈：同一把加载锁、单例登录弹窗、统一 toast；写操作 in-flight 去重
 * ========================================================================= */

/* ---------------- 轻提示（统一交互反馈） ---------------- */

function ensureToastContainer() {
    let box = document.getElementById('toastBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'toastBox';
        box.className = 'toast-box';
        document.body.appendChild(box);
    }
    return box;
}

function toast(message, type = 'info', duration = 3000) {
    const box = ensureToastContainer();
    const item = document.createElement('div');
    item.className = `toast toast-${type}`;
    item.textContent = message;
    box.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
        item.classList.remove('show');
        setTimeout(() => item.remove(), 300);
    }, duration);
}

/* ---------------- 登录弹窗（单例，所有受保护操作共用） ---------------- */

const AuthFlow = {
    modal: null,
    resolve: null,
    reject: null,

    init() {
        this.modal = document.getElementById('authModal');
        document.getElementById('authForm').addEventListener('submit', (e) => this.onSubmit(e));
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.cancel();
        });
    },

    /**
     * 打开登录弹窗；重复调用复用同一次流程，不会叠加多个弹窗/请求
     * @returns {Promise} 登录成功 resolve，取消则以 AUTH_CANCELLED reject
     */
    open(purpose = {}) {
        if (this.resolve) {
            return this.promise;
        }
        document.getElementById('authHint').textContent =
            purpose.hint || '请输入您的凭据以继续当前操作';
        document.getElementById('authError').textContent = '';
        const usernameInput = document.getElementById('username');
        const knownUser = SessionManager.getState().user;
        usernameInput.value = knownUser || '';
        document.getElementById('password').value = '';
        (knownUser ? document.getElementById('password') : usernameInput).focus();

        this.modal.classList.add('active');

        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        return this.promise;
    },

    close() {
        this.modal.classList.remove('active');
        this.resolve = null;
        this.reject = null;
        this.promise = null;
        document.getElementById('authSubmitBtn').disabled = false;
        document.getElementById('authSubmitBtn').textContent = '验证';
    },

    cancel() {
        const reject = this.reject;
        this.close();
        if (reject) {
            const err = new Error('用户取消登录');
            err.code = 'AUTH_CANCELLED';
            reject(err);
        }
    },

    async onSubmit(e) {
        e.preventDefault();
        // 防重复点击：提交期间按钮禁用，登录请求本身也只有一次
        const submitBtn = document.getElementById('authSubmitBtn');
        if (submitBtn.disabled) return;

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('authError');

        if (!username || !password) {
            errorEl.textContent = '请输入用户名和密码';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = '验证中...';
        showLoading('验证身份...');

        try {
            // login 会原子性地替换令牌与会话状态，不会残留旧身份
            await SessionManager.login(username, password);
            hideLoading();
            errorEl.textContent = '';
            const resolve = this.resolve;
            this.close();
            toast('登录成功', 'success');
            if (resolve) resolve(SessionManager.getState());
        } catch (error) {
            hideLoading();
            submitBtn.disabled = false;
            submitBtn.textContent = '验证';
            errorEl.textContent = error.status === 429
                ? '请求过于频繁，请稍后再试'
                : (error.message || '验证失败，请检查账号密码');
        }
    }
};

function closeAuthModal() {
    AuthFlow.cancel();
}

/**
 * 权限门禁：确保有有效会话，否则统一弹出登录。
 * OFFLINE/RESTORING 不误判为退出；EXPIRING 视为仍可操作。
 */
async function withSession(purpose) {
    const state = SessionManager.getState().state;
    if (state === SessionManager.STATE.RESTORING) {
        await SessionManager.restore();
    }
    if (SessionManager.isAuthenticated()) {
        return SessionManager.getState();
    }
    const s = SessionManager.getState();
    if (s.state === SessionManager.STATE.OFFLINE) {
        const err = new Error('网络连接中断，请恢复网络后重试');
        err.code = 'OFFLINE';
        throw err;
    }
    await AuthFlow.open(purpose);
    return SessionManager.getState();
}

/**
 * 受保护操作统一执行器：
 *   门禁校验 → 执行 → 期间收到 401（令牌被替换/失效）→ 重新登录 → 仅重放一次
 */
async function runProtected(action, purpose) {
    await withSession(purpose);
    try {
        return await action();
    } catch (err) {
        if (err.name === 'SessionExpiredError') {
            await AuthFlow.open({ hint: '登录已失效，请重新登录后继续操作' });
            return await action();
        }
        throw err;
    }
}

/* ---------------- 会话状态展示（状态栏 + 横幅，单一渲染入口） ---------------- */

function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m} 分 ${s.toString().padStart(2, '0')} 秒` : `${s} 秒`;
}

function renderSessionUI(snap) {
    const userBar = document.getElementById('userBar');
    const currentUser = document.getElementById('currentUser');
    const userAvatar = document.getElementById('userAvatar');
    const dot = document.getElementById('sessionDot');
    const banner = document.getElementById('sessionBanner');
    const S = SessionManager.STATE;

    dot.className = 'session-dot';

    if (snap.state === S.RESTORING) {
        userBar.classList.remove('hidden');
        currentUser.textContent = '正在恢复会话…';
        userAvatar.textContent = '…';
        dot.classList.add('dot-restoring');
        banner.className = 'session-banner hidden';
        return;
    }

    if (snap.state === S.LOGGED_OUT) {
        userBar.classList.add('hidden');
        banner.className = 'session-banner hidden';
        return;
    }

    // ACTIVE / EXPIRING / EXPIRED / OFFLINE 都曾有用户身份
    userBar.classList.remove('hidden');
    currentUser.textContent = snap.user || '未登录';
    userAvatar.textContent = (snap.user || '?').charAt(0).toUpperCase();

    if (snap.state === S.ACTIVE) {
        dot.classList.add('dot-active');
        banner.className = 'session-banner hidden';
    } else if (snap.state === S.EXPIRING) {
        dot.classList.add('dot-expiring');
        banner.className = 'session-banner banner-expiring show';
        banner.innerHTML = `
            <span class="banner-text">登录将在 <strong id="bannerCountdown">${formatCountdown(snap.remainingMs)}</strong> 后失效</span>
            <span class="banner-actions">
                <button class="banner-btn banner-btn-primary" onclick="renewSession()">继续保持登录</button>
                <button class="banner-btn" onclick="logout()">退出</button>
            </span>`;
    } else if (snap.state === S.EXPIRED) {
        dot.classList.add('dot-expired');
        banner.className = 'session-banner banner-expired show';
        banner.innerHTML = `
            <span class="banner-text">登录已失效，敏感功能已锁定</span>
            <span class="banner-actions">
                <button class="banner-btn banner-btn-primary" onclick="relogin()">重新登录</button>
            </span>`;
    } else if (snap.state === S.OFFLINE) {
        dot.classList.add('dot-offline');
        banner.className = 'session-banner banner-offline show';
        banner.innerHTML = `
            <span class="banner-text">网络连接已中断，会话状态已冻结，恢复后自动续验</span>
            <span class="banner-actions">
                <button class="banner-btn banner-btn-primary" onclick="retryConnect()">重试连接</button>
                <button class="banner-btn" onclick="logout()">退出</button>
            </span>`;
    }
}

// 倒计时只刷新文字，不重建横幅（避免状态跳变/按钮闪动）
function renderCountdown(snap) {
    const el = document.getElementById('bannerCountdown');
    if (el && snap.state === SessionManager.STATE.EXPIRING) {
        el.textContent = formatCountdown(snap.remainingMs);
    }
}

async function renewSession() {
    try {
        await SessionManager.renew();
        toast('登录状态已延续', 'success');
    } catch (err) {
        if (err.status === 401) {
            toast('登录已失效，请重新登录', 'error');
        } else {
            toast(err.message || '续期失败，请稍后再试', 'error');
        }
    }
}

function relogin() {
    AuthFlow.open({ hint: '请重新登录以恢复敏感功能' })
        .catch(() => {});
}

function retryConnect() {
    SessionManager.restore();
}

// 主动退出：同一把锁防重复点击；本地入口先收回，服务端撤销由 SessionManager 兜底
let loggingOut = false;
async function logout() {
    if (loggingOut) return;
    loggingOut = true;
    try {
        await SessionManager.logout();
        toast('已退出登录', 'info');
    } finally {
        loggingOut = false;
    }
}

/* ---------------- 页面初始化（重新进入统一走 restore） ---------------- */

const fileListEl = () => document.getElementById('fileList');

document.addEventListener('DOMContentLoaded', async () => {
    AuthFlow.init();

    // 状态变化 → 刷新用户区；入口可见性按 hasAccess（OFFLINE 冻结不收起）
    let lastState = SessionManager.getState().state;
    let lastAccess = SessionManager.hasAccess();
    SessionManager.subscribe((snap) => {
        renderSessionUI(snap);

        const nowAccess = SessionManager.hasAccess();
        const nowAuthed = SessionManager.isAuthenticated();

        // 登录/失效/退出导致入口可见性翻转时才重拉文件列表
        if (nowAccess !== lastAccess) {
            loadFileList();
        }
        // 登录成功、失效后重登、断网恢复：任何回到在线有效态的时刻刷新我的分享
        if (nowAuthed && lastState !== SessionManager.STATE.ACTIVE
            && lastState !== SessionManager.STATE.EXPIRING) {
            loadMyShares();
        }
        if (!nowAccess) {
            document.getElementById('mySharesSection').style.display = 'none';
        }

        lastState = snap.state;
        lastAccess = nowAccess;
    });
    SessionManager.onTick(renderCountdown);

    // 公开文件列表先出（登录不登录都能看），会话在后台重新校验
    loadFileList();
    await SessionManager.restore();
});

/* ---------------- 通用：blob 落盘 ---------------- */

function saveBlob(response, fallbackName) {
    return response.blob().then((blob) => {
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = fallbackName || 'download';
        if (contentDisposition) {
            const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
            if (match) filename = decodeURIComponent(match[1]);
        }
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
    });
}

/* ---------------- 文件上传（公开能力，保持原行为） ---------------- */

function validateFile(file) {
    if (file.size > CONFIG.MAX_FILE_SIZE) {
        return `文件大小超过限制（最大${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB）`;
    }
    return null;
}

async function uploadFile(file) {
    const validationError = validateFile(file);
    if (validationError) {
        document.getElementById('uploadStatus').textContent = `❌ ${validationError}`;
        return;
    }

    showLoading('上传中...');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            body: formData
        });
        const result = await response.json();

        if (response.ok) {
            document.getElementById('uploadStatus').textContent = `✅ ${file.name} 上传成功！`;
            loadFileList();
        } else {
            document.getElementById('uploadStatus').textContent = `❌ 上传失败: ${result.error}`;
        }
    } catch (error) {
        document.getElementById('uploadStatus').textContent = `❌ 上传失败: 网络连接中断`;
    } finally {
        hideLoading();
    }
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await uploadFile(file);
    e.target.value = '';
});

const uploadZone = document.querySelector('.upload-zone');

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');

    const file = e.dataTransfer.files[0];
    if (file) {
        await uploadFile(file);
    }
});

/* ---------------- 文件列表（分享按钮按当前会话状态渲染） ---------------- */

async function loadFileList() {
    const listEl = fileListEl();
    listEl.innerHTML = '<p class="empty-msg">加载中...</p>';

    let files;
    try {
        const response = await fetch(`${API_BASE}/files`);
        files = await response.json();
    } catch (error) {
        listEl.innerHTML = '<p class="empty-msg">文件列表加载失败：网络连接中断</p>';
        return;
    }

    // 同步读取唯一状态源；OFFLINE 时保留分享入口（界面冻结），操作时再给网络反馈
    const isLoggedIn = SessionManager.hasAccess();

    if (files.length === 0) {
        listEl.innerHTML = '<p class="empty-msg">暂无可下载文件</p>';
        return;
    }

    listEl.innerHTML = files.map(file => `
        <div class="file-item">
            <div class="file-info">
                <div class="file-icon">${getFileIcon(file.name)}</div>
                <div class="file-details">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-size">${formatSize(file.size)}</div>
                </div>
            </div>
            <div class="file-actions">
                ${isLoggedIn ? `<button class="share-btn" onclick="openShareModal('${escapeHtml(file.id)}', '${escapeHtml(file.name)}')">分享</button>` : ''}
                <button class="download-btn" onclick="requestDownload('${escapeHtml(file.id)}')">
                    下载
                </button>
            </div>
        </div>
    `).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ---------------- 下载（受保护操作：门禁 → 401重登重放 → 防重复点击） ---------------- */

const busyDownloads = new Set();

async function requestDownload(fileId) {
    // 同一文件的重复点击直接忽略，避免重复下载/重复扣减
    if (busyDownloads.has(fileId)) return;
    busyDownloads.add(fileId);
    try {
        await runProtected(() => performDownload(fileId), {
            hint: '请登录后下载该文件'
        });
    } catch (error) {
        if (error.code === 'AUTH_CANCELLED') {
            // 用户主动取消，不打扰
        } else if (error.name === 'NetworkOfflineError' || error.code === 'OFFLINE') {
            toast(error.message, 'error');
        } else {
            alert(`下载失败: ${error.message}`);
        }
    } finally {
        busyDownloads.delete(fileId);
        hideLoading();
    }
}

async function performDownload(fileId) {
    showLoading('正在下载...');
    const response = await SessionManager.authedFetch(`${API_BASE}/download/${fileId}`, {
        method: 'GET'
    });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `未知错误（${response.status}）`);
    }
    await saveBlob(response, 'download');
}

/* ---------------- 加载动画（全局唯一遮罩，引用计数防残留） ---------------- */

let loadingDepth = 0;
function showLoading(text = '加载中...') {
    document.getElementById('loadingText').textContent = text;
    loadingDepth++;
    document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
    loadingDepth = Math.max(0, loadingDepth - 1);
    if (loadingDepth === 0) {
        document.getElementById('loadingOverlay').classList.remove('active');
    }
}

/* ---------------- 图标与格式化 ---------------- */

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        pdf: '📄', doc: '📝', docx: '📝', txt: '📃',
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
        mp3: '🎵', wav: '🎵', mp4: '🎬', avi: '🎬',
        zip: '📦', rar: '📦', '7z': '📦',
        js: '💻', py: '🐍', html: '🌐', css: '🎨'
    };
    return icons[ext] || '📁';
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimestamp(timestamp) {
    if (!timestamp) return '永久有效';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatRemainingTime(expiresAt) {
    if (!expiresAt) return '永久';
    const remaining = expiresAt - (Date.now() / 1000);
    if (remaining <= 0) return '已过期';

    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        return `${days} 天 ${hours % 24} 小时`;
    } else if (hours > 0) {
        return `${hours} 小时 ${minutes} 分钟`;
    } else {
        return `${minutes} 分钟`;
    }
}

/* ---------------- 分享设置弹窗 ---------------- */

function openShareModal(fileId, fileName) {
    // 权限校验先行：无任何凭据（失效/退出）不允许打开敏感入口；
    // OFFLINE 保留入口（界面冻结），提交时统一给出网络中断反馈
    if (!SessionManager.hasAccess()) {
        toast('登录已失效，请重新登录后再分享', 'error');
        AuthFlow.open({ hint: '请登录后创建分享链接' }).catch(() => {});
        return;
    }
    currentShareFileId = fileId;
    document.getElementById('shareFileName').textContent = fileName;
    document.getElementById('shareError').textContent = '';
    document.getElementById('expireHours').value = '24';
    document.getElementById('maxDownloads').value = '10';
    document.getElementById('shareModal').classList.add('active');
}

function closeShareModal() {
    document.getElementById('shareModal').classList.remove('active');
    currentShareFileId = null;
}

let shareCreating = false;
async function confirmCreateShare() {
    if (!currentShareFileId || shareCreating) return;
    shareCreating = true;

    const submitBtn = document.getElementById('createShareBtn');
    submitBtn.disabled = true;
    showLoading('生成分享链接...');
    document.getElementById('shareError').textContent = '';

    try {
        const result = await runProtected(() => createShareRequest(), {
            hint: '请登录后创建分享链接'
        });
        closeShareModal();
        showShareSuccessModal(result);
        loadMyShares();
    } catch (error) {
        if (error.code === 'AUTH_CANCELLED') {
            // 登录被取消，分享弹窗保持打开
        } else if (error.name === 'NetworkOfflineError' || error.code === 'OFFLINE') {
            document.getElementById('shareError').textContent = '网络连接中断，请稍后重试';
        } else {
            document.getElementById('shareError').textContent = error.message || '生成分享链接失败';
        }
    } finally {
        shareCreating = false;
        submitBtn.disabled = false;
        hideLoading();
    }
}

async function createShareRequest() {
    const expireHours = parseInt(document.getElementById('expireHours').value);
    const maxDownloads = parseInt(document.getElementById('maxDownloads').value);

    const response = await SessionManager.authedFetch(`${API_BASE}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            file_id: currentShareFileId,
            expire_hours: expireHours,
            max_downloads: maxDownloads
        })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
        throw new Error(result.error || `生成分享链接失败（${response.status}）`);
    }
    return result;
}

function showShareSuccessModal(result) {
    currentShareLink = `${window.location.origin}/share.html#${result.share_id}`;

    document.getElementById('shareLinkInput').value = currentShareLink;
    document.getElementById('shareInfoName').textContent = result.filename;
    document.getElementById('shareInfoExpire').textContent = formatTimestamp(result.expires_at);
    document.getElementById('shareInfoDownloads').textContent = result.max_downloads ? `${result.max_downloads} 次` : '无限制';
    document.getElementById('copyBtnText').textContent = '复制';

    const copyBtn = document.querySelector('.copy-btn');
    copyBtn.classList.remove('copied');

    document.getElementById('shareSuccessModal').classList.add('active');
}

function closeShareSuccessModal() {
    document.getElementById('shareSuccessModal').classList.remove('active');
    currentShareLink = null;
}

async function copyShareLink() {
    const linkInput = document.getElementById('shareLinkInput');
    const copyBtnText = document.getElementById('copyBtnText');
    const copyBtn = document.querySelector('.copy-btn');

    try {
        await navigator.clipboard.writeText(linkInput.value);
    } catch (error) {
        linkInput.select();
        document.execCommand('copy');
    }
    copyBtnText.textContent = '已复制';
    copyBtn.classList.add('copied');

    setTimeout(() => {
        copyBtnText.textContent = '复制';
        copyBtn.classList.remove('copied');
    }, 2000);
}

/* ---------------- 我的分享（凭据请求，401 时由状态机收回入口） ---------------- */

async function loadMyShares() {
    const section = document.getElementById('mySharesSection');
    const list = document.getElementById('mySharesList');

    // OFFLINE 时保留区块（界面冻结）；无任何凭据时才收起
    if (!SessionManager.hasAccess()) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';

    try {
        const response = await SessionManager.authedFetch(`${API_BASE}/shares`, { method: 'GET' });
        const shares = await response.json();

        if (shares.length === 0) {
            list.innerHTML = '<p class="empty-msg">暂无分享链接</p>';
            return;
        }

        list.innerHTML = shares.map(share => {
            const statusClass = share.is_valid ? 'valid' : 'invalid';
            const statusText = share.is_valid ? '有效' : (share.error_msg || '无效');

            return `
                <div class="share-item">
                    <div class="share-item-header">
                        <span class="share-item-filename">${escapeHtml(share.filename)}</span>
                        <span class="share-item-status ${statusClass}">${statusText}</span>
                    </div>
                    <div class="share-item-details">
                        <div class="share-item-detail">
                            <span class="share-item-detail-label">剩余时间</span>
                            <span class="share-item-detail-value">${formatRemainingTime(share.expires_at)}</span>
                        </div>
                        <div class="share-item-detail">
                            <span class="share-item-detail-label">已下载</span>
                            <span class="share-item-detail-value">${share.download_count} / ${share.max_downloads || '∞'}</span>
                        </div>
                        <div class="share-item-detail">
                            <span class="share-item-detail-label">创建时间</span>
                            <span class="share-item-detail-value">${new Date(share.created_at).toLocaleString('zh-CN')}</span>
                        </div>
                    </div>
                    <div class="share-item-actions">
                        <button class="copy-link-btn" onclick="copyShareLinkFromList('${share.share_id}')">
                            🔗 复制链接
                        </button>
                        <button class="delete-share-btn" onclick="deleteShare('${share.share_id}')">
                            🗑️ 删除
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        if (error.name === 'SessionExpiredError') {
            // 状态订阅已收起“我的分享”，这里不再渲染残留内容
            section.style.display = 'none';
            return;
        }
        if (error.name === 'NetworkOfflineError') {
            list.innerHTML = '<p class="empty-msg">网络连接中断，恢复后自动重试</p>';
            return;
        }
        list.innerHTML = `<p class="empty-msg">加载失败: ${escapeHtml(error.message)}</p>`;
    }
}

async function copyShareLinkFromList(shareId) {
    const link = `${window.location.origin}/share.html#${shareId}`;
    try {
        await navigator.clipboard.writeText(link);
        toast('分享链接已复制到剪贴板', 'success');
    } catch (error) {
        prompt('请手动复制链接:', link);
    }
}

const busyDeletes = new Set();
async function deleteShare(shareId) {
    if (busyDeletes.has(shareId)) return;
    if (!confirm('确定要删除此分享链接吗？删除后链接将立即失效。')) {
        return;
    }

    busyDeletes.add(shareId);
    showLoading('删除中...');

    try {
        await runProtected(async () => {
            const response = await SessionManager.authedFetch(`${API_BASE}/share/${shareId}`, {
                method: 'DELETE'
            });
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.error || `删除失败（${response.status}）`);
            }
        }, { hint: '请登录后管理您的分享链接' });
        loadMyShares();
    } catch (error) {
        if (error.code === 'AUTH_CANCELLED') {
            // 取消登录，放弃本次删除
        } else if (error.name === 'NetworkOfflineError' || error.code === 'OFFLINE') {
            toast('网络连接中断，请稍后重试', 'error');
        } else {
            alert(`删除失败: ${error.message}`);
        }
    } finally {
        busyDeletes.delete(shareId);
        hideLoading();
    }
}
