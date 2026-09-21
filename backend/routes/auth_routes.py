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
    extract_token,
)
from config import TOKEN_EXPIRE_SECONDS

logger = logging.getLogger(__name__)


def session_payload(token, username, expires_at):
    """统一的会话信息响应，server_time 供前端消除时钟偏差"""
    return {
        'success': True,
        'token': token,
        'username': username,
        'expires_at': expires_at,
        'expires_in': max(0, int(expires_at - time.time())),
        'server_time': time.time(),
        'max_age': TOKEN_EXPIRE_SECONDS,
    }


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
        token = generate_token(username)
        info = get_token_info(token)
        logger.info(f"用户认证成功: {username}")
        return jsonify(session_payload(token, info[0], info[1]))

    logger.warning(f"用户认证失败: {username}")
    time.sleep(0.5)
    return jsonify({'success': False, 'error': '用户名或密码错误'}), 401


@auth_bp.route('/api/refresh-token', methods=['POST'])
def refresh_token_endpoint():
    """刷新 token（滑动续期），保留旧接口形态并补充会话字段"""
    token = extract_token()

    if not token:
        return jsonify({'error': '缺少token'}), 400

    new_expires = do_refresh_token(token)
    if new_expires is None:
        return jsonify({'error': 'Token无效或已过期'}), 401

    info = get_token_info(token)
    return jsonify(session_payload(token, info[0], info[1]))


@auth_bp.route('/api/session', methods=['GET'])
def get_session():
    """查询当前会话状态，只校验不续期，供页面加载/切页时统一判定"""
    token = extract_token()
    info = get_token_info(token) if token else None

    if not info:
        return jsonify({'authenticated': False, 'server_time': time.time()}), 401

    username, expires_at = info
    return jsonify({
        'authenticated': True,
        'username': username,
        'expires_at': expires_at,
        'expires_in': max(0, int(expires_at - time.time())),
        'server_time': time.time(),
        'max_age': TOKEN_EXPIRE_SECONDS,
    })


@auth_bp.route('/api/session', methods=['DELETE'])
def delete_session():
    """主动注销：服务端立即撤销 token，幂等"""
    token = extract_token()
    revoke_token(token)
    logger.info('用户主动退出登录')
    return jsonify({'success': True, 'message': '已退出登录'})
