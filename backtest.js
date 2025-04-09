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
        console.error('Error parsing CSV file:', error.message);
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

      for (let i = this.minDataPoints - 1; i < historicalData.length; i++) {
        const klineData = historicalData.slice(i - this.minDataPoints + 1, i + 1);
        const currentKline = historicalData[i];

        // Update positions with trailing stop
        for (let j = positions.length - 1; j >= 0; j--) {
          const pos = positions[j];
          if (pos.isLong) {
            pos.highestPriceSinceEntry = Math.max(pos.highestPriceSinceEntry, currentKline.h);
            const stopLevel = pos.highestPriceSinceEntry - (pos.atr * pos.multiplier);
            if (currentKline.l <= stopLevel) {
              const exitPrice = Math.max(stopLevel, currentKline.o); // assume worst case
              const profit = (exitPrice - pos.entryPrice) * pos.size;
              balance += profit;
              trades.push({
                entryTime: pos.entryTime,
                exitTime: currentKline.t,
                entryPrice: pos.entryPrice,
                exitPrice: exitPrice,
                size: pos.size,
                profit: profit,
                isLong: pos.isLong
              });
              console.log(`Closed long position at ${exitPrice}, profit: ${profit}`);
              positions.splice(j, 1);
            }
          } else {
            pos.lowestPriceSinceEntry = Math.min(pos.lowestPriceSinceEntry, currentKline.l);
            const stopLevel = pos.lowestPriceSinceEntry + (pos.atr * pos.multiplier);
            if (currentKline.h >= stopLevel) {
              const exitPrice = Math.min(stopLevel, currentKline.o); // assume worst case
              const profit = (pos.entryPrice - exitPrice) * pos.size;
              balance += profit;
              trades.push({
                entryTime: pos.entryTime,
                exitTime: currentKline.t,
                entryPrice: pos.entryPrice,
                exitPrice: exitPrice,
                size: pos.size,
                profit: profit,
                isLong: pos.isLong
              });
              console.log(`Closed short position at ${exitPrice}, profit: ${profit}`);
              positions.splice(j, 1);
            }
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
          console.error('Error in strategy analysis:', error.message);
          decision = { action: 'hold', size: 0, atr: 0, multiplier: 0 };
        }

        if (decision.action === 'long' && positions.length === 0) {
          const entryPrice = currentKline.c;
          const position = {
            isLong: true,
            entryPrice: entryPrice,
            highestPriceSinceEntry: entryPrice,
            size: decision.size,
            atr: decision.atr,
            multiplier: decision.multiplier,
            entryTime: currentKline.t
          };
          positions.push(position);
          console.log(`Opened long position at ${entryPrice}, size: ${decision.size}`);
        } else if (decision.action === 'short' && positions.length === 0) {
          const entryPrice = currentKline.c;
          const position = {
            isLong: false,
            entryPrice: entryPrice,
            lowestPriceSinceEntry: entryPrice,
            size: decision.size,
            atr: decision.atr,
            multiplier: decision.multiplier,
            entryTime: currentKline.t
          };
          positions.push(position);
          console.log(`Opened short position at ${entryPrice}, size: ${decision.size}`);
        }
      }

      // Close any remaining positions at the last price
      for (const pos of positions) {
        const lastPrice = historicalData[historicalData.length - 1].c;
        const profit = pos.isLong ? (lastPrice - pos.entryPrice) * pos.size : (pos.entryPrice - lastPrice) * pos.size;
        balance += profit;
        trades.push({
          entryTime: pos.entryTime,
          exitTime: historicalData[historicalData.length - 1].t,
          entryPrice: pos.entryPrice,
          exitPrice: lastPrice,
          size: pos.size,
          profit: profit,
          isLong: pos.isLong
        });
        console.log(`Closed remaining ${pos.isLong ? 'long' : 'short'} position at ${lastPrice}, profit: ${profit}`);
      }

      const finalBalance = balance;
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
      console.error('Error in backtest:', error.message);
      return null;
    }
  }
}

module.exports = new Backtest();