const schedule = require('node-schedule');
const winston = require('winston');
const fs = require('fs');
const RealTimeData = require('./real-time-data');
const LocalStrategy = require('./local-strategy');
const RestAPI = require('./rest-api');
const MarketSentiment = require('./market-sentiment');
const config = require('./config.json');
const axios = require('axios');

// 强制使用生产环境
const envConfig = config.production;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'simulated_trading.log' }),
    new winston.transports.Console()
  ]
});

class SimulatedTrading {
  constructor() {
    this.accountFile = 'simulated_account.json';
    this.macroData = {};
    this.initAccount();
  }

  initAccount() {
    try {
      if (!fs.existsSync(this.accountFile)) {
        this.simulatedAccount = {
          totalMarginBalance: 10000, // 初始总保证金
          availableBalance: 10000,
          positions: [],
          totalProfit: 0 // 总盈亏
        };
        fs.writeFileSync(this.accountFile, JSON.stringify(this.simulatedAccount, null, 2));
        console.log('模拟账户文件初始化成功');
      } else {
        this.simulatedAccount = JSON.parse(fs.readFileSync(this.accountFile, 'utf-8'));
        console.log('加载模拟账户数据:', this.simulatedAccount);
      }
    } catch (error) {
      console.error('错误: 初始化或加载模拟账户失败:', error.message);
      this.simulatedAccount = {
        totalMarginBalance: 10000,
        availableBalance: 10000,
        positions: [],
        totalProfit: 0
      };
    }
  }

  saveAccount() {
    try {
      fs.writeFileSync(this.accountFile, JSON.stringify(this.simulatedAccount, null, 2));
      console.log('模拟账户状态已保存');
    } catch (error) {
      console.error('错误: 保存模拟账户状态失败:', error.message);
    }
  }

  async fetchMacroData() {
    try {
      const dxyResponse = await axios.get(`https://api.stlouisfed.org/fred/series/observations?series_id=DTWEXBGS&api_key=${config.fredApiKey}&file_type=json`);
      const dxyObservations = dxyResponse.data.observations;
      if (dxyObservations && dxyObservations.length > 0) {
        this.macroData.dxy = parseFloat(dxyObservations[dxyObservations.length - 1].value) || 100;
        console.log('美元指数数据更新成功:', this.macroData.dxy);
      } else {
        console.log('警告: 无法从FRED获取美元指数数据');
        this.macroData.dxy = 100;
      }

      const sp500Response = await axios.get(`https://api.stlouisfed.org/fred/series/observations?series_id=SP500&api_key=${config.fredApiKey}&file_type=json`);
      const sp500Observations = sp500Response.data.observations;
      if (sp500Observations && sp500Observations.length > 0) {
        const latestValue = sp500Observations[sp500Observations.length - 1].value;
        this.macroData.sp500 = latestValue !== '.' ? parseFloat(latestValue) : null;
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

  simulateOrder(symbol, side, quantity, price, stopLoss, takeProfit) {
    try {
      const notionalValue = quantity * price;
      const marginRequired = notionalValue / config.leverage;
      if (marginRequired > this.simulatedAccount.availableBalance) {
        console.log('警告: 模拟账户可用余额不足，跳过下单');
        return;
      }

      const position = {
        symbol,
        positionAmt: side === 'BUY' ? quantity : -quantity,
        entryPrice: price,
        stopLoss,
        takeProfit,
        unrealizedProfit: 0
      };
      this.simulatedAccount.positions.push(position);
      this.simulatedAccount.availableBalance -= marginRequired;
      console.log(`模拟下单成功: ${side === 'BUY' ? '买入' : '卖出'} ${quantity} ${symbol} @ ${price}, 止损: ${stopLoss}, 止盈: ${takeProfit}`);
      this.saveAccount();
    } catch (error) {
      console.error('错误: 模拟下单失败:', error.message);
    }
  }

  simulateClosePosition(position, currentPrice) {
    try {
      const profit = position.positionAmt > 0
        ? (currentPrice - position.entryPrice) * position.positionAmt
        : (position.entryPrice - currentPrice) * Math.abs(position.positionAmt);
      this.simulatedAccount.availableBalance += (Math.abs(position.positionAmt) * position.entryPrice / config.leverage) + profit;
      this.simulatedAccount.totalProfit += profit;
      this.simulatedAccount.positions = this.simulatedAccount.positions.filter(p => p !== position);
      console.log(`模拟平仓: ${position.positionAmt > 0 ? '多' : '空'}, 入场价: ${position.entryPrice}, 出场价: ${currentPrice}, 盈亏: ${profit}`);
      console.log(`总盈亏: ${this.simulatedAccount.totalProfit}, 当前余额: ${this.simulatedAccount.availableBalance}`);
      this.saveAccount();
    } catch (error) {
      console.error('错误: 模拟平仓失败:', error.message);
    }
  }

  async run() {
    try {
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

          const sentiment = await MarketSentiment.analyzeNews(symbol);
          const fundingRate = await RestAPI.getFundingRate(symbol) || 0;
          const orderBook = RealTimeData.getOrderBook() || { bids: [], asks: [] };
          const trades = RealTimeData.getTrades() || [];

          let localDecision;
          try {
            localDecision = await LocalStrategy.analyze({
              klineData,
              account: this.simulatedAccount,
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

          const currentPrice = parseFloat(klineData[klineData.length - 1].c) || 0;
          const position = this.simulatedAccount.positions.find(p => p.symbol === symbol);

          if (position) {
            const isLong = position.positionAmt > 0;
            const decisionAction = localDecision.action;
            if ((isLong && decisionAction === 'short') || (!isLong && decisionAction === 'long')) {
              this.simulateClosePosition(position, currentPrice);
            } else if (
              (isLong && (currentPrice <= position.stopLoss || currentPrice >= position.takeProfit)) ||
              (!isLong && (currentPrice >= position.stopLoss || currentPrice <= position.takeProfit))
            ) {
              this.simulateClosePosition(position, currentPrice);
            }
          }

          if (localDecision.action === 'long' || localDecision.action === 'short') {
            if (!this.simulatedAccount.positions.some(p => p.symbol === symbol)) {
              this.simulateOrder(symbol, localDecision.action === 'long' ? 'BUY' : 'SELL', localDecision.size, currentPrice, localDecision.stopLoss, localDecision.takeProfit);
            }
          } else {
            logger.info('条件未满足，保持现状');
          }

          console.log(`模拟账户状态 - 总保证金: ${this.simulatedAccount.totalMarginBalance}, 可用余额: ${this.simulatedAccount.availableBalance}, 总盈亏: ${this.simulatedAccount.totalProfit}`);
        } catch (error) {
          logger.error('交易循环发生错误', { message: error.message, stack: error.stack });
        }
      });
    } catch (error) {
      console.error('错误: 系统启动失败:', error.message);
    }
  }
}

new SimulatedTrading().run();