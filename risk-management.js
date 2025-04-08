const tulind = require('tulind');
const config = require('./config.json');

class RiskManagement {
  constructor() {
    this.atrPeriod = 14;
  }

  async calculateATR(klineData) {
    try {
      if (!Array.isArray(klineData) || klineData.length < this.atrPeriod) {
        console.log('警告: K线数据不足以计算ATR，返回默认值');
        return 0;
      }
      const highs = klineData.map(k => parseFloat(k.h) || 0);
      const lows = klineData.map(k => parseFloat(k.l) || 0);
      const closes = klineData.map(k => parseFloat(k.c) || 0);
      const atrResult = await tulind.indicators.atr.indicator([highs, lows, closes], [this.atrPeriod]);
      return atrResult[0][atrResult[0].length - 1] || 0;
    } catch (error) {
      console.error('错误: ATR计算失败:', error.message);
      return 0;
    }
  }

  calculateOrderSize(totalBalance, atr, leverage) {
    try {
      if (!totalBalance || !atr || !leverage || atr <= 0) {
        console.log('警告: 仓位计算参数无效，返回默认值');
        return 0;
      }
      const riskAmount = totalBalance * config.riskPerTrade;
      const maxInitialMargin = totalBalance * 0.2;
      const maxNotional = maxInitialMargin * leverage;
      return Math.min((riskAmount / atr) * leverage, maxNotional);
    } catch (error) {
      console.error('错误: 仓位大小计算失败:', error.message);
      return 0;
    }
  }

  async validateOrder(account, orderSize, atr) {
    try {
      if (!account || !account.totalMarginBalance || !orderSize || !atr) {
        console.log('警告: 订单验证参数无效，使用默认止损止盈');
        return { stopLoss: atr * 2, takeProfit: atr * 3 };
      }
      const totalBalance = parseFloat(account.totalMarginBalance) || 0;
      const marginUsed = orderSize / config.leverage;
      if (marginUsed > totalBalance * 0.2) {
        throw new Error('保证金超过20%限制');
      }
      const stopLoss = atr * 2;
      const takeProfit = atr * 3;
      return { stopLoss, takeProfit };
    } catch (error) {
      console.error('错误: 订单验证失败:', error.message);
      return { stopLoss: atr * 2 || 0, takeProfit: atr * 3 || 0 };
    }
  }
}

module.exports = new RiskManagement();