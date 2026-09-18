import streamlit as st
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from datetime import datetime, timedelta
import pandas as pd

# 导入自定义模块
from data_fetcher import fetch_a_share_data
from strategy_engine import calculate_moving_average_strategy, predict_next_day_rf

st.set_page_config(page_title="A股量化分析系统", layout="wide")


# --- UI 缓存包装器 ---
@st.cache_data(ttl=3600)
def load_and_cache_data(symbol, start_date, end_date):
    return fetch_a_share_data(symbol, start_date, end_date)


# --- 侧边栏 ---
with st.sidebar:
    st.header("⚙️ 引擎配置")
    stock_code = st.text_input("股票代码 (如: 000001)", value="000001")

    end_dt = datetime.now()
    start_dt = end_dt - timedelta(days=365)
    date_range = st.date_input("回测区间", value=(start_dt, end_dt))

    st.markdown("---")
    st.subheader("策略参数")
    short_ma = st.slider("短期均线", 5, 20, 10)
    long_ma = st.slider("长期均线", 20, 60, 30)

    run_button = st.button("🚀 启动分析引擎", use_container_width=True)

# --- 主逻辑 ---
if run_button:
    if len(date_range) != 2:
        st.warning("请检查日期范围！")
        st.stop()

    start_str = date_range[0].strftime("%Y%m%d")
    end_str = date_range[1].strftime("%Y%m%d")

    with st.spinner('同步市场数据并执行计算中...'):
        data = load_and_cache_data(stock_code, start_str, end_str)

    if data is not None and not data.empty:
        # --- 数据标准化清洗 ---
        # 如果 yfinance 返回的是 MultiIndex，强制展平为单层列名
        if isinstance(data.columns, pd.MultiIndex):
            data.columns = data.columns.get_level_values(0)

        # 核心指标显示
        st.title("📈 核心盘面分析")
        col1, col2, col3 = st.columns(3)

        # 提取数值：确保取出的是纯标量 float
        latest_price = float(data['close'].iloc[-1])
        max_price = float(data['high'].max())
        min_price = float(data['low'].min())

        col1.metric("最新收盘价", f"¥{latest_price:.2f}")
        col2.metric("区间高点", f"¥{max_price:.2f}")
        col3.metric("区间低点", f"¥{min_price:.2f}")

        st.markdown("---")

        # 运行策略
        processed_data = calculate_moving_average_strategy(data, short_ma, long_ma)

        # 可视化绘图
        fig = make_subplots(rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.05, row_heights=[0.7, 0.3])

        fig.add_trace(go.Candlestick(x=processed_data.index, open=processed_data['open'],
                                     high=processed_data['high'], low=processed_data['low'],
                                     close=processed_data['close'], name="K线"), row=1, col=1)
        fig.add_trace(go.Scatter(x=processed_data.index, y=processed_data['MA_short'], name=f"MA{short_ma}"), row=1,
                      col=1)
        fig.add_trace(go.Scatter(x=processed_data.index, y=processed_data['MA_long'], name=f"MA{long_ma}"), row=1,
                      col=1)
        fig.add_trace(go.Bar(x=processed_data.index, y=processed_data['volume'], name="成交量",
                             marker_color='rgba(158,202,225,0.8)'), row=2, col=1)

        fig.update_layout(height=600, xaxis_rangeslider_visible=False, margin=dict(l=0, r=0, t=30, b=0))
        st.plotly_chart(fig, use_container_width=True)

        # 绩效与预测模块
        st.markdown("---")
        col_metrics, col_ml = st.columns(2)

        with col_metrics:
            st.subheader("📊 均线策略绩效")
            total_return = float(processed_data['Cumulative_Return'].iloc[-1]) - 1
            st.write(f"**区间累计收益:** `{total_return * 100:.2f}%`")
            st.line_chart(processed_data['Cumulative_Return'].rename("累计净值"))

        with col_ml:
            st.subheader("🤖 机器学习趋势预测")
            prediction, pct_change, is_valid = predict_next_day_rf(processed_data)

            if is_valid:
                st.info(f"随机森林模型预测明日收盘价: **¥{prediction:.2f}**")
                if pct_change > 0:
                    st.success(f"🔼 预测趋势: 上涨 (预计幅度: {pct_change:.2f}%)")
                else:
                    st.error(f"🔽 预测趋势: 下跌 (预计幅度: {pct_change:.2f}%)")
            else:
                st.warning("数据量不足以完成模型训练 (需要至少50个交易日)。")
    else:
        st.error("数据获取失败，请检查股票代码。")