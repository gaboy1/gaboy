const fs = require('fs');
const tulind = require('tulind');
const LocalStrategy = require('./local-strategy');
const PositionManagement = require('./position-management');

class Backtest {
  constructor() {
    this.minDataPoints = 50;
    this.trades = [];
  }

  async backtest(records = [], initBalance = 10000, leverage = 20, riskPerTrade = 0.02) {
    try {
      if (!Array.isArray(records) || records.length < this.minDataPoints) {
        console.log('错误: 回测数据不足或无效');
        return { trades: [], balance: initBalance, maxDrawdown: 0, totalProfit: 0 };
      }

      let balance = initBalance;
      let maxBalance = initBalance;
      let maxDrawdown = 0;
      let totalProfit = 0;
      let positions = [];
      this.trades = [];

      // 转换记录为标准格式
      const historicalData = records.map(r => ({
        c: parseFloat(r.close) || 0,
        h: parseFloat(r.high) || 0,
        l: parseFloat(r.low) || 0,
        v: parseFloat(r.volume) || 0,
        o: parseFloat(r.open) || 0,
        t: r.timestamp || Date.now()
      }));

      let marketCondition = 'unknown';
      let strategyName = 'unknown';
      let conditionPersistence = {};

      for (let i = this.minDataPoints - 1; i < historicalData.length; i++) {
        const klineData = historicalData.slice(i - this.minDataPoints + 1, i + 1);
        const currentKline = historicalData[i];

        // 检测市场条件
        marketCondition = await LocalStrategy.detectMarketCondition(
          klineData.map(k => k.h),
          klineData.map(k => k.l),
          klineData.map(k => k.c),
          klineData.map(k => k.v),
          marketCondition,
          conditionPersistence[marketCondition] || 0
        );

        // 更新持久性计数
        if (conditionPersistence[marketCondition]) {
          conditionPersistence[marketCondition]++;
        } else {
          conditionPersistence = { [marketCondition]: 1 };
        }

        // 跳过新闻驱动行情
        if (marketCondition === 'news_driven') {
          console.log('跳过新闻驱动行情:', currentKline.t);
          continue;
        }

        // 确定策略名称
        strategyName = this.getStrategyName(marketCondition);

        // 模拟账户数据
        const account = {
          totalMarginBalance: balance,
          availableBalance: balance,
          positions: positions.map(pos => ({
            symbol: config.symbols[0],
            positionAmt: pos.isLong ? pos.size : -pos.size
          }))
        };

        // 调用策略分析
        let decision;
        try {
          decision = await LocalStrategy.analyze({
            secondKlines: klineData,
            account,
            fundingRate: 0, // 测试网无资金费率，设为0
            orderBook: { bids: [], asks: [] }
          });
        } catch (error) {
          console.error('错误: 策略分析失败:', error.message);
          decision = { action: 'hold', size: 0 };
        }

        const { action, size } = decision;
        const currentPrice = currentKline.c;

        // 处理交易信号
        if (action === 'long' || action === 'short') {
          const isLong = action === 'long';
          const existingPos = positions.find(pos => pos.isLong === isLong);

          if (!existingPos) {
            positions.push({
              entryPrice: currentPrice,
              size,
              isLong,
              entryTime: currentKline.t
            });
            console.log(`开仓: ${action}, 价格: ${currentPrice}, 仓位: ${size}, 时间: ${currentKline.t}`);
          }
        } else if (action === 'close_long' || action === 'close_short') {
          const isLong = action === 'close_long';
          const posIndex = positions.findIndex(pos => pos.isLong === isLong);
          if (posIndex !== -1) {
            const pos = positions[posIndex];
            const exitPrice = currentPrice;
            const profit = pos.isLong
              ? (exitPrice - pos.entryPrice) * pos.size
              : (pos.entryPrice - exitPrice) * pos.size;

            balance += profit;
            totalProfit += profit;
            maxBalance = Math.max(maxBalance, balance);
            const drawdown = (maxBalance - balance) / maxBalance;
            maxDrawdown = Math.max(maxDrawdown, drawdown);

            this.trades.push({
              entryTime: pos.entryTime,
              exitTime: currentKline.t,
              entryPrice: pos.entryPrice,
              exitPrice: exitPrice,
              size: pos.size,
              profit: profit,
              isLong: pos.isLong,
              marketCondition: marketCondition,
              strategyUsed: strategyName
            });

            console.log(`平仓: ${action}, 价格: ${exitPrice}, 盈亏: ${profit}, 时间: ${currentKline.t}`);
            positions.splice(posIndex, 1);
          }
        }
      }

      // 关闭剩余仓位
      for (const pos of positions) {
        const exitPrice = historicalData[historicalData.length - 1].c;
        const profit = pos.isLong
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;

        balance += profit;
        totalProfit += profit;
        maxBalance = Math.max(maxBalance, balance);
        const drawdown = (maxBalance - balance) / maxBalance;
        maxDrawdown = Math.max(maxDrawdown, drawdown);

        this.trades.push({
          entryTime: pos.entryTime,
          exitTime: historicalData[historicalData.length - 1].t,
          entryPrice: pos.entryPrice,
          exitPrice: exitPrice,
          size: pos.size,
          profit: profit,
          isLong: pos.isLong,
          marketCondition: marketCondition,
          strategyUsed: strategyName
        });
      }

      // 保存回测结果到CSV
      this.saveToCsv();

      return {
        trades: this.trades,
        balance,
        maxDrawdown,
        totalProfit
      };
    } catch (error) {
      console.error('回测发生错误:', error.message);
      return { trades: [], balance: initBalance, maxDrawdown: 0, totalProfit: 0 };
    }
  }

  getStrategyName(marketCondition) {
    const strategyMap = {
      sideways: 'ARIMA',
      trending: 'EMA_Crossover',
      breakout: 'Breakout',
      false_breakout: 'False_Breakout',
      acceleration: 'Acceleration'
    };
    return strategyMap[marketCondition] || 'Unknown';
  }

  saveToCsv() {
    try {
      const headers = [
        'entryTime',
        'exitTime',
        'entryPrice',
        'exitPrice',
        'size',
        'profit',
        'isLong',
        'marketCondition',
        'strategyUsed'
      ];
      const csvLines = [headers.join(',')];
      for (const trade of this.trades) {
        const line = [
          trade.entryTime,
          trade.exitTime || '',
          trade.entryPrice,
          trade.exitPrice || '',
          trade.size,
          trade.profit || 0,
          trade.isLong,
          trade.marketCondition,
          trade.strategyUsed
        ].join(',');
        csvLines.push(line);
      }
      fs.writeFileSync('backtest_trades.csv', csvLines.join('\n'));
      console.log('回测结果已保存至 backtest_trades.csv');
    } catch (error) {
      console.error('保存回测结果失败:', error.message);
    }
  }
}

module.exports = new Backtest();