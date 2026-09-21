"""认证相关功能"""
import uuid
import time
import hashlib
from functools import wraps
from flask import request, jsonify
from database import get_db
from config import TOKEN_EXPIRE_SECONDS, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW

rate_limit_store = {}


def check_rate_limit(identifier):
    """检查速率限制"""
    current_time = time.time()
    if identifier not in rate_limit_store:
        rate_limit_store[identifier] = []

    rate_limit_store[identifier] = [
        t for t in rate_limit_store[identifier]
        if current_time - t < RATE_LIMIT_WINDOW
    ]

    if len(rate_limit_store[identifier]) >= RATE_LIMIT_REQUESTS:
        return False

    rate_limit_store[identifier].append(current_time)
    return True


def rate_limit(f):
    """速率限制装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        identifier = request.remote_addr
        if not check_rate_limit(identifier):
            return jsonify({'error': '请求过于频繁，请稍后再试'}), 429
        return f(*args, **kwargs)
    return decorated_function


def generate_token(username):
    """生成并存储token，返回 (token, expires_at)"""
    token = str(uuid.uuid4())
    expires_at = time.time() + TOKEN_EXPIRE_SECONDS

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'INSERT OR REPLACE INTO tokens (token, username, expires_at) VALUES (?, ?, ?)',
        (token, username, expires_at)
    )
    conn.commit()
    conn.close()
    return token, expires_at


def get_token_info(token):
    """查询令牌信息（只读，不续期）。

    返回 (username, expires_at)；令牌不存在或已过期时返回 (None, None)，
    过期令牌会被立即删除。
    """
    if not token:
        return None, None

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT username, expires_at FROM tokens WHERE token = ?', (token,))
    row = cursor.fetchone()

    if row and row['expires_at'] > time.time():
        conn.close()
        return row['username'], row['expires_at']

    if row:
        cursor.execute('DELETE FROM tokens WHERE token = ?', (token,))
        conn.commit()
    conn.close()
    return None, None


def revoke_token(token):
    """作废旧令牌（主动退出），幂等"""
    if not token:
        return
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM tokens WHERE token = ?', (token,))
    conn.commit()
    conn.close()


def verify_token(token):
    """验证token（只读校验，不续期）"""
    username, _ = get_token_info(token)
    return username is not None


def refresh_token(token):
    """刷新token过期时间，成功返回新的过期时间戳，失败返回 None"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT expires_at FROM tokens WHERE token = ?', (token,))
    row = cursor.fetchone()

    if row and row['expires_at'] > time.time():
        new_expires = time.time() + TOKEN_EXPIRE_SECONDS
        cursor.execute('UPDATE tokens SET expires_at = ? WHERE token = ?', (new_expires, token))
        conn.commit()
        conn.close()
        return new_expires
    conn.close()
    return None


def authenticate_user(username, password):
    """验证用户凭据"""
    password_hash = hashlib.sha256(password.encode()).hexdigest()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'SELECT id FROM users WHERE username = ? AND password_hash = ?',
        (username, password_hash)
    )
    user = cursor.fetchone()
    conn.close()
    return user is not None


def get_username_from_token(token):
    """从 token 获取用户名"""
    username, _ = get_token_info(token)
    return username


def login_required(f):
    """登录认证装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:]
        else:
            token = request.args.get('token')

        if not token or not verify_token(token):
            return jsonify({'error': '未授权或token已过期'}), 401

        return f(*args, **kwargs)
    return decorated_function
