/**
 * Session —— 登录会话生命周期统一状态机
 *
 * 五种状态：
 *   LOGGED_OUT 已退出：无本地凭据
 *   RESTORING  重新进入：存在本地凭据，正在向服务器复核
 *   ACTIVE     有效：服务器已确认，且未进入临期窗口
 *   EXPIRING   即将失效：本地有效期进入临期窗口（可续期）
 *   EXPIRED    已失效：本地到期或被服务器拒绝（401），敏感入口立即收回
 *
 * 统一规则：
 *   1. 状态判断唯一来源：Session.state（由本地到期时间 + 服务器裁决共同维护）
 *   2. 受保护操作统一走 Session.runProtected（状态判断 → 交互反馈 → 权限校验）
 *   3. 令牌替换用 generation 代际号隔离，在途旧请求结果一律作废，状态不跳变/残留
 *   4. 网络中断不判定为失效；恢复在线或标签重新可见时统一走 RESTORING 复核
 *   5. 跨标签页登录/退出通过 storage 事件同步
 */
const Session = (() => {
    const API = CONFIG.API_BASE;

    const STATE = {
        LOGGED_OUT: 'LOGGED_OUT',
        RESTORING: 'RESTORING',
        ACTIVE: 'ACTIVE',
        EXPIRING: 'EXPIRING',
        EXPIRED: 'EXPIRED'
    };

    const KEY_TOKEN = 'auth_token';
    const KEY_USER = 'auth_user';
    const KEY_EXPIRES = 'auth_expires_at';

    // 距到期多久视为“即将失效”
    const EXPIRING_WINDOW_MS = 60 * 1000;
    const TICK_MS = 1000;

    // 自定义错误
    class SessionError extends Error {
        constructor(type, message) {
            super(message);
            this.name = 'SessionError';
            this.type = type; // AUTH_REQUIRED | OFFLINE | HTTP_ERROR | ABORTED
        }
    }

    // ---- 单一状态源 ----
    let state = localStorage.getItem(KEY_TOKEN) ? STATE.RESTORING : STATE.LOGGED_OUT;
    let token = localStorage.getItem(KEY_TOKEN);
    let username = localStorage.getItem(KEY_USER);
    let expiresAt = readStoredExpiry();

    let generation = 0;              // 令牌代际：每次替换/作废递增
    let restoring = null;            // 在途复核 Promise（去重，防并发）
    let renewing = null;             // 在途续期 Promise
    const actionLocks = new Set();   // 动作锁：防重复点击
    const listeners = new Set();    // 状态订阅者

    function readStoredExpiry() {
        const raw = localStorage.getItem(KEY_EXPIRES);
        const n = raw ? Number(raw) : NaN;
        return Number.isFinite(n) ? n : null;
    }

    function nowMs() {
        return Date.now();
    }

    // 依据本地到期时间推导状态（不作废已有状态，仅在 ACTIVE/EXPIRING/EXPIRED 间推导）
    function localState() {
        if (!token) return STATE.LOGGED_OUT;
        if (!expiresAt) return STATE.ACTIVE; // 旧版本凭据没有到期记录，交由服务器复核
        const remaining = expiresAt - nowMs();
        if (remaining <= 0) return STATE.EXPIRED;
        if (remaining <= EXPIRING_WINDOW_MS) return STATE.EXPIRING;
        return STATE.ACTIVE;
    }

    function setState(next) {
        if (next === state) return;
        const prev = state;
        state = next;
        listeners.forEach(fn => {
            try { fn(state, prev); } catch (e) { console.error('session listener error', e); }
        });
    }

    // ---- 持久化 ----
    function persist(nextToken, nextUser, nextExpires) {
        token = nextToken;
        username = nextUser;
        expiresAt = nextExpires;
        if (nextToken) {
            localStorage.setItem(KEY_TOKEN, nextToken);
            localStorage.setItem(KEY_USER, nextUser || '');
            if (nextExpires) localStorage.setItem(KEY_EXPIRES, String(nextExpires));
            else localStorage.removeItem(KEY_EXPIRES);
        } else {
            localStorage.removeItem(KEY_TOKEN);
            localStorage.removeItem(KEY_USER);
            localStorage.removeItem(KEY_EXPIRES);
        }
    }

    // ---- 对外只读访问 ----
    function getState() { return state; }
    function getToken() { return token; }
    function getUser() { return username; }
    function getExpiresAt() { return expiresAt; }
    function isUsable() { return state === STATE.ACTIVE || state === STATE.EXPIRING; }
    function remainingMs() { return expiresAt ? Math.max(0, expiresAt - nowMs()) : null; }

    // 已失效：立即收回敏感入口（本地清空，UI 订阅者同步隐藏）
    function hardExpire(reason) {
        generation++;
        restoring = null;
        renewing = null;
        persist(null, null, null);
        setState(STATE.EXPIRED);
        if (reason) console.info(`会话已失效：${reason}`);
    }

    // ---- 服务器复核（只读 /api/session，不续期）----
    async function restore() {
        if (!token) {
            setState(STATE.LOGGED_OUT);
            return false;
        }
        // 本地已到期无需请求，立即收权
        if (expiresAt && expiresAt - nowMs() <= 0) {
            hardExpire('本地已到期');
            return false;
        }
        if (restoring) return restoring;

        setState(STATE.RESTORING);
        const gen = generation;
        const seenToken = token;

        restoring = (async () => {
            try {
                const res = await fetch(`${API}/session`, {
                    headers: { 'Authorization': `Bearer ${seenToken}` }
                });
                // 代际隔离：在途期间令牌被替换/作废，结果一律丢弃
                if (gen !== generation || seenToken !== token) return false;

                if (res.status === 401) {
                    hardExpire('服务器拒绝凭据');
                    return false;
                }
                if (!res.ok) throw new Error(`session ${res.status}`);

                const data = await res.json();
                if (gen !== generation || seenToken !== token) return false;

                if (data.authenticated) {
                    username = data.username || username;
                    localStorage.setItem(KEY_USER, username);
                    if (data.expires_at) {
                        expiresAt = data.expires_at * 1000;
                        localStorage.setItem(KEY_EXPIRES, String(expiresAt));
                    }
                    setState(localState());
                    return true;
                }
                hardExpire('服务器返回未认证');
                return false;
            } catch (err) {
                // 网络中断：不判定失效，保留会话，按本地到期时间展示
                if (gen !== generation || seenToken !== token) return false;
                setState(localState());
                return isUsable();
            } finally {
                if (gen === generation) restoring = null;
            }
        })();

        return restoring;
    }

    // ---- 主动续期（即将失效时）----
    async function renew() {
        if (!token) throw new SessionError('AUTH_REQUIRED', '登录状态已失效，请重新登录');
        if (!navigator.onLine) throw new SessionError('OFFLINE', '网络已断开，请恢复网络后重试');
        if (renewing) return renewing;

        const gen = generation;
        const seenToken = token;
        renewing = (async () => {
            try {
                const res = await fetch(`${API}/refresh-token`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${seenToken}` }
                });
                if (gen !== generation || seenToken !== token) {
                    throw new SessionError('ABORTED', '会话已变更');
                }
                if (res.status === 401) {
                    hardExpire('续期时服务器拒绝凭据');
                    throw new SessionError('AUTH_REQUIRED', '登录状态已失效，请重新登录');
                }
                if (!res.ok) throw new Error(`refresh ${res.status}`);

                const data = await res.json();
                if (data.expires_at) {
                    expiresAt = data.expires_at * 1000;
                    localStorage.setItem(KEY_EXPIRES, String(expiresAt));
                }
                setState(localState());
                return true;
            } catch (err) {
                if (err instanceof SessionError) throw err;
                throw new SessionError('OFFLINE', '网络异常，暂时无法续期');
            } finally {
                if (gen === generation) renewing = null;
            }
        })();
        return renewing;
    }

    // ---- 登录（令牌替换：旧代际全部作废，状态不残留）----
    async function login(usernameInput, password) {
        const res = await fetch(`${API}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: usernameInput, password })
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 429) {
            throw new SessionError('HTTP_ERROR', '请求过于频繁，请稍后再试');
        }
        if (!res.ok || !data.success || !data.token) {
            throw new SessionError('HTTP_ERROR', data.error || '验证失败，请检查账号密码');
        }

        // 用新令牌替换：旧在途请求代际失效
        generation++;
        restoring = null;
        renewing = null;
        const nextExpires = data.expires_at ? data.expires_at * 1000 : null;
        persist(data.token, data.username || usernameInput, nextExpires);
        setState(localState());
        return { token: data.token, username: data.username || usernameInput };
    }

    // ---- 主动退出：先本地立即收权，再尽力通知服务端作废 ----
    async function logout() {
        const seenToken = token;
        hardExpire('用户主动退出');
        setState(STATE.LOGGED_OUT);
        if (seenToken) {
            try {
                await fetch(`${API}/logout`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${seenToken}` }
                });
            } catch { /* 本地已收权，服务端令牌会自然过期 */ }
        }
    }

    /**
     * 受保护操作的统一入口管道：
     *   状态判断 → 交互反馈（toast）→ 权限校验/续期/恢复 → 返回可用令牌
     * 调用方只需在拿到 token 后发起真正的业务请求。
     */
    async function ensureUsable() {
        if (!navigator.onLine) {
            throw new SessionError('OFFLINE', '网络已断开，请检查网络连接后重试');
        }

        switch (state) {
            case STATE.ACTIVE:
                return token;

            case STATE.EXPIRING:
                await renew(); // 失败会抛出 AUTH_REQUIRED / OFFLINE
                return token;

            case STATE.RESTORING: {
                const ok = await restore();
                if (!ok) {
                    if (!navigator.onLine) {
                        throw new SessionError('OFFLINE', '网络已断开，请检查网络连接后重试');
                    }
                    throw new SessionError('AUTH_REQUIRED', '登录状态已失效，请重新登录');
                }
                return token;
            }

            case STATE.EXPIRED:
                throw new SessionError('AUTH_REQUIRED', '登录状态已失效，请重新登录');

            case STATE.LOGGED_OUT:
            default:
                throw new SessionError('AUTH_REQUIRED', '请先登录');
        }
    }

    // 统一业务响应处理：401 立即收权；网络错误不误伤会话
    async function handleResponse(res) {
        if (res.status === 401) {
            hardExpire('操作被服务器拒绝（401）');
            throw new SessionError('AUTH_REQUIRED', '登录状态已失效，请重新登录');
        }
        if (!res.ok) {
            let message = `请求失败（${res.status}）`;
            try {
                const data = await res.json();
                if (data && data.error) message = data.error;
            } catch { /* 非 JSON 错误体 */ }
            throw new SessionError('HTTP_ERROR', message);
        }
        return res;
    }

    /**
     * 带身份的请求封装：自动附加当前代际令牌，统一处理 401/断网/令牌替换。
     * 返回 Response；调用方负责业务数据解析。
     */
    async function authFetch(url, options = {}) {
        const activeToken = await ensureUsable();
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${activeToken}`);

        let res;
        try {
            res = await fetch(url, { ...options, headers });
        } catch (err) {
            if (!navigator.onLine) {
                throw new SessionError('OFFLINE', '网络已中断，操作未完成，请稍后重试');
            }
            throw new SessionError('OFFLINE', `网络异常：${err.message}`);
        }
        return handleResponse(res);
    }

    // JSON 便捷封装
    async function authJson(url, options = {}) {
        const res = await authFetch(url, options);
        return res.json();
    }

    // 动作锁：同一动作重复点击直接拒绝
    function acquireAction(key) {
        if (actionLocks.has(key)) return false;
        actionLocks.add(key);
        return true;
    }
    function releaseAction(key) {
        actionLocks.delete(key);
    }

    /**
     * 受保护动作模板：动作锁 + 状态/反馈/校验管道 + 统一错误提示。
     * onAuthRequired 可自定义登录交互（如弹出登录框）。
     */
    async function runProtected(key, fn, opts = {}) {
        if (!acquireAction(key)) {
            toast('操作进行中，请勿重复点击', 'warning');
            return;
        }
        try {
            await fn();
        } catch (err) {
            if (err instanceof SessionError) {
                if (err.type === 'AUTH_REQUIRED' && opts.onAuthRequired) {
                    opts.onAuthRequired(err);
                } else if (err.type === 'OFFLINE') {
                    toast(err.message, 'error');
                } else {
                    toast(err.message, 'error');
                }
            } else {
                toast(err.message || '操作失败', 'error');
            }
        } finally {
            releaseAction(key);
        }
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // ---- 定时驱动：ACTIVE ↔ EXPIRING → EXPIRED 的本地状态流转 ----
    setInterval(() => {
        if (!token) return;
        const expected = localState();
        if (expected === STATE.EXPIRED && state !== STATE.EXPIRED) {
            hardExpire('本地到期');
        } else if (
            (state === STATE.ACTIVE && expected === STATE.EXPIRING) ||
            (state === STATE.EXPIRING && expected === STATE.ACTIVE)
        ) {
            setState(expected);
        }
    }, TICK_MS);

    // ---- 网络中断/恢复 ----
    window.addEventListener('online', () => {
        toast('网络已恢复', 'success');
        if (token) restore();
    });
    window.addEventListener('offline', () => {
        toast('网络已断开，当前登录状态已保留', 'warning');
    });

    // ---- 页面重新进入（标签切回）：统一走 RESTORING 复核 ----
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && token) restore();
    });

    // ---- 跨标签页：登录/退出/令牌替换同步 ----
    window.addEventListener('storage', (e) => {
        if (e.key !== KEY_TOKEN) return;
        const next = e.newValue;
        if (!next) {
            // 其他标签退出或失效
            if (token) {
                generation++;
                restoring = null;
                renewing = null;
                persist(null, null, null);
                setState(STATE.EXPIRED);
                toast('登录状态已在其他页面退出', 'warning');
            }
        } else if (next !== token) {
            // 其他标签登录（令牌替换）：以新令牌重新复核，旧代际作废
            generation++;
            restoring = null;
            renewing = null;
            token = next;
            username = localStorage.getItem(KEY_USER);
            expiresAt = readStoredExpiry();
            restore();
        }
    });

    // ---- 交互反馈：轻量 toast（不阻断流程）----
    function ensureToastContainer() {
        let box = document.getElementById('toastContainer');
        if (!box) {
            box = document.createElement('div');
            box.id = 'toastContainer';
            box.className = 'toast-container';
            document.body.appendChild(box);
        }
        return box;
    }

    function toast(message, type = 'info', duration = 3000) {
        const box = ensureToastContainer();
        const item = document.createElement('div');
        item.className = `toast toast-${type}`;
        const icon = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
        item.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg"></span>`;
        item.querySelector('.toast-msg').textContent = message;
        box.appendChild(item);
        requestAnimationFrame(() => item.classList.add('show'));
        setTimeout(() => {
            item.classList.remove('show');
            setTimeout(() => item.remove(), 300);
        }, duration);
    }

    // 统一确认框（替代 window.confirm，保持非阻塞风格一致）
    function confirmDialog(message) {
        return Promise.resolve(window.confirm(message));
    }

    return {
        STATE,
        EXPIRING_WINDOW_MS,
        getState,
        getToken,
        getUser,
        getExpiresAt,
        isUsable,
        remainingMs,
        restore,
        renew,
        login,
        logout,
        hardExpire,
        ensureUsable,
        authFetch,
        authJson,
        acquireAction,
        releaseAction,
        runProtected,
        subscribe,
        toast,
        confirmDialog,
        SessionError
    };
})();
