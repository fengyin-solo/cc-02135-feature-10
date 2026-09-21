/**
 * SessionManager —— 登录会话生命周期的唯一事实源
 *
 * 状态流转：
 *   RESTORING  页面加载 / 切页回来时，正在用服务端重新校验本地凭据
 *     ├─ ACTIVE    有效
 *     │    └─ EXPIRING   即将失效（剩余时间 <= WARN_BEFORE_MS），可显式续期
 *     │          ├─ ACTIVE      续期成功（令牌不变，过期时间被替换）
 *     │          └─ EXPIRED     到期或被服务端拒绝（401）
 *     ├─ LOGGED_OUT  本地无凭据 / 主动退出
 *     └─ OFFLINE    网络中断：不判定失效、不清除凭据、不跳变，恢复后重新校验
 *
 * 所有受保护操作必须经 withSession() 门禁；所有带凭据请求必须走 authedFetch()，
 * 由它集中处理 401 吊销，杜绝“已失效会话仍残留敏感入口”。
 */
(function (global) {
    'use strict';

    const STATE = {
        RESTORING: 'RESTORING',
        ACTIVE: 'ACTIVE',
        EXPIRING: 'EXPIRING',
        EXPIRED: 'EXPIRED',
        LOGGED_OUT: 'LOGGED_OUT',
        OFFLINE: 'OFFLINE'
    };

    const TOKEN_KEY = 'auth_token';
    const USER_KEY = 'auth_user';
    const EXPIRES_KEY = 'auth_expires_at';
    // 本地存储格式版本标记，便于与历史版本（只存 token/user）区分
    const SCHEMA_KEY = 'auth_schema';
    const SCHEMA_VERSION = '2';
    // 提前多久进入“即将失效”；若会话本身更短则取一半
    const WARN_BEFORE_MS = 60 * 1000;

    const listeners = new Set();
    const tickListeners = new Set();

    const session = {
        state: STATE.LOGGED_OUT,
        user: null,
        token: null,
        expiresAt: null,      // 本地时钟口径的到期毫秒时间戳
        serverNow: null,      // 最近一次服务端时间（秒）
        clockOffsetMs: 0,     // 服务端时间 - 本地时间
        reason: null          // EXPIRED: 'expired' | 'replaced'；OFFLINE: 'network'
    };

    let restoringPromise = null;
    let renewingPromise = null;
    let tickTimer = null;
    let lastRestoreAt = 0;

    /* ---------------- 存储层（与旧版取件/分享页写入格式兼容） ---------------- */

    function readStored() {
        const token = localStorage.getItem(TOKEN_KEY);
        const user = localStorage.getItem(USER_KEY);
        const rawExp = localStorage.getItem(EXPIRES_KEY);
        const expiresAt = rawExp ? Number(rawExp) : null;
        return {
            token,
            user,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
        };
    }

    function persist(token, user, expiresAt) {
        // 先写过期时间再写 token，保证跨标签页 storage 事件观察到 token 时数据已完整
        if (expiresAt != null) localStorage.setItem(EXPIRES_KEY, String(expiresAt));
        localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION);
        if (user != null) localStorage.setItem(USER_KEY, user);
        localStorage.setItem(TOKEN_KEY, token);
    }

    function wipeStorage() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(EXPIRES_KEY);
        localStorage.removeItem(SCHEMA_KEY);
    }

    /* ---------------- 事件订阅 ---------------- */

    function emit() {
        listeners.forEach(fn => {
            try { fn(snapshot()); } catch (e) { console.error('session listener error:', e); }
        });
    }

    function emitTick() {
        tickListeners.forEach(fn => {
            try { fn(snapshot()); } catch (e) { console.error('session tick listener error:', e); }
        });
    }

    function setState(next, patch) {
        if (
            session.state === next &&
            (!patch || Object.keys(patch).every(k => session[k] === patch[k]))
        ) {
            return;
        }
        session.state = next;
        if (patch) Object.assign(session, patch);
        updateTickTimer();
        emit();
    }

    function snapshot() {
        return {
            state: session.state,
            user: session.user,
            token: session.token,
            expiresAt: session.expiresAt,
            reason: session.reason,
            remainingMs: session.expiresAt ? Math.max(0, session.expiresAt - Date.now()) : null
        };
    }

    /* ---------------- 倒计时（仅 ACTIVE/EXPIRING/OFFLINE 保留有效凭据时运转） ---------------- */

    function updateTickTimer() {
        const needsTick = (session.state === STATE.ACTIVE || session.state === STATE.EXPIRING)
            && session.expiresAt != null;
        if (needsTick && !tickTimer) {
            tickTimer = setInterval(tick, 1000);
        } else if (!needsTick && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    function tick() {
        if (session.expiresAt == null) return;
        const remainingMs = session.expiresAt - Date.now();

        if (remainingMs <= 0) {
            // 本地计时到期：立即收回并切到已失效，下一次操作由服务端复核
            clearSessionLocally(STATE.EXPIRED, { reason: 'expired' });
            return;
        }

        const warnMs = Math.min(WARN_BEFORE_MS, estimatedMaxAgeMs() / 2);
        if (session.state === STATE.ACTIVE && remainingMs <= warnMs) {
            setState(STATE.EXPIRING);
            return;
        }
        emitTick();
    }

    function estimatedMaxAgeMs() {
        // 登录/续期成功后 max_age 为 300s；用 expiresAt 与当时本地时间反推更稳妥
        return session.expiresAt && session.serverNow
            ? (session.expiresAt - (session.serverNow * 1000 - session.clockOffsetMs))
            : 5 * 60 * 1000;
    }

    /* ---------------- 网络层 ---------------- */

    function isNetworkError(err) {
        // fetch 在断网/DNS/连接失败时抛 TypeError；AbortError 单独区分
        return err instanceof TypeError;
    }

    async function fetchSession(method, body) {
        const options = {
            method,
            headers: {}
        };
        if (session.token) options.headers['Authorization'] = `Bearer ${session.token}`;
        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const res = await fetch(`${CONFIG.API_BASE}/session`, options);
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        return { res, data };
    }

    /* ---------------- 服务端会话信息 -> 本地状态 ---------------- */

    function applySessionInfo(info) {
        // info: { username, expires_at(秒), server_time(秒) }
        const serverTimeMs = info.server_time * 1000;
        const localNow = Date.now();
        const clockOffsetMs = serverTimeMs - localNow;
        const expiresAt = info.expires_at * 1000 + clockOffsetMs;

        session.token = session.token || readStored().token;
        session.user = info.username;
        session.expiresAt = expiresAt;
        session.serverNow = info.server_time;
        session.clockOffsetMs = clockOffsetMs;
        session.reason = null;

        const remainingMs = expiresAt - localNow;
        if (remainingMs <= 0) {
            clearSessionLocally(STATE.EXPIRED, { reason: 'expired' });
            return;
        }
        const warnMs = Math.min(WARN_BEFORE_MS, (info.max_age ? info.max_age * 1000 : 5 * 60 * 1000) / 2);
        setState(remainingMs <= warnMs ? STATE.EXPIRING : STATE.ACTIVE);
    }

    function clearSessionLocally(state, extra) {
        const keepOffline = state === STATE.OFFLINE;
        if (!keepOffline) {
            session.token = null;
            session.user = null;
            session.expiresAt = null;
            session.serverNow = null;
            wipeStorage();
        }
        setState(state, Object.assign({ reason: null }, extra || {}));
    }

    /* ---------------- 生命周期动作 ---------------- */

    /**
     * 重新进入页面 / 切换标签页回来：用本地凭据向服务端复核（只查不续期）。
     * 网络中断时保留凭据进入 OFFLINE，绝不误清除。
     */
    async function restore() {
        if (restoringPromise) return restoringPromise;

        const stored = readStored();
        if (!stored.token) {
            session.token = null;
            session.user = null;
            session.expiresAt = null;
            setState(STATE.LOGGED_OUT);
            return snapshot();
        }

        setState(STATE.RESTORING);
        session.token = stored.token;
        session.user = stored.user;

        restoringPromise = (async () => {
            try {
                const { res, data } = await fetchSession('GET');
                if (res.ok && data && data.authenticated) {
                    applySessionInfo(data);
                    // 旧版本页面写入的记录没有 expiresAt，或本地记录与服务端不一致时补全
                    if (stored.expiresAt == null || localStorage.getItem(TOKEN_KEY) !== session.token) {
                        persist(session.token, session.user, session.expiresAt);
                    }
                } else if (res.status === 401) {
                    clearSessionLocally(STATE.EXPIRED, { reason: 'expired' });
                } else {
                    // 服务端其他异常按网络问题处理，不判定失效
                    clearSessionLocally(STATE.OFFLINE, { reason: 'network' });
                }
            } catch (err) {
                if (isNetworkError(err)) {
                    // 离线：沿用本地已存的过期时间继续倒计时，状态冻结不跳变
                    session.expiresAt = stored.expiresAt;
                    session.user = stored.user;
                    session.token = stored.token;
                    setState(STATE.OFFLINE, { reason: 'network' });
                } else {
                    throw err;
                }
            } finally {
                restoringPromise = null;
            }
            return snapshot();
        })();

        return restoringPromise;
    }

    /** 登录：令牌被新凭据替换，旧状态整体覆盖，不残留 */
    async function login(username, password) {
        const res = await fetch(`${CONFIG.API_BASE}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => null);

        if (!res.ok || !data || !data.success) {
            const error = new Error((data && data.error) || '登录失败');
            error.status = res.status;
            throw error;
        }

        const clockOffsetMs = data.server_time * 1000 - Date.now();
        const expiresAt = data.expires_at * 1000 + clockOffsetMs;
        session.token = data.token;
        session.user = data.username || username;
        session.expiresAt = expiresAt;
        session.serverNow = data.server_time;
        session.clockOffsetMs = clockOffsetMs;
        session.reason = null;
        persist(data.token, session.user, expiresAt);

        const warnMs = Math.min(WARN_BEFORE_MS, (data.max_age || 5 * 60) * 1000 / 2);
        setState(expiresAt - Date.now() <= warnMs ? STATE.EXPIRING : STATE.ACTIVE);
        return snapshot();
    }

    /** 显式续期（即将失效时点击“继续保持登录”），in-flight 去重 */
    async function renew() {
        if (renewingPromise) return renewingPromise;
        if (!session.token) throw new Error('未登录');

        renewingPromise = (async () => {
            try {
                const res = await fetch(`${CONFIG.API_BASE}/refresh-token`, { method: 'POST',
                    headers: { 'Authorization': `Bearer ${session.token}` } });
                const data = await res.json().catch(() => null);
                if (res.ok && data && data.success !== false && data.expires_at) {
                    const clockOffsetMs = data.server_time * 1000 - Date.now();
                    const expiresAt = data.expires_at * 1000 + clockOffsetMs;
                    session.expiresAt = expiresAt;
                    session.serverNow = data.server_time;
                    session.clockOffsetMs = clockOffsetMs;
                    session.reason = null;
                    persist(session.token, session.user, expiresAt);
                    setState(STATE.ACTIVE);
                    return snapshot();
                }
                if (res.status === 401) {
                    clearSessionLocally(STATE.EXPIRED, { reason: 'expired' });
                    const err = new Error('登录已过期，请重新验证');
                    err.status = 401;
                    throw err;
                }
                throw new Error((data && data.error) || '续期失败，请稍后再试');
            } finally {
                renewingPromise = null;
            }
        })();
        return renewingPromise;
    }

    /** 主动退出：先立即收回本地敏感入口，再幂等通知服务端撤销 */
    async function logout() {
        const token = session.token || readStored().token;
        clearSessionLocally(STATE.LOGGED_OUT);
        if (!token) return snapshot();
        try {
            await fetch(`${CONFIG.API_BASE}/session`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        } catch (err) {
            // 网络问题不影响退出结果：本地凭据已收回，服务端 token 也会自然过期
            console.warn('注销请求未送达，本地已退出:', err.message);
        }
        return snapshot();
    }

    /**
     * 带凭据请求：自动附带 token；遇到 401 统一吊销本地会话并抛出 SessionExpiredError，
     * 网络中断抛 NetworkOfflineError。调用方不再各自判断 token。
     */
    async function authedFetch(url, options) {
        if (!session.token) {
            const err = new Error('未登录');
            err.name = 'SessionExpiredError';
            err.status = 401;
            throw err;
        }
        const opts = Object.assign({}, options);
        opts.headers = Object.assign({}, options && options.headers, {
            'Authorization': `Bearer ${session.token}`
        });

        let res;
        try {
            res = await fetch(url, opts);
        } catch (err) {
            if (isNetworkError(err)) {
                if (session.state !== STATE.OFFLINE) {
                    setState(STATE.OFFLINE, { reason: 'network' });
                }
                const netErr = new Error('网络连接中断，请检查网络后重试');
                netErr.name = 'NetworkOfflineError';
                throw netErr;
            }
            throw err;
        }

        if (res.status === 401) {
            clearSessionLocally(STATE.EXPIRED, { reason: 'expired' });
            const err = new Error('登录已过期，请重新验证');
            err.name = 'SessionExpiredError';
            err.status = 401;
            err.response = res;
            throw err;
        }
        return res;
    }

    /* ---------------- 跨页 / 切页事件 ---------------- */

    // 跨标签页：其他标签页登录、退出、续期时同步，令牌被替换则本页立即收回敏感入口
    window.addEventListener('storage', (e) => {
        if (![TOKEN_KEY, USER_KEY, EXPIRES_KEY].includes(e.key)) return;
        const stored = readStored();

        if (!stored.token) {
            // 另一标签页主动退出或会话失效
            clearSessionLocally(STATE.LOGGED_OUT);
            return;
        }

        if (stored.token !== session.token) {
            // 令牌被另一个标签页替换（或本页无会话而另一标签页完成登录）：
            // 不能 wipeStorage（共享存储属于新会话），只清内存态再以新凭据复核
            session.token = null;
            session.user = null;
            session.expiresAt = null;
            setState(STATE.RESTORING, { reason: 'replaced' });
            restore();
            return;
        }

        // 同一令牌的过期时间被刷新（其他标签页续期成功）
        if (stored.token === session.token && stored.expiresAt != null) {
            session.expiresAt = stored.expiresAt;
            session.user = stored.user;
            session.reason = null;
            const remainingMs = stored.expiresAt - Date.now();
            const warnMs = Math.min(WARN_BEFORE_MS, estimatedMaxAgeMs() / 2);
            setState(remainingMs <= 0 ? STATE.EXPIRED
                : (remainingMs <= warnMs ? STATE.EXPIRING : STATE.ACTIVE));
        }
    });

    // 切回本标签页：短间隔内不重复复核（RESTORING 自身也去重）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - lastRestoreAt < 5000) return;
        lastRestoreAt = now;
        if (session.state === STATE.OFFLINE || readStored().token) restore();
    });

    window.addEventListener('online', () => {
        if (session.state === STATE.OFFLINE) restore();
    });

    window.addEventListener('offline', () => {
        if (session.state === STATE.ACTIVE || session.state === STATE.EXPIRING) {
            setState(STATE.OFFLINE, { reason: 'network' });
        }
    });

    /* ---------------- 对外 API ---------------- */

    global.SessionManager = {
        STATE,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        onTick(fn) { tickListeners.add(fn); return () => tickListeners.delete(fn); },
        getState: snapshot,
        isAuthenticated() {
            return session.state === STATE.ACTIVE || session.state === STATE.EXPIRING;
        },
        hasAccess() {
            // UI 口径：ACTIVE/EXPIRING 正常放行；OFFLINE 时凭据仍在，界面冻结保留入口，
            // 真正的权限由操作发起时的门禁与服务端兜底
            return this.isAuthenticated()
                || (session.state === STATE.OFFLINE && !!session.token);
        },
        restore,
        login,
        renew,
        logout,
        authedFetch
    };
})(window);
