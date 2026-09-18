import urllib.request
import requests

# 1. 屏蔽系统代理残留
urllib.request.getproxies = lambda: {}

# 2. 伪装成真实的 Chrome 浏览器
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

print("====== 开始网络连通性诊断 ======\n")

# 测试 1：检查 Python 是否被杀毒软件断网
print("测试 1: 尝试直连百度 (测试本机 Python 联网权限)...")
try:
    r1 = requests.get("https://www.baidu.com", headers=headers, timeout=5, verify=False)
    print(f"✅ 百度连接成功！状态码: {r1.status_code}\n")
except Exception as e:
    print(f"❌ 百度连接失败: {e}")
    print("👉 诊断结论：你的 Python 被本地杀毒软件/防火墙彻底断网了！请检查火绒/360/Windows Defender设置。\n")

# 测试 2：模拟浏览器直接请求东方财富底层 API
print("测试 2: 伪装浏览器直连东方财富 API...")
url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.002594&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61%2Cf116&ut=7eea3edcaed734bea9cbfc24409ed989&klt=101&fqt=0&beg=20240101&end=20240110"
try:
    r2 = requests.get(url, headers=headers, timeout=5, verify=False)
    print(f"✅ 东方财富 API 连接成功！状态码: {r2.status_code}")
    print(f"📦 返回数据前50个字符: {r2.text[:50]}")
except Exception as e:
    print(f"❌ 东方财富连接失败: {e}")
    print("👉 诊断结论：百度能通但东财不通，说明你的 IP 被东财暂时拉黑了，或者东财服务器抽风。\n")