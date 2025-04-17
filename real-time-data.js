const Binance = require('node-binance-api');
const WebSocket = require('ws');
const config = require('./config.json');
const axios = require('axios');

class RealTimeData {
  constructor() {
    const env = config.environment || 'test';
    this.envConfig = config[env] || config.test;
    this.binance = new Binance().options({
      APIKEY: this.envConfig.apiKey || '',
      APISECRET: this.envConfig.secretKey || '',
      test: env === 'test'
    });
    this.ws = null;
    this.history = [];
    this.secondKlines = [];
    this.orderBook = { bids: [], asks: [] };
    this.trades = [];
    this.symbol = null;
    this.wsUrl = this.envConfig.wsUrl || 'wss://stream.binancefuture.com';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
  }

  async fetchHistoricalData() {
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      try {
        const klinesUrl = config.environment === 'test' ? 
          `https://testnet.binancefuture.com/fapi/v1/klines?symbol=${this.symbol}&interval=1m&limit=200` : 
          `https://fapi.binance.com/fapi/v1/klines?symbol=${this.symbol}&interval=1m&limit=200`;
        const response = await axios.get(klinesUrl);
        const klineData = response.data.map(k => ({
          t: k[0],
          o: k[1],
          h: k[2],
          l: k[3],
          c: k[4],
          v: k[5]
        }));
        this.history = klineData;
        console.log('成功获取200条历史K线数据');
        return;
      } catch (error) {
        attempts++;
        const delay = Math.pow(2, attempts) * 1000;
        console.error(`获取历史数据失败，重试第${attempts}次，延迟${delay / 1000}秒`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('获取历史数据失败，超过最大重试次数');
  }

  async fetchOrderBook() {
    try {
      const depthUrl = config.environment === 'test' ? 
        `https://testnet.binancefuture.com/fapi/v1/depth?symbol=${this.symbol}&limit=5` : 
        `https://fapi.binance.com/fapi/v1/depth?symbol=${this.symbol}&limit=5`;
      const response = await axios.get(depthUrl);
      this.orderBook = {
        bids: response.data.bids || [],
        asks: response.data.asks || []
      };
      console.log('成功获取订单簿数据');
    } catch (error) {
      console.error('获取订单簿失败:', error.message);
      this.orderBook = { bids: [], asks: [] };
    }
  }

  aggregateTickData(trade) {
    const timestamp = Math.floor(trade.T / 1000) * 1000;
    const price = parseFloat(trade.p);
    const volume = parseFloat(trade.q);
    const existing = this.secondKlines.find(k => k.t === timestamp);
    if (existing) {
      existing.h = Math.max(existing.h, price);
      existing.l = Math.min(existing.l, price);
      existing.c = price;
      existing.v += volume;
    } else {
      this.secondKlines.push({
        t: timestamp,
        o: price,
        h: price,
        l: price,
        c: price,
        v: volume
      });
      if (this.secondKlines.length > 200) this.secondKlines.shift();
    }
  }

  async start(symbol) {
    try {
      if (!symbol) {
        console.log('警告: 无效的交易对，使用默认BTCUSDT');
        symbol = 'BTCUSDT';
      }
      if (this.symbol === symbol && this.ws && this.ws.readyState === WebSocket.OPEN) return;
      this.symbol = symbol;
      await this.fetchHistoricalData();
      const streams = [`${symbol.toLowerCase()}@kline_1m`, `${symbol.toLowerCase()}@depth@100ms`, `${symbol.toLowerCase()}@trade`];
      this.connect(streams);
    } catch (error) {
      console.error('错误: 启动实时数据失败:', error.message);
    }
  }

  connect(streams) {
    this.ws = new WebSocket(`${this.wsUrl}/stream?streams=${streams.join('/')}`);

    this.ws.on('open', () => {
      console.log('WebSocket连接成功');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data) => {
      try {
        const json = JSON.parse(data);
        if (!json.stream) return;

        if (json.stream.endsWith('@kline_1m')) {
          const kline = json.data.k;
          if (kline) {
            this.history.push(kline);
            if (this.history.length > 1000) this.history.shift();
          }
        } else if (json.stream.endsWith('@depth@100ms')) {
          this.orderBook = json.data || { bids: [], asks: [] };
        } else if (json.stream.endsWith('@trade')) {
          const trade = json.data;
          if (trade) {
            this.trades.push(trade);
            this.aggregateTickData(trade);
            if (this.trades.length > 10000) this.trades.shift();
          }
        }
      } catch (error) {
        console.error('错误: 解析WebSocket数据失败:', error.message);
      }
    });

    this.ws.on('close', () => {
      console.log('WebSocket连接关闭，尝试重连');
      this.reconnect(streams);
    });

    this.ws.on('error', (error) => {
      console.error('错误: WebSocket连接失败:', error.message);
      this.reconnect(streams);
    });
  }

  reconnect(streams) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`第${this.reconnectAttempts}次重连，延迟${delay/1000}秒`);
      setTimeout(() => this.connect(streams), delay);
    } else {
      console.error('错误: 超过最大重连次数，停止尝试');
    }
  }

  getHistory() {
    return this.history.length ? this.history : [];
  }

  getSecondKlines() {
    return this.secondKlines.length ? this.secondKlines : [];
  }

  getOrderBook() {
    return this.orderBook || { bids: [], asks: [] };
  }

  getTrades() {
    return this.trades.length ? this.trades : [];
  }
}

module.exports = new RealTimeData();