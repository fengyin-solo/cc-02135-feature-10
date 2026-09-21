"""会话生命周期接口测试"""
import time
import pytest


@pytest.fixture(autouse=True)
def clear_rate_limits():
    """登录接口有 IP 速率限制，每个用例前清空，保证测试稳定"""
    from auth import rate_limit_store
    rate_limit_store.clear()
    yield
    rate_limit_store.clear()


def login(client):
    resp = client.post('/api/auth', json={'username': 'admin', 'password': 'admin123'})
    return resp.get_json()


def test_auth_returns_session_payload(client):
    """登录响应应包含统一的会话字段"""
    resp = client.post('/api/auth', json={'username': 'admin', 'password': 'admin123'})
    data = resp.get_json()
    assert data['success'] is True
    assert data['username'] == 'admin'
    assert data['token']
    assert data['expires_at'] > time.time()
    assert data['expires_in'] > 0
    assert data['server_time'] > 0
    assert data['max_age'] == 300


def test_session_status_without_token(client):
    """无凭据查询会话返回 401"""
    resp = client.get('/api/session')
    assert resp.status_code == 401
    assert resp.get_json()['authenticated'] is False


def test_session_status_with_valid_token(client):
    """有效 token 查询会话成功，且不改变过期时间（只查不续期）"""
    data = login(client)
    resp1 = client.get('/api/session', headers={'Authorization': f"Bearer {data['token']}"})
    assert resp1.status_code == 200
    info1 = resp1.get_json()
    assert info1['authenticated'] is True
    assert info1['username'] == 'admin'

    time.sleep(0.05)
    resp2 = client.get('/api/session', headers={'Authorization': f"Bearer {data['token']}"})
    info2 = resp2.get_json()
    # 两次查询的过期时间应一致（允许微小时间误差）
    assert abs(info2['expires_at'] - info1['expires_at']) < 0.01


def test_session_status_with_expired_token(client, db_conn):
    """过期 token 查询返回 401，且记录被立即清除"""
    data = login(client)
    cursor = db_conn.cursor()
    cursor.execute('UPDATE tokens SET expires_at = ? WHERE token = ?',
                   (time.time() - 10, data['token']))
    db_conn.commit()

    resp = client.get('/api/session', headers={'Authorization': f"Bearer {data['token']}"})
    assert resp.status_code == 401

    cursor.execute('SELECT COUNT(*) AS c FROM tokens WHERE token = ?', (data['token'],))
    assert cursor.fetchone()['c'] == 0


def test_logout_revokes_token(client):
    """主动注销后 token 立即失效"""
    data = login(client)
    headers = {'Authorization': f"Bearer {data['token']}"}

    logout_resp = client.delete('/api/session', headers=headers)
    assert logout_resp.status_code == 200
    assert logout_resp.get_json()['success'] is True

    # 会话查询与受保护接口都应立即拒绝
    assert client.get('/api/session', headers=headers).status_code == 401
    assert client.get('/api/shares', headers=headers).status_code == 401


def test_logout_idempotent(client):
    """重复注销和无 token 注销都是安全的"""
    data = login(client)
    headers = {'Authorization': f"Bearer {data['token']}"}
    assert client.delete('/api/session', headers=headers).status_code == 200
    assert client.delete('/api/session', headers=headers).status_code == 200
    assert client.delete('/api/session').status_code == 200


def test_refresh_returns_new_expiry(client):
    """续期接口返回新的过期时间且原 token 保持不变（令牌不替换，只换到期时间）"""
    data = login(client)
    old_expires = data['expires_at']

    time.sleep(0.05)
    resp = client.post('/api/refresh-token',
                       headers={'Authorization': f"Bearer {data['token']}"})
    assert resp.status_code == 200
    result = resp.get_json()
    assert result['success'] is True
    assert result['token'] == data['token']
    assert result['expires_at'] > old_expires
    assert result['username'] == 'admin'


def test_refresh_expired_token_rejected(client, db_conn):
    """过期 token 无法续期"""
    data = login(client)
    cursor = db_conn.cursor()
    cursor.execute('UPDATE tokens SET expires_at = ? WHERE token = ?',
                   (time.time() - 10, data['token']))
    db_conn.commit()

    resp = client.post('/api/refresh-token',
                       headers={'Authorization': f"Bearer {data['token']}"})
    assert resp.status_code == 401


def test_login_replaces_old_token(client, db_conn):
    """同一用户重新登录后旧 token 被替换（INSERT OR REPLACE），不能残留"""
    first = login(client)
    second = login(client)
    assert first['token'] != second['token']

    headers = {'Authorization': f"Bearer {first['token']}"}
    assert client.get('/api/session', headers=headers).status_code == 401

    cursor = db_conn.cursor()
    cursor.execute('SELECT COUNT(*) AS c FROM tokens WHERE username = ?', ('admin',))
    assert cursor.fetchone()['c'] == 1
