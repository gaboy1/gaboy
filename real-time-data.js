const Binance = require('node-binance-api');
const WebSocket = require('ws');
const config = require('./config.json');

class RealTimeData {
  constructor() {
    const env = config.environment || 'test';
    const envConfig = config[env] || config.test;
    this.binance = new Binance().options({
      APIKEY: envConfig.apiKey || '',
      APISECRET: envConfig.secretKey || '',
      test: env === 'test'
    });
    this.ws = null;
    this.history = [];
    this.orderBook = { bids: [], asks: [] };
    this.trades = [];
    this.symbol = null;
    this.wsUrl = envConfig.wsUrl || 'wss://stream.binancefuture.com/ws';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  start(symbol) {
    try {
      if (!symbol) {
        console.log('警告: 无效的交易对，使用默认BTCUSDT');
        symbol = 'BTCUSDT';
      }
      if (this.symbol === symbol && this.ws && this.ws.readyState === WebSocket.OPEN) return;
      this.symbol = symbol;
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
            const now = Date.now();
            this.trades = this.trades.filter(t => now - (t.T || 0) <= 24 * 60 * 60 * 1000);
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
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // 指数退避，最长30秒
      console.log(`第${this.reconnectAttempts}次重连，延迟${delay/1000}秒`);
      setTimeout(() => this.connect(streams), delay);
    } else {
      console.error('错误: 超过最大重连次数，停止尝试');
    }
  }

  getHistory() {
    return this.history.length ? this.history : [];
  }

  getOrderBook() {
    return this.orderBook || { bids: [], asks: [] };
  }

  getTrades() {
    return this.trades.length ? this.trades : [];
  }
}

module.exports = new RealTimeData();