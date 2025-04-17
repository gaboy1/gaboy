const tulind = require('tulind');
const config = require('./config.json');
//突破高低点，顺势追多/追空。
class BreakoutStrategy {
  static async analyze(secondKlines, account, currentPrice) {
    const highs = secondKlines.map(k => k.h);
    const lows = secondKlines.map(k => k.l);
    const recentHigh = Math.max(...highs.slice(-20));
    const recentLow = Math.min(...lows.slice(-20));

    let desiredPosition;
    if (currentPrice > recentHigh) {
      desiredPosition = 'long';
    } else if (currentPrice < recentLow) {
      desiredPosition = 'short';
    } else {
      desiredPosition = 'flat';
    }

    const position = account.positions?.find(p => p.symbol === config.symbols[0]) || { positionAmt: '0' };
    const positionAmt = parseFloat(position.positionAmt) || 0;
    const isLong = positionAmt > 0;
    const isShort = positionAmt < 0;
    const isFlat = positionAmt === 0;

    let action;
    if (desiredPosition === 'long' && !isLong) {
      action = 'long';
    } else if (desiredPosition === 'short' && !isShort) {
      action = 'short';
    } else if (desiredPosition === 'flat' && (isLong || isShort)) {
      action = isLong ? 'close_long' : 'close_short';
    } else {
      action = 'hold';
    }

    let positionSize = 0;
    if (action === 'long' || action === 'short') {
      const closes = secondKlines.map(k => k.c);
      let atr = 0;
      try {
        const atrResult = await tulind.indicators.atr.indicator([highs, lows, closes], [14]);
        atr = atrResult[0][atrResult[0].length - 1] || 0;
      } catch (error) {
        console.error('错误: ATR计算失败，使用默认值:', error.message);
        atr = currentPrice * 0.01;
      }

      const totalBalance = parseFloat(account.totalMarginBalance);
      const availableBalance = parseFloat(account.availableBalance);
      const riskBasedSize = (totalBalance * config.riskPerTrade) / (atr || 1);
      const leverage = config.leverage;
      const maxInitialMargin = 0.2 * availableBalance;
      const maxNotional = maxInitialMargin * leverage;
      const maxQ = maxNotional / (currentPrice || 1);
      positionSize = Math.min(riskBasedSize, maxQ);
    }

    return { action, size: positionSize };
  }
}

module.exports = BreakoutStrategy;