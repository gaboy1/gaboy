const schedule = require('node-schedule');
const winston = require('winston');
const fs = require('fs');
const RealTimeData = require('./real-time-data');
const LocalStrategy = require('./local-strategy');
const RestAPI = require('./rest-api');
const PositionManagement = require('./position-management');
const config = require('./config.json');

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
    this.isHoldingPosition = false; // 新增：是否持有仓位标志
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
      if (!existing.includes(klineData.t.toString())) {
        const line = `${klineData.t},${klineData.o},${klineData.h},${klineData.l},${klineData.c},${klineData.v}\n`;
        fs.appendFileSync(this.historyFile, line);
        console.log('成功记录K线数据到历史文件');
      }
    } catch (error) {
      console.error('错误: 记录K线数据失败:', error.message);
    }
  }

  async run() {
    try {
      PositionManagement.startMonitoring();
      const symbol = config.symbols[0] || 'BTCUSDT';
      await RealTimeData.start(symbol);

      schedule.scheduleJob('*/1 * * * * *', async () => {
        try {
          await RealTimeData.fetchOrderBook();
          const secondKlines = RealTimeData.getSecondKlines() || [];
          const orderBook = RealTimeData.getOrderBook() || { bids: [], asks: [] };

          let account;
          try {
            account = await RestAPI.getAccount();
          } catch (error) {
            console.error('错误: 获取账户信息失败:', error.message);
            return;
          }

          const fundingRate = await RestAPI.getFundingRate(symbol) || 0;

          let localDecision;
          try {
            localDecision = await LocalStrategy.analyze({
              secondKlines,
              account,
              fundingRate,
              orderBook
            });
          } catch (error) {
            console.error('错误: 策略分析失败:', error.message);
            localDecision = { action: 'hold', size: 0 };
          }

          const position = account.positions?.find(p => p.symbol === symbol) || { positionAmt: '0' };
          const positionAmt = parseFloat(position.positionAmt) || 0;
          const isLong = positionAmt > 0;
          const isShort = positionAmt < 0;
          const isFlat = positionAmt === 0;

          // 如果当前持有仓位，仅处理平仓信号
          if (this.isHoldingPosition) {
            if ((isLong && localDecision.action === 'close_long') || (isShort && localDecision.action === 'close_short')) {
              const closeSide = isLong ? 'SELL' : 'BUY';
              const closeQuantity = Math.abs(positionAmt);
              try {
                await RestAPI.cancelAllOrders(symbol); // 取消所有挂单
                await RestAPI.placeOrder(symbol, closeSide, closeQuantity);
                logger.info('已关闭现有仓位', { symbol, side: closeSide, quantity: closeQuantity });
                this.isHoldingPosition = false; // 平仓后恢复开仓能力
              } catch (error) {
                console.error('错误: 关闭仓位失败:', error.message);
              }
            } else {
              logger.info('当前持有仓位，保持现状');
            }
            return;
          }

          // 如果无持仓，处理开仓信号
          if (localDecision.action === 'long' || localDecision.action === 'short') {
            const openOrders = await RestAPI.getOpenOrders(symbol) || [];
            const hasOpenEntryOrder = Array.isArray(openOrders) && openOrders.some(order => order.type === 'MARKET' || order.type === 'LIMIT');
            if (hasOpenEntryOrder) {
              console.log('已有未完成的入场订单，跳过下单');
              return;
            }

            const side = localDecision.action === 'long' ? 'BUY' : 'SELL';
            try {
              await RestAPI.cancelAllOrders(symbol); // 下单前取消所有挂单
              await RestAPI.placeOrder(symbol, side, localDecision.size);
              logger.info('已开新仓', { symbol, side, size: localDecision.size });
              this.isHoldingPosition = true; // 开仓后进入持仓监控模式
              const latestKline = secondKlines[secondKlines.length - 1];
              if (latestKline) this.appendToHistory(latestKline);
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