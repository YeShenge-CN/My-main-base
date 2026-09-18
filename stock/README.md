# A股量化分析系统 Stock

一个基于 Streamlit 的 A 股量化分析小工具：输入股票代码，拉取历史行情，跑双均线策略回测，并用随机森林预测下一日收盘价。

> ⚠️ 仅供学习与技术验证，**不构成任何投资建议**。

## 功能一览

| 模块 | 说明 |
| --- | --- |
| `app.py` | Streamlit 主界面：K 线图、均线、成交量、绩效与预测面板 |
| `data_fetcher.py` | 通过 yfinance 拉取 A 股日线数据（自动补 `.SS` / `.SZ` 后缀，带浏览器伪装会话） |
| `strategy_engine.py` | 双均线策略回测 + 随机森林预测下一日收盘价 |
| `launcher.py` | 一键启动器源码（打包成 exe 用） |
| `test_net.py` | 网络连通性诊断脚本（排查杀毒软件断网 / 东财 API 可用性） |

### 策略与模型

- **双均线策略**：短均线上穿长均线时持有（信号 1），否则空仓（信号 0）；收益按前一日信号计算，累乘得到累计净值。
- **随机森林预测**：用 `lag_1`、`lag_2`、`open`、`high`、`low`、`volume` 作为特征，`close` 作为标签，训练后预测最新一日的下一日收盘价；少于 50 个交易日会提示数据不足。

## 一键启动（推荐）

仓库里已附带打包好的启动器：

```
stock/dist/股票预测一键启动.exe
```

双击即可，它会自动：

1. 定位项目目录（支持 exe 放在 `dist/` 或项目根目录）
2. 查找可用 Python —— 优先项目内 `.venv`，其次是 PATH 中的 python
3. 校验 `streamlit` / `pandas` / `numpy` / `plotly` / `sklearn` / `yfinance` 是否齐全
4. 端口 8501 被占用时自动换端口
5. 启动服务，等就绪后自动打开浏览器

> **注意**：exe 是轻量启动器，运行时依赖本机的 Python 环境，所以它必须和本项目放在一起，
> 且本机需要先装好依赖。窗口里按 `Ctrl+C` 可停止服务。

## 手动运行

```bash
# 1. 创建虚拟环境并安装依赖
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. 启动
.venv\Scripts\python.exe -m streamlit run app.py
```

浏览器打开 <http://localhost:8501>，在左侧输入股票代码（如 `000001`、`600519`）后点击「🚀 启动分析引擎」。

## 重新打包 exe

改完代码后想重新生成启动器：

```powershell
powershell -ExecutionPolicy Bypass -File .\build_exe.ps1
```

产物在 `dist\股票预测一键启动.exe`。脚本会自动安装 PyInstaller、生成图标（`make_icon.py`）并打包。

## 技术栈

- Python 3.12
- Streamlit 1.58 构建界面
- Plotly 绘制 K 线 / 成交量
- pandas + numpy 处理行情数据
- scikit-learn 随机森林做趋势预测
- yfinance 获取 A 股数据

## 目录结构

```
stock/
├── app.py                    # Streamlit 主程序
├── data_fetcher.py           # 行情数据获取
├── strategy_engine.py        # 策略回测 + 预测
├── launcher.py               # 一键启动器源码
├── build_exe.ps1             # 打包脚本
├── make_icon.py              # 图标生成
├── icon.ico                  # 启动器图标
├── test_net.py               # 网络诊断
├── requirements.txt
├── .streamlit/config.toml    # Streamlit 运行配置
└── dist/股票预测一键启动.exe   # 打包好的启动器
```
