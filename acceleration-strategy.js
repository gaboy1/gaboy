const tulind = require('tulind');
const config = require('./config.json');
//RSI超买超卖，抓住转折点。
class AccelerationStrategy {
  static async analyze(secondKlines, account, currentPrice) {
    const closes = secondKlines.map(k => k.c);
    let rsi = 0;
    try {
      const rsiResult = await tulind.indicators.rsi.indicator([closes], [14]);
      rsi = rsiResult[0][rsiResult[0].length - 1] || 0;
    } catch (error) {
      console.error('错误: RSI计算失败，使用默认值:', error.message);
      rsi = 0;
    }

    let desiredPosition;
    if (rsi > 80) {
      desiredPosition = 'short'; // 超买，预期反转
    } else if (rsi < 20) {
      desiredPosition = 'long'; // 超卖，预期反弹
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
      const highs = secondKlines.map(k => k.h);
      const lows = secondKlines.map(k => k.l);
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

module.exports = AccelerationStrategy;