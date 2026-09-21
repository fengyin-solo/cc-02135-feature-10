## How to Run

### Docker 启动（推荐）

```bash
# 构建并启动所有服务
docker-compose up --build -d

# 查看运行状态
docker-compose ps

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

启动后访问：
- 前端：http://localhost:8081
- 后端API：http://localhost:8636

### 本地启动

**后端：**
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

**前端：**
直接用浏览器打开 `frontend/index.html`，或使用任意静态服务器：
```bash
cd frontend
python -m http.server 8081
```

## Services

| 服务 | 端口 | 说明 |
|------|------|------|
| frontend | 8081 | Nginx静态文件服务 + API代理 |
| backend | 8636 | Flask API服务 |

## 测试账号

| 用户名 | 密码 |
|--------|------|
| admin | admin123 |
| user | user123 |
| test | test123 |

## 运行测试

```bash
cd backend
pip install -r requirements.txt
pytest -v
```

## 题目内容

做一个下载网站，要求：
- 有加载动画
- 有上传按钮
- 点击下载时进行身份验证
- 验证完成后自动跳转下载
- 使用Python后端
- 前端端口：8081
- 后端端口：8636
- 支持Docker部署（ARM和X86跨平台）

---

## 项目介绍

做一个下载网站要有加载动画和上传按钮并且点击下载的时候会有身份验证的网页完成后自动跳转要用Python制作完成后放在文件夹中并且搭建服务器

### 功能特性

- 📤 文件上传
- 📥 文件下载（需身份验证）
- 🔐 用户身份验证
- 🔄 登录会话生命周期管理（有效 / 即将失效 / 已失效 / 重新进入 / 退出）
- ⏳ 加载动画效果
- 🐳 Docker一键部署

### 登录会话状态流转

前端以 `frontend/session.js` 作为会话状态的唯一事实源，页面切换、受保护操作（下载、分享、删除）和主动退出遵循同一套规则：

| 状态 | 含义 | 界面行为 |
|------|------|----------|
| `RESTORING` | 重新进入页面，正在向服务端复核本地凭据 | 显示"正在恢复会话" |
| `ACTIVE` | 会话有效（剩余 > 60 秒） | 绿色状态点，敏感入口可用 |
| `EXPIRING` | 即将失效（≤ 60 秒），可一键续期 | 黄色倒计时横幅，入口不收回 |
| `EXPIRED` | 已被服务端拒绝（401）或本地到期 | 立即收回分享等敏感入口，提示重新登录 |
| `OFFLINE` | 网络中断，状态冻结、不清除凭据 | 黄色横幅，恢复网络后自动重新校验 |
| `LOGGED_OUT` | 无凭据或主动退出 | 敏感入口全部隐藏 |

- **令牌替换**：同一用户重新登录时，服务端立即撤销旧令牌；跨标签页通过 `storage` 事件同步，不残留旧身份。
- **重复点击**：登录、续期、下载、创建/删除分享均有 in-flight 去重与按钮禁用；分享页重复下载不会重复扣减次数。
- **权限校验**：受保护操作统一走 `withSession()` 门禁与 `authedFetch()`，任何 401 都会集中吊销会话并在重新登录后只重放一次。
- **兼容性**：取件页（`share.html`）公开访问、免登录取件方式不变；下载仍兼容旧式 `?token=` 参数；旧版本地登录数据自动补全。

会话相关接口：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auth` | POST | 登录，返回 token、过期时间与服务器时间 |
| `/api/session` | GET | 查询会话状态（只校验，不续期） |
| `/api/session` | DELETE | 主动退出，立即撤销服务端 token（幂等） |
| `/api/refresh-token` | POST | 滑动续期（保留兼容） |


### 文件上传安全策略

项目采用扩展名黑名单机制，禁止上传以下类型的文件：

`exe, sh, bat, cmd, ps1, py, php, jsp, cgi, pl`

为什么用黑名单而不是白名单？
- 白名单需要预先列出所有允许的格式，每次有新格式都要手动添加，维护成本高
- 作为下载站，用户上传的文件类型多样且不可预测，白名单容易漏掉合法格式
- 黑名单只需拦截少量危险的可执行文件类型（如脚本、二进制程序），防止服务器被上传恶意代码利用
- 配合文件大小限制（默认50MB），已经能满足基本的安全需求

### 技术栈

- 前端：HTML + CSS + JavaScript
- 后端：Python Flask
- 部署：Docker + Nginx
