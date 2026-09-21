"""认证路由"""
import time
import logging
from flask import request, jsonify
from routes import auth_bp
from auth import (
    rate_limit,
    generate_token,
    get_token_info,
    revoke_token,
    refresh_token as do_refresh_token,
    authenticate_user,
)

logger = logging.getLogger(__name__)


def extract_token():
    """从 Authorization 头或查询参数中提取 token（查询参数仅为向后兼容）"""
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:].strip()
    token = request.args.get('token')
    return token.strip() if token else None


@auth_bp.route('/api/auth', methods=['POST'])
@rate_limit
def authenticate():
    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'error': '无效的请求数据'}), 400

    username = data.get('username', '').strip()
    password = data.get('password', '')

    if not username or not password:
        return jsonify({'success': False, 'error': '用户名和密码不能为空'}), 400

    if len(username) > 50 or len(password) > 100:
        return jsonify({'success': False, 'error': '输入长度超出限制'}), 400

    if authenticate_user(username, password):
        token, expires_at = generate_token(username)
        logger.info(f"用户认证成功: {username}")
        return jsonify({
            'success': True,
            'token': token,
            'username': username,
            'expires_at': expires_at
        })

    logger.warning(f"用户认证失败: {username}")
    time.sleep(0.5)
    return jsonify({'success': False, 'error': '用户名或密码错误'}), 401


@auth_bp.route('/api/session', methods=['GET'])
def session_status():
    """只读查询当前会话状态（不续期），供页面重新进入时统一判定"""
    token = extract_token()
    username, expires_at = get_token_info(token)

    if not username:
        return jsonify({'authenticated': False, 'error': '未授权或token已过期'}), 401

    return jsonify({
        'authenticated': True,
        'username': username,
        'expires_at': expires_at
    })


@auth_bp.route('/api/refresh-token', methods=['POST'])
def refresh_token_endpoint():
    token = extract_token()

    if not token:
        return jsonify({'error': '缺少token'}), 400

    new_expires = do_refresh_token(token)
    if new_expires:
        return jsonify({'success': True, 'message': 'Token已刷新', 'expires_at': new_expires})

    return jsonify({'error': 'Token无效或已过期'}), 401


@auth_bp.route('/api/logout', methods=['POST'])
def logout():
    """主动退出：服务端立即作废令牌，幂等，始终返回成功"""
    token = extract_token()
    if token:
        revoke_token(token)
    return jsonify({'success': True, 'message': '已退出登录'})
