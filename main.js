const schedule = require('node-schedule');
const winston = require('winston');
const fs = require('fs');
const RealTimeData = require('./real-time-data');
const LocalStrategy = require('./local-strategy');
const RestAPI = require('./rest-api');
const PositionManagement = require('./position-management');
const MarketSentiment = require('./market-sentiment');
const config = require('./config.json');
const axios = require('axios');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'trading.log' }),
    new winston.transports.Console()
  ]
});

class MainProgram {
  constructor() {
    this.historyFile = 'trade_history.csv';
    this.macroData = {};
    this.initHistoryFile();
  }

  initHistoryFile() {
    try {
      if (!fs.existsSync(this.historyFile)) {
        fs.writeFileSync(this.historyFile, 'timestamp,open,high,low,close,volume\n');
        console.log('交易历史文件初始化成功');
      }
    } catch (error) {
      console.error('错误: 初始化交易历史文件失败:', error.message);
    }
  }

  appendToHistory(klineData) {
    try {
      if (!klineData || !klineData.t) {
        console.log('警告: K线数据无效，跳过记录');
        return;
      }
      const existing = fs.existsSync(this.historyFile) ? fs.readFileSync(this.historyFile, 'utf-8') : '';
      if (!existing.includes(klineData.t)) {
        const line = `${klineData.t},${klineData.o},${klineData.h},${klineData.l},${klineData.c},${klineData.v}\n`;
        fs.appendFileSync(this.historyFile, line);
        console.log('成功记录K线数据到历史文件');
      }
    } catch (error) {
      console.error('错误: 记录K线数据失败:', error.message);
    }
  }

  async fetchMacroData() {
    try {
      // 获取美元指数 (DXY)
      const dxyResponse = await axios.get(`https://api.stlouisfed.org/fred/series/observations?series_id=DTWEXBGS&api_key=${config.fredApiKey}&file_type=json`);
      const dxyObservations = dxyResponse.data.observations;
      if (dxyObservations && dxyObservations.length > 0) {
        this.macroData.dxy = parseFloat(dxyObservations[dxyObservations.length - 1].value) || 100;
        console.log('美元指数数据更新成功:', this.macroData.dxy);
      } else {
        console.log('警告: 无法从FRED获取美元指数数据');
        this.macroData.dxy = 100;
      }

      // 获取标普500 (SP500)
      const sp500Response = await axios.get(`https://api.stlouisfed.org/fred/series/observations?series_id=SP500&api_key=${config.fredApiKey}&file_type=json`);
      const sp500Observations = sp500Response.data.observations;
      if (sp500Observations && sp500Observations.length > 0) {
        const latestValue = sp500Observations[sp500Observations.length - 1].value;
        this.macroData.sp500 = latestValue !== '.' ? parseFloat(latestValue) : null; // 处理无效值
        console.log('标普500数据更新成功:', this.macroData.sp500);
      } else {
        console.log('警告: 无法从FRED获取标普500数据');
        this.macroData.sp500 = null;
      }
    } catch (error) {
      console.error('错误: 获取宏观数据失败:', error.message);
      this.macroData.dxy = 100;
      this.macroData.sp500 = null;
    }
  }

  async run() {
    try {
      PositionManagement.startMonitoring();
      await this.fetchMacroData();
      schedule.scheduleJob('0 0 * * *', () => this.fetchMacroData());

      schedule.scheduleJob('*/1 * * * *', async () => {
        try {
          const symbol = config.symbols[0] || 'BTCUSDT';
          RealTimeData.start(symbol);
          const klineData = RealTimeData.getHistory();
          if (!Array.isArray(klineData) || klineData.length < 50) {
            logger.warn('历史数据不足，跳过本次循环');
            return;
          }

          let account;
          try {
            account = await RestAPI.getAccount();
          } catch (error) {
            console.error('错误: 获取账户信息失败:', error.message);
            console.log('账户信息获取失败，本次循环跳过');
            return;
          }

          const sentiment = await MarketSentiment.analyzeNews(symbol);
          const fundingRate = await RestAPI.getFundingRate(symbol) || 0;
          const orderBook = RealTimeData.getOrderBook() || { bids: [], asks: [] };
          const trades = RealTimeData.getTrades() || [];

          let localDecision;
          try {
            localDecision = await LocalStrategy.analyze({
              klineData,
              account,
              sentiment,
              fundingRate,
              orderBook,
              trades,
              macroData: this.macroData
            });
          } catch (error) {
            console.error('错误: 策略分析失败:', error.message);
            localDecision = { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
          }

          const position = account.positions?.find(p => p.symbol === symbol) || { positionAmt: '0' };
          const positionAmt = parseFloat(position.positionAmt) || 0;

          if (positionAmt !== 0) {
            const isLong = positionAmt > 0;
            const decisionAction = localDecision.action;
            if ((isLong && decisionAction === 'short') || (!isLong && decisionAction === 'long')) {
              const closeSide = isLong ? 'SELL' : 'BUY';
              const closeQuantity = Math.abs(positionAmt);
              try {
                await RestAPI.placeOrder(symbol, closeSide, closeQuantity);
                logger.info('已关闭现有仓位', { symbol, side: closeSide, quantity: closeQuantity });
              } catch (error) {
                console.error('错误: 关闭仓位失败:', error.message);
              }
            }
          }

          if (localDecision.action === 'long' || localDecision.action === 'short') {
            const openOrders = await RestAPI.getOpenOrders(symbol);
            const hasOpenEntryOrder = openOrders.some(order => order.type === 'MARKET' || order.type === 'LIMIT');
            if (hasOpenEntryOrder) {
              console.log('已有未完成的入场订单，跳过下单');
              return;
            }

            const side = localDecision.action === 'long' ? 'BUY' : 'SELL';
            try {
              await RestAPI.placeOrderWithSLTP(symbol, side, localDecision.size, localDecision.stopLoss, localDecision.takeProfit);
              logger.info('已开新仓并设置止损止盈', { symbol, side, size: localDecision.size, stopLoss: localDecision.stopLoss, takeProfit: localDecision.takeProfit });
              this.appendToHistory(klineData[klineData.length - 1]);
            } catch (error) {
              console.error('错误: 开仓失败:', error.message);
            }
          } else {
            logger.info('条件未满足，保持现状');
          }

          PositionManagement.managePositions(account.positions || []);
        } catch (error) {
          logger.error('交易循环发生错误', { message: error.message, stack: error.stack });
        }
      });
    } catch (error) {
      console.error('错误: 系统启动失败:', error.message);
    }
  }
}

new MainProgram().run();