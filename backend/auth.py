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
    """生成并存储token。

    同一用户重新登录时旧令牌立即撤销（令牌替换不留残余会话），
    数据库中每个用户至多保留一条有效 token。
    """
    token = str(uuid.uuid4())
    expires_at = time.time() + TOKEN_EXPIRE_SECONDS

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM tokens WHERE username = ?', (username,))
    cursor.execute(
        'INSERT INTO tokens (token, username, expires_at) VALUES (?, ?, ?)',
        (token, username, expires_at)
    )
    conn.commit()
    conn.close()
    return token


def verify_token(token):
    """验证token"""
    return get_token_info(token) is not None


def get_token_info(token):
    """返回有效 token 的 (username, expires_at)，无效或已过期返回 None。

    过期的 token 记录会被立即删除，保证失效会话第一时间被收回。
    """
    if not token:
        return None

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
    return None


def revoke_token(token):
    """主动撤销 token（退出登录），幂等"""
    if not token:
        return
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM tokens WHERE token = ?', (token,))
    conn.commit()
    conn.close()


def extract_token():
    """从请求中提取 token：优先 Authorization 头，兼容查询参数"""
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:].strip()
    return request.args.get('token')


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
    info = get_token_info(token)
    return info[0] if info else None


def login_required(f):
    """登录认证装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = extract_token()

        if not verify_token(token):
            return jsonify({'error': '未授权或token已过期'}), 401

        return f(*args, **kwargs)
    return decorated_function
