const fs = require('fs');
const csv = require('csv-parse/sync');
const LocalStrategy = require('./local-strategy');
const RiskManagement = require('./risk-management');

class Backtest {
  constructor() {
    this.initialBalance = 10000;
    this.leverage = 20;
    this.riskPerTrade = 0.01;
    this.strategy = LocalStrategy;
    this.riskManager = RiskManagement;
    this.minDataPoints = 50;
  }

  async backtest(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        console.log('历史数据文件不存在，跳过回测');
        return null;
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      let records;
      try {
        records = csv.parse(fileContent, { columns: true, skip_empty_lines: true });
      } catch (error) {
        console.error('错误: 解析CSV文件失败:', error.message);
        return null;
      }

      if (!Array.isArray(records) || records.length < this.minDataPoints) {
        console.log(`历史数据不足${this.minDataPoints}条，当前${records.length || 0}条，跳过回测`);
        return null;
      }

      let balance = this.initialBalance;
      let positions = [];
      let trades = [];
      let maxDrawdown = 0;
      let peakBalance = balance;

      const historicalData = records.map(r => ({
        c: parseFloat(r.close) || 0,
        h: parseFloat(r.high) || 0,
        l: parseFloat(r.low) || 0,
        v: parseFloat(r.volume) || 0,
        o: parseFloat(r.open) || 0,
        t: r.timestamp || Date.now()
      }));

      for (let i = 0; i < historicalData.length; i++) {
        const kline = historicalData[i];
        const klineData = historicalData.slice(0, i + 1);

        for (let j = positions.length - 1; j >= 0; j--) {
          const pos = positions[j];
          const currentPrice = kline.c;
          const profit = pos.isLong
            ? (currentPrice - pos.entryPrice) * pos.size
            : (pos.entryPrice - currentPrice) * pos.size;

          if (
            (pos.isLong && (currentPrice <= pos.stopLoss || currentPrice >= pos.takeProfit)) ||
            (!pos.isLong && (currentPrice >= pos.stopLoss || currentPrice <= pos.takeProfit))
          ) {
            balance += profit;
            trades.push({
              entryTime: pos.entryTime,
              exitTime: kline.t,
              entryPrice: pos.entryPrice,
              exitPrice: currentPrice,
              size: pos.size,
              profit,
              isLong: pos.isLong
            });
            positions.splice(j, 1);
            console.log(`平仓: ${pos.isLong ? '多' : '空'}, 入场价: ${pos.entryPrice}, 出场价: ${currentPrice}, 盈亏: ${profit}`);
          }
        }

        peakBalance = Math.max(peakBalance, balance);
        const drawdown = peakBalance - balance;
        maxDrawdown = Math.max(maxDrawdown, drawdown);

        let decision;
        try {
          decision = await this.strategy.analyze({
            klineData,
            account: { totalMarginBalance: balance },
            sentiment: 'neutral',
            fundingRate: 0,
            orderBook: { bids: [], asks: [] },
            trades: [],
            macroData: { dxy: 100 }
          });
        } catch (error) {
          console.error('错误: 策略分析失败:', error.message);
          decision = { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
        }

        if ((decision.action === 'long' || decision.action === 'short') && positions.length === 0) {
          const entryPrice = kline.c;
          const position = {
            isLong: decision.action === 'long',
            entryPrice,
            stopLoss: decision.stopLoss || (decision.action === 'long' ? entryPrice - atr * 2 : entryPrice + atr * 2),
            takeProfit: decision.takeProfit || (decision.action === 'long' ? entryPrice + atr * 3 : entryPrice - atr * 3),
            size: decision.size || 0,
            entryTime: kline.t
          };
          positions.push(position);
          console.log(`开仓: ${decision.action === 'long' ? '多' : '空'}, 价格: ${entryPrice}, 数量: ${position.size}`);
        }
      }

      const finalBalance = balance + positions.reduce((sum, pos) => {
        const currentPrice = historicalData[historicalData.length - 1].c;
        return sum + (pos.isLong ? (currentPrice - pos.entryPrice) : (pos.entryPrice - currentPrice)) * pos.size;
      }, 0);

      const totalProfit = finalBalance - this.initialBalance;
      const winTrades = trades.filter(t => t.profit > 0).length;
      const totalTrades = trades.length;
      const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
      const monthlyRate = totalTrades > 0 ? ((totalProfit / this.initialBalance) / (records.length / 720)) * 100 : 0;

      console.log('=== 回测结果 ===');
      console.log(`初始余额: ${this.initialBalance}`);
      console.log(`最终余额: ${finalBalance.toFixed(2)}`);
      console.log(`总收益: ${totalProfit.toFixed(2)} (${((totalProfit / this.initialBalance) * 100).toFixed(2)}%)`);
      console.log(`月化收益率: ${monthlyRate.toFixed(2)}%`);
      console.log(`交易次数: ${totalTrades}`);
      console.log(`胜率: ${winRate.toFixed(2)}%`);
      console.log(`最大回撤: ${maxDrawdown.toFixed(2)} (${((maxDrawdown / peakBalance) * 100).toFixed(2)}%)`);
      console.log('===============');

      return { finalBalance, totalProfit, monthlyRate, totalTrades, winRate, maxDrawdown };
    } catch (error) {
      console.error('错误: 回测过程中发生异常:', error.message);
      return null;
    }
  }
}

module.exports = new Backtest();