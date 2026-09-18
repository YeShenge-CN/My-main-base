import yfinance as yf
import pandas as pd
import requests
from datetime import datetime
from typing import Optional


def fetch_a_share_data(symbol: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
    """
    带浏览器伪装会话的 yfinance 数据获取函数
    """
    try:
        # 1. 动态将 '20250607' 转换为 '2025-06-07'
        start_fmt = datetime.strptime(start_date, "%Y%m%d").strftime("%Y-%m-%d")
        end_fmt = datetime.strptime(end_date, "%Y%m%d").strftime("%Y-%m-%d")

        if symbol.startswith("6"):
            ticker = f"{symbol}.SS"
        else:
            ticker = f"{symbol}.SZ"

        # 2. 创建一个伪装成真实 Chrome 浏览器的会话
        session = requests.Session()
        session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5'
        })

        # 3. 将会话传入 yfinance
        df = yf.download(ticker, start=start_fmt, end=end_fmt, session=session)

        if df.empty:
            return None

        # 4. 标准化字段列名
        df.rename(columns={'Open': 'open', 'High': 'high', 'Low': 'low',
                           'Close': 'close', 'Volume': 'volume'}, inplace=True)

        df.index = pd.to_datetime(df.index)
        return df
    except Exception as e:
        print(f"数据拉取异常: {e}")
        return None