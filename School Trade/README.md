# 校园二手交易平台 Campus Trade

一个基于 Django 的校园二手交易平台：同学之间发布闲置物品、下单交易、留言互动。

## 功能一览

| App | 职责 |
| --- | --- |
| `users` | 注册、登录、身份校验；个人中心统一管理买入、卖出、发布的商品 |
| `goods` | 二手商品分类管理、商品图文发布、首页商品列表流展示与筛选、商品详情、下架 |
| `trades` | 交易（生成订单、确认收货）与互动（留言咨询） |

### 数据模型

- `users.User` -- 继承 `AbstractUser`，扩展了 `student_id`（学号）、`dorm_building`（宿舍楼栋）、`phone`（联系电话）
- `goods.Category` -- 商品分类
- `goods.Product` -- 商品：卖家、分类、标题、描述、价格、新旧程度、主图、状态
- `trades.Order` -- 订单：UUID 订单号、买家、商品（一对一）、金额、状态
- `trades.Comment` -- 商品留言

## 技术栈

- Python 3.12 + Django 6.0
- MySQL（`mysqlclient` 驱动，字符集 utf8mb4）
- Pillow 处理商品图片上传
- 原生 Django 模板 + HTML/CSS

## 目录结构

```
School Trade/
├── campus_trade/          # 项目配置
│   ├── settings.py        # 主配置（不含任何口令）
│   ├── local_settings.example.py   # 本机敏感配置模板
│   └── urls.py
├── users/                 # 用户模块
├── goods/                 # 商品模块
├── trades/                # 交易与留言模块
├── templates/             # 页面模板
├── media/                 # 上传的商品图片
├── launcher/              # 一键启动器源码（C#）
├── manage.py
└── requirements.txt
```

## 快速开始

### 1. 建库

在 MySQL 中创建数据库（字符集必须是 utf8mb4）：

```sql
CREATE DATABASE campus_trade DEFAULT CHARACTER SET utf8mb4;
```

### 2. 安装依赖

```bash
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

### 3. 配置本机密钥

`settings.py` 里没有任何口令。把模板复制一份填上自己的值：

```bash
copy campus_trade\local_settings.example.py campus_trade\local_settings.py
```

然后编辑 `campus_trade/local_settings.py`，填入 MySQL 账号口令和 SECRET_KEY。
该文件已被 `.gitignore` 忽略，不会提交到仓库；也可以用环境变量
`DB_USER` / `DB_PASSWORD` / `DJANGO_SECRET_KEY` 代替。

### 4. 迁移并运行

```bash
venv\Scripts\python manage.py migrate
venv\Scripts\python manage.py runserver
```

浏览器打开 http://127.0.0.1:8000/ 即可。

## 一键启动器（Windows）

`启动校园二手交易平台.exe` 会依次完成：

1. 检查 Python 虚拟环境
2. 检查 MySQL，未启动时自动启动服务（需要时会弹一次 UAC 提权）
3. 自动执行 `migrate` 同步表结构
4. 启动 Django 并自动打开浏览器

细节：

- 端口被别的程序占用时，会先确认占用者是谁，然后自动换到下一个空闲端口
- 如果平台已经在运行，直接打开浏览器，不会重复启动
- 关闭启动器窗口（或按 Ctrl+C）会一并结束 Django 进程，不留后台残留

配置项都在同目录的 `启动配置.ini` 里，删掉会自动用默认值重建。
源码在 `launcher/`，重新编译执行 `launcher/build.ps1` 即可（使用系统自带的 .NET Framework 编译器，无需联网）。

## 说明

- `media/` 中是演示用的商品图片
- 开发环境使用 `DEBUG = True` 和 Django 自带的开发服务器，仅适合本地演示，不要直接用于生产