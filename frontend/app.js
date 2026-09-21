// 从配置文件获取API地址
const API_BASE = CONFIG.API_BASE;

let currentShareFileId = null;
let currentShareLink = null;

// 登录弹窗用途：download=登录后继续下载；relogin=失效后重新登录
let authPurpose = null;
let pendingDownloadFileId = null;

// 文件列表缓存：状态变化时可立即按权限重渲染，不跳变、不等待网络
let cachedFiles = [];
let sharesLoadedForToken = null;

// 加载遮罩使用计数，避免并发流程互相提前关闭
let loadingDepth = 0;

// ---------- 加载动画 ----------
function showLoading(text = '加载中...') {
    loadingDepth++;
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
    loadingDepth = Math.max(0, loadingDepth - 1);
    if (loadingDepth === 0) {
        document.getElementById('loadingOverlay').classList.remove('active');
    }
}

// ---------- 工具函数 ----------
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

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

// 保存响应为本地文件（登录下载与直接下载共用，保证流程一致）
function saveBlobResponse(response, fallbackName) {
    return response.blob().then(blob => {
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

// ---------- 会话状态 → 用户栏 / 敏感入口 ----------
function renderUserBar() {
    const userBar = document.getElementById('userBar');
    const currentUser = document.getElementById('currentUser');
    const userAvatar = document.getElementById('userAvatar');
    const badge = document.getElementById('sessionBadge');
    const badgeText = document.getElementById('sessionBadgeText');
    const renewBtn = document.getElementById('renewBtn');
    const reloginBtn = document.getElementById('reloginBtn');
    const logoutBtn = document.getElementById('logoutBtn');

    const s = Session.getState();
    const user = Session.getUser();

    // 已退出：整条用户栏隐藏
    if (s === Session.STATE.LOGGED_OUT) {
        userBar.classList.add('hidden');
        hideMyShares();
        return;
    }

    userBar.classList.remove('hidden');
    currentUser.textContent = user || '当前用户';
    userAvatar.textContent = (user || '?').charAt(0).toUpperCase();

    badge.hidden = false;
    badge.className = 'session-badge';

    switch (s) {
        case Session.STATE.RESTORING:
            badge.classList.add('is-restoring');
            badgeText.textContent = '正在确认登录状态…';
            renewBtn.hidden = true;
            reloginBtn.hidden = true;
            logoutBtn.hidden = false;
            break;

        case Session.STATE.ACTIVE:
            badge.classList.add('is-active');
            badgeText.textContent = '登录有效';
            renewBtn.hidden = true;
            reloginBtn.hidden = true;
            logoutBtn.hidden = false;
            loadMyShares();
            break;

        case Session.STATE.EXPIRING:
            badge.classList.add('is-expiring');
            badgeText.textContent = `即将失效 ${formatCountdown(Session.remainingMs())}`;
            renewBtn.hidden = false;
            reloginBtn.hidden = true;
            logoutBtn.hidden = false;
            loadMyShares();
            break;

        case Session.STATE.EXPIRED:
            // 已失效：状态标红 + 只保留重新登录/退出，敏感入口同步收回
            badge.classList.add('is-expired');
            badgeText.textContent = '登录已失效';
            renewBtn.hidden = true;
            reloginBtn.hidden = false;
            logoutBtn.hidden = false;
            hideMyShares();
            break;
    }
}

function formatCountdown(ms) {
    if (ms == null) return '';
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

// 每秒刷新即将失效倒计时（状态不变，仅更新文案）
setInterval(() => {
    if (Session.getState() === Session.STATE.EXPIRING) {
        document.getElementById('sessionBadgeText').textContent =
            `即将失效 ${formatCountdown(Session.remainingMs())}`;
    }
}, 1000);

function hideMyShares() {
    const section = document.getElementById('mySharesSection');
    const list = document.getElementById('mySharesList');
    section.style.display = 'none';
    list.innerHTML = '';
    sharesLoadedForToken = null;
}

// 订阅会话状态：立即重渲染敏感入口（分享按钮/我的分享），状态不残留
Session.subscribe((next) => {
    renderUserBar();
    renderFileList();
    if (next === Session.STATE.EXPIRED) {
        closeShareModal();
        Session.toast('登录状态已失效，受保护功能已收回', 'warning');
    }
});

// ---------- 上传 ----------
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
        document.getElementById('uploadStatus').textContent = `❌ 上传失败: ${error.message}`;
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

// ---------- 文件列表 ----------
async function loadFileList() {
    showLoading('加载文件列表...');

    try {
        const response = await fetch(`${API_BASE}/files`);
        cachedFiles = await response.json();
        renderFileList();
    } catch (error) {
        document.getElementById('fileList').innerHTML =
            `<p class="empty-msg">加载失败: ${escapeHtml(error.message)}</p>`;
    } finally {
        hideLoading();
    }
}

// 按当前会话状态渲染：只有 ACTIVE/EXPIRING 才出现“分享”敏感入口
function renderFileList() {
    const fileList = document.getElementById('fileList');
    const usable = Session.isUsable();

    if (cachedFiles.length === 0) {
        fileList.innerHTML = '<p class="empty-msg">暂无可下载文件</p>';
        return;
    }

    fileList.innerHTML = cachedFiles.map(file => `
        <div class="file-item">
            <div class="file-info">
                <div class="file-icon">${getFileIcon(file.name)}</div>
                <div class="file-details">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-size">${formatSize(file.size)}</div>
                </div>
            </div>
            <div class="file-actions">
                ${usable ? `<button class="share-btn" onclick="openShareModal('${escapeHtml(file.id)}', '${escapeHtml(file.name)}')">分享</button>` : ''}
                <button class="download-btn" onclick="requestDownload('${escapeHtml(file.id)}')">
                    下载
                </button>
            </div>
        </div>
    `).join('');
}

// ---------- 下载（受保护操作的统一流转）----------
async function requestDownload(fileId) {
    await Session.runProtected(`download:${fileId}`, async () => {
        try {
            showLoading('检查授权...');
            // 统一管道：状态判断 → 反馈（loading/toast）→ 权限校验（临期自动续期/重进复核）
            await Session.ensureUsable();
            await performDownload(fileId);
        } finally {
            hideLoading();
        }
    }, {
        // 需要登录/已失效：弹出原有登录框，登录成功后自动续接本次下载
        onAuthRequired: () => openAuthModal('download', fileId)
    });
}

// 真正发起下载；调用方必须已通过 ensureUsable
async function performDownload(fileId) {
    showLoading('正在下载...');
    try {
        const response = await Session.authFetch(`${API_BASE}/download/${fileId}`, { method: 'GET' });
        await saveBlobResponse(response);
        Session.toast('下载已开始', 'success');
    } finally {
        hideLoading();
    }
}

// ---------- 身份验证弹窗（原有登录方式保持兼容）----------
function openAuthModal(purpose, fileId = null) {
    authPurpose = purpose;
    pendingDownloadFileId = fileId;

    const title = document.getElementById('authModalTitle');
    const subtitle = document.getElementById('authModalSubtitle');
    const submitBtn = document.getElementById('authSubmitBtn');

    if (purpose === 'download') {
        title.textContent = '身份验证';
        subtitle.textContent = '请登录后继续下载该文件';
        submitBtn.textContent = '验证并下载';
    } else {
        title.textContent = '重新登录';
        subtitle.textContent = '登录状态已失效，请重新验证身份';
        submitBtn.textContent = '登录';
    }

    document.getElementById('authError').textContent = '';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('authModal').classList.add('active');
    document.getElementById('username').focus();
}

function closeAuthModal() {
    document.getElementById('authModal').classList.remove('active');
    authPurpose = null;
    pendingDownloadFileId = null;
}

function setAuthSubmitting(busy) {
    const btn = document.getElementById('authSubmitBtn');
    const cancelBtn = document.getElementById('authCancelBtn');
    btn.disabled = busy;
    cancelBtn.disabled = busy;
    btn.textContent = busy ? '验证中…' : (authPurpose === 'download' ? '验证并下载' : '登录');
}

document.getElementById('authCancelBtn').addEventListener('click', closeAuthModal);

document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const authError = document.getElementById('authError');

    if (!username || !password) {
        authError.textContent = '请输入用户名和密码';
        return;
    }

    // 防重复提交
    if (!Session.acquireAction('auth-submit')) {
        Session.toast('正在验证，请勿重复提交', 'warning');
        return;
    }

    setAuthSubmitting(true);
    showLoading('验证身份...');
    authError.textContent = '';

    try {
        const result = await Session.login(username, password);
        // 令牌已替换，旧代际请求全部作废，立即按新会话渲染
        renderUserBar();
        renderFileList();

        const resumeFileId = pendingDownloadFileId;
        closeAuthModal();

        if (resumeFileId) {
            // 原有兼容流程：验证完成后自动跳转下载
            try {
                await performDownload(resumeFileId);
            } catch (err) {
                if (err instanceof Session.SessionError && err.type === 'AUTH_REQUIRED') {
                    openAuthModal('download', resumeFileId);
                } else {
                    Session.toast(err.message || '下载失败', 'error');
                }
            }
        } else {
            Session.toast(`欢迎回来，${result.username}`, 'success');
        }
    } catch (error) {
        authError.textContent = error.message || '验证失败，请检查账号密码';
    } finally {
        setAuthSubmitting(false);
        hideLoading();
        Session.releaseAction('auth-submit');
    }
});

// ---------- 主动退出 / 续期 / 重新登录 ----------
document.getElementById('logoutBtn').addEventListener('click', () => {
    Session.runProtected('logout', async () => {
        showLoading('正在退出...');
        try {
            await Session.logout(); // 本地立即收权 + 服务端作废
            cachedFiles = cachedFiles; // 文件列表保留，仅重渲染权限入口
            renderUserBar();
            renderFileList();
            closeAuthModal();
            closeShareModal();
            Session.toast('已退出登录', 'success');
        } finally {
            hideLoading();
        }
    });
});

document.getElementById('renewBtn').addEventListener('click', () => {
    Session.runProtected('renew-session', async () => {
        showLoading('正在延长登录...');
        try {
            await Session.renew();
            renderUserBar();
            Session.toast('登录有效期已延长', 'success');
        } finally {
            hideLoading();
        }
    }, {
        onAuthRequired: () => openAuthModal('relogin')
    });
});

document.getElementById('reloginBtn').addEventListener('click', () => openAuthModal('relogin'));

// ---------- 分享设置弹窗 ----------
function openShareModal(fileId, fileName) {
    // 进入受保护弹窗前再做一次统一状态判断
    if (!Session.isUsable()) {
        openAuthModal('relogin');
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

async function confirmCreateShare() {
    const fileId = currentShareFileId;
    if (!fileId) return;

    await Session.runProtected('create-share', async () => {
        const expireHours = parseInt(document.getElementById('expireHours').value);
        const maxDownloads = parseInt(document.getElementById('maxDownloads').value);
        const shareError = document.getElementById('shareError');
        shareError.textContent = '';

        showLoading('生成分享链接...');
        try {
            const result = await Session.authJson(`${API_BASE}/share`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    expire_hours: expireHours,
                    max_downloads: maxDownloads
                })
            });

            closeShareModal();
            showShareSuccessModal(result);
            sharesLoadedForToken = null;
            loadMyShares();
        } catch (err) {
            if (err instanceof Session.SessionError && err.type === 'HTTP_ERROR') {
                shareError.textContent = err.message;
            }
            // AUTH_REQUIRED / OFFLINE 由 runProtected 统一提示
            throw err;
        } finally {
            hideLoading();
        }
    }, {
        // 会话在填写过程中失效：立即收回弹窗并要求重新登录
        onAuthRequired: () => {
            closeShareModal();
            openAuthModal('relogin');
        }
    });
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
        copyBtnText.textContent = '已复制';
        copyBtn.classList.add('copied');

        setTimeout(() => {
            copyBtnText.textContent = '复制';
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (error) {
        linkInput.select();
        document.execCommand('copy');
        copyBtnText.textContent = '已复制';
        copyBtn.classList.add('copied');

        setTimeout(() => {
            copyBtnText.textContent = '复制';
            copyBtn.classList.remove('copied');
        }, 2000);
    }
}

// ---------- 我的分享 ----------
async function loadMyShares() {
    if (!Session.isUsable()) {
        hideMyShares();
        return;
    }

    // 同一令牌只加载一次，避免状态抖动触发重复请求
    if (sharesLoadedForToken === Session.getToken()) {
        document.getElementById('mySharesSection').style.display = 'block';
        return;
    }
    sharesLoadedForToken = Session.getToken();
    document.getElementById('mySharesSection').style.display = 'block';

    try {
        const shares = await Session.authJson(`${API_BASE}/shares`);
        renderMyShares(shares);
    } catch (error) {
        sharesLoadedForToken = null;
        if (error instanceof Session.SessionError && error.type === 'AUTH_REQUIRED') {
            hideMyShares(); // 已由状态机收权
        } else {
            document.getElementById('mySharesList').innerHTML =
                `<p class="empty-msg">加载失败: ${escapeHtml(error.message)}</p>`;
        }
    }
}

function renderMyShares(shares) {
    const list = document.getElementById('mySharesList');

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
}

async function copyShareLinkFromList(shareId) {
    const link = `${window.location.origin}/share.html#${shareId}`;
    try {
        await navigator.clipboard.writeText(link);
        Session.toast('分享链接已复制到剪贴板', 'success');
    } catch (error) {
        window.prompt('请手动复制链接:', link);
    }
}

async function deleteShare(shareId) {
    if (!window.confirm('确定要删除此分享链接吗？删除后链接将立即失效。')) {
        return;
    }

    await Session.runProtected(`delete-share:${shareId}`, async () => {
        showLoading('删除中...');
        try {
            await Session.authJson(`${API_BASE}/share/${shareId}`, { method: 'DELETE' });
            sharesLoadedForToken = null;
            loadMyShares();
            Session.toast('分享链接已删除', 'success');
        } finally {
            hideLoading();
        }
    }, {
        onAuthRequired: () => openAuthModal('relogin')
    });
}

// ---------- 页面初始化（重新进入：统一 RESTORING 复核）----------
document.addEventListener('DOMContentLoaded', async () => {
    // 先按当前状态渲染（存在本地凭据时即为 RESTORING，敏感入口不提前露出）
    renderUserBar();
    renderFileList();
    loadFileList();

    if (Session.getToken()) {
        await Session.restore();
        renderUserBar();
        renderFileList();
    }
});
