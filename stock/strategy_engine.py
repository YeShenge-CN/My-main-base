import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from typing import Tuple


def calculate_moving_average_strategy(df: pd.DataFrame, short_window: int = 10, long_window: int = 30) -> pd.DataFrame:
    """双均线策略计算引擎"""
    data = df.copy()
    data['MA_short'] = data['close'].rolling(window=short_window).mean()
    data['MA_long'] = data['close'].rolling(window=long_window).mean()

    # 产生交易信号 (1: 持有/买入, 0: 空仓/卖出)
    data['Signal'] = np.where(data['MA_short'] > data['MA_long'], 1, 0)
    # 计算策略收益 (基于前一日信号)
    data['Strategy_Return'] = data['Signal'].shift(1) * data['close'].pct_change()
    data['Cumulative_Return'] = (1 + data['Strategy_Return'].fillna(0)).cumprod()

    return data


def predict_next_day_rf(df: pd.DataFrame) -> Tuple[float, float, bool]:
    """
    使用随机森林预测下一日收盘价。
    返回: (预测价格, 预期涨跌幅百分比, 是否有足够数据)
    """
    df_ml = df[['open', 'high', 'low', 'close', 'volume']].copy()

    # 构造滞后特征
    df_ml['lag_1'] = df_ml['close'].shift(1)
    df_ml['lag_2'] = df_ml['close'].shift(2)
    df_ml = df_ml.dropna()

    if len(df_ml) < 50:
        return 0.0, 0.0, False

    X = df_ml[['lag_1', 'lag_2', 'open', 'high', 'low', 'volume']]
    y = df_ml['close']

    # 训练模型 (剔除最后一条记录用于回测)
    model = RandomForestRegressor(n_estimators=100, random_state=42)
    model.fit(X.iloc[:-1], y.iloc[:-1])

    # 预测最新特征的下一日价格
    latest_features = X.iloc[[-1]]
    prediction = model.predict(latest_features)[0]

    current_price = df['close'].iloc[-1]
    pct_change = (prediction - current_price) / current_price * 100

    return prediction, pct_change, True