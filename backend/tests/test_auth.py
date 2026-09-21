"""认证模块测试"""
import time


def test_auth_success(client):
    """测试登录成功"""
    response = client.post('/api/auth', json={
        'username': 'admin',
        'password': 'admin123'
    })
    assert response.status_code == 200
    data = response.get_json()
    assert data['success'] is True
    assert 'token' in data


def test_auth_wrong_password(client):
    """测试密码错误"""
    response = client.post('/api/auth', json={
        'username': 'admin',
        'password': 'wrongpassword'
    })
    assert response.status_code == 401
    data = response.get_json()
    assert data['success'] is False


def test_auth_empty_fields(client):
    """测试空字段"""
    response = client.post('/api/auth', json={
        'username': '',
        'password': ''
    })
    assert response.status_code == 400


def test_auth_missing_data(client):
    """测试缺少数据"""
    response = client.post('/api/auth', json={})
    assert response.status_code == 400


def test_refresh_token(client, auth_token):
    """测试刷新 token"""
    response = client.post(f'/api/refresh-token?token={auth_token}')
    assert response.status_code == 200
    data = response.get_json()
    assert data['success'] is True


def test_refresh_invalid_token(client):
    """测试刷新无效 token"""
    response = client.post('/api/refresh-token?token=invalid-token')
    assert response.status_code == 401


def test_login_returns_expires_at(client):
    """登录响应应包含过期时间，供前端统一状态判断"""
    response = client.post('/api/auth', json={
        'username': 'admin',
        'password': 'admin123'
    })
    data = response.get_json()
    assert 'expires_at' in data
    assert data['expires_at'] > time.time()
    assert data['username'] == 'admin'


def test_session_status_valid(client, auth_token):
    """有效令牌的会话查询返回认证信息且不续期"""
    before = client.get('/api/session', headers={'Authorization': f'Bearer {auth_token}'})
    assert before.status_code == 200
    data = before.get_json()
    assert data['authenticated'] is True
    assert data['username'] == 'admin'
    assert data['expires_at'] > time.time()

    # 只读：连续查询过期时间不变
    import time as _time
    _time.sleep(0.01)
    again = client.get('/api/session', headers={'Authorization': f'Bearer {auth_token}'})
    assert abs(again.get_json()['expires_at'] - data['expires_at']) < 0.001


def test_session_status_without_token(client):
    """无令牌查询会话返回 401"""
    response = client.get('/api/session')
    assert response.status_code == 401
    assert response.get_json()['authenticated'] is False


def test_session_status_invalid_token(client):
    """无效令牌查询会话返回 401"""
    response = client.get('/api/session', headers={'Authorization': 'Bearer nope'})
    assert response.status_code == 401


def test_logout_revokes_token(client, auth_token):
    """主动退出后令牌立即失效，受保护接口不可再用"""
    out = client.post('/api/logout', headers={'Authorization': f'Bearer {auth_token}'})
    assert out.status_code == 200
    assert out.get_json()['success'] is True

    assert client.get('/api/session', headers={'Authorization': f'Bearer {auth_token}'}).status_code == 401
    assert client.get('/api/shares', headers={'Authorization': f'Bearer {auth_token}'}).status_code == 401


def test_logout_without_token_is_idempotent(client):
    """退出接口幂等：无令牌也返回成功"""
    response = client.post('/api/logout')
    assert response.status_code == 200


def test_expired_token_is_rejected(client, db_conn):
    """本地已过期令牌在任意受保护入口立即被收回"""
    token = client.post('/api/auth', json={'username': 'admin', 'password': 'admin123'}).get_json()['token']
    cursor = db_conn.cursor()
    cursor.execute('UPDATE tokens SET expires_at = ? WHERE token = ?', (time.time() - 10, token))
    db_conn.commit()

    assert client.get('/api/session', headers={'Authorization': f'Bearer {token}'}).status_code == 401
    assert client.get('/api/files', headers={'Authorization': f'Bearer {token}'}).status_code == 200  # 公开接口不受影响


def test_query_param_token_still_supported(client, auth_token):
    """原有查询参数传 token 的登录方式保持兼容"""
    response = client.get(f'/api/session?token={auth_token}')
    assert response.status_code == 200
