const tulind = require('tulind');
const config = require('./config.json');
const ARIMA = require('arima');
//ARIMA模型，适合震荡行情
class SidewaysStrategy {
  static async analyze(secondKlines, account, currentPrice) {
    const closes = secondKlines.map(k => k.c);
    const ts = closes.slice(-200);
    let arima;
    try {
      arima = new ARIMA({ p: 'auto', d: 'auto', q: 'auto', verbose: false }).train(ts);
    } catch (error) {
      console.error('错误: ARIMA训练失败，使用默认保持:', error.message);
      return { action: 'hold', size: 0 };
    }

    const [pred, errors] = arima.predict(1);
    const delta = pred[0] - currentPrice;
    const threshold = 3 * errors[0];

    let desiredPosition;
    if (delta > threshold) {
      desiredPosition = 'long';
    } else if (delta < -threshold) {
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

module.exports = SidewaysStrategy;