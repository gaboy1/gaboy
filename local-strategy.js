const tulind = require('tulind');
const config = require('./config.json');

class LocalStrategy {
  async analyze({ klineData, account, sentiment = 'neutral', fundingRate = 0, orderBook = { bids: [], asks: [] }, trades = [], macroData = {} }) {
    try {
      if (!Array.isArray(klineData) || klineData.length < 50|| !klineData.every(isValidKline)) {
        console.log('数据不足:', klineData?.length || 0);
        return { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
      }
      if (!account || !account.totalMarginBalance) {
        console.log('警告: 账户信息无效，采取保持行动');
        return { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
      }
      

      const totalBalance = parseFloat(account.totalMarginBalance) || 10000;
      const availableBalance = parseFloat(account.availableBalance) || totalBalance;

      const closes = klineData.map(k => parseFloat(k.c) || 0);
      const highs = klineData.map(k => parseFloat(k.h) || 0);
      const lows = klineData.map(k => parseFloat(k.l) || 0);
      const volumes = klineData.map(k => parseFloat(k.v) || 0);
      const currentPrice = closes[closes.length - 1] || 0;
      const previousPrice = closes[closes.length - 2] || 0;
      const currentVolume = volumes[volumes.length - 1] || 0;

      function isValidKline(kline) {
        const c = parseFloat(kline.c);
        const h = parseFloat(kline.h);
        const l = parseFloat(kline.l);
        const o = parseFloat(kline.o);
        const v = parseFloat(kline.v);
        return (
            !isNaN(c) && c > 0 &&
            !isNaN(h) && h >= c &&
            !isNaN(l) && l <= c &&
            !isNaN(o) && o > 0 &&
            !isNaN(v) && v >= 0
        );
    }
      // ATR 计算
      let atr = 0;
      try {
        const atrResult = await tulind.indicators.atr.indicator([highs, lows, closes], [14]);
        atr = atrResult[0][atrResult[0].length - 1] || 0;
      } catch (error) {
        console.error('错误: ATR计算失败，使用默认值:', error.message);
        atr = currentPrice * 0.01; // 默认1%波动
      }
      const atrRatio = atr / (currentPrice || 1);

      // ADX 计算
      let adx = 24;
      try {
        const adxResult = await tulind.indicators.adx.indicator([highs, lows, closes], [14]);
        adx = adxResult[0][adxResult[0].length - 1] || 24;
      } catch (error) {
        console.log('ADX计算失败，使用默认值24:', error.message);
      }

      // MACD 计算
      let macdLine = 0, signalLine = 0;
      try {
        const macdResult = await tulind.indicators.macd.indicator([closes], [12, 26, 9]);
        macdLine = macdResult[0][macdResult[0].length - 1] || 0;
        signalLine = macdResult[1][macdResult[1].length - 1] || 0;
      } catch (error) {
        console.error('错误: MACD计算失败，使用默认值:', error.message);
      }

      // RSI 计算
      let rsi = 50;
      try {
        const rsiResult = await tulind.indicators.rsi.indicator([closes], [config.rsiPeriod]);
        rsi = rsiResult[0][rsiResult[0].length - 1] || 50;
      } catch (error) {
        console.error('错误: RSI计算失败，使用默认值50:', error.message);
      }

      // OBV 计算
      let obv = [];
      try {
        const obvResult = await tulind.indicators.obv.indicator([closes, volumes]);
        obv = obvResult[0] || [];
      } catch (error) {
        console.error('错误: OBV计算失败，使用默认空值:', error.message);
      }

      // 动态参数
      let breakoutPeriod = 10, bbPeriod = 15, atrMultiplier = 3, takeProfitMultiplier = 4, volumeFilter = true;
      try {
        if (atrRatio > 0.05) {
          breakoutPeriod = 5;
          bbPeriod = 10;
          atrMultiplier = 4;
          takeProfitMultiplier = 6;
          volumeFilter = false;
        } else if (atrRatio > 0.01) {
          breakoutPeriod = 10;
          bbPeriod = 15;
          atrMultiplier = 3;
          takeProfitMultiplier = 4;
          volumeFilter = true;
        } else {
          breakoutPeriod = 20;
          bbPeriod = 20;
          atrMultiplier = 2;
          takeProfitMultiplier = 3;
          volumeFilter = true;
        }
      } catch (error) {
        console.error('错误: 动态参数设置失败，使用默认值:', error.message);
      }

      const stopLossDistance = atrMultiplier * atr;
      const takeProfitDistance = takeProfitMultiplier * atr;

      // 市场微观结构
      const bidPrice = orderBook.bids.length ? parseFloat(orderBook.bids[0][0]) || currentPrice : currentPrice;
      const askPrice = orderBook.asks.length ? parseFloat(orderBook.asks[0][0]) || currentPrice : currentPrice;
      const spread = askPrice - bidPrice;
      const spreadPercentage = (spread / (currentPrice || 1)) * 100;
      if (spreadPercentage > 0.01) {
        console.log('买卖价差过大:', spreadPercentage, '%，跳过交易');
        return { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
      }

      const largeTrades = trades.filter(t => (parseFloat(t.q) || 0) > 10);
      const netLargeVolume = largeTrades.reduce((sum, t) => sum + (t.m ? -(parseFloat(t.q) || 0) : (parseFloat(t.q) || 0)), 0);

      // 成交量分布
      let volumeProfile;
      try {
        volumeProfile = this.calculateVolumeProfile(trades);
      } catch (error) {
        console.error('错误: 成交量分布计算失败:', error.message);
        volumeProfile = [];
      }
      const support = volumeProfile.length ? Math.min(...volumeProfile) : currentPrice - atr;
      const resistance = volumeProfile.length ? Math.max(...volumeProfile) : currentPrice + atr;

      // 宏观因素
      const dxy = parseFloat(macroData.dxy) || 100;
      const dxyThreshold = 105;
      if (dxy > dxyThreshold) {
        console.log('美元指数过高:', dxy, '，倾向看空');
      }

      // 策略逻辑
      let action = 'hold';
      try {
        if (adx > 25) {
          const recentData = klineData.slice(-breakoutPeriod);
          const highestHigh = Math.max(...recentData.map(k => parseFloat(k.h) || 0));
          const lowestLow = Math.min(...recentData.map(k => parseFloat(k.l) || 0));
          const avgVolume = recentData.reduce((sum, k) => sum + (parseFloat(k.v) || 0), 0) / breakoutPeriod;
          const smaResult = await tulind.indicators.sma.indicator([closes], [50]);
          const sma = smaResult[0][smaResult[0].length - 1] || currentPrice;

          if (currentPrice > highestHigh && (!volumeFilter || currentVolume > 1.5 * avgVolume) && currentPrice > sma && macdLine > signalLine) {
            action = 'long';
          } else if (currentPrice < lowestLow && (!volumeFilter || currentVolume > 1.5 * avgVolume) && currentPrice < sma && macdLine < signalLine) {
            action = 'short';
          }
        } else {
          const bbResult = await tulind.indicators.bbands.indicator([closes], [bbPeriod, 2]);
          const upper = bbResult[0][bbResult[0].length - 1] || currentPrice + atr;
          const lower = bbResult[2][bbResult[0].length - 1] || currentPrice - atr;
          if (currentPrice < lower && rsi < 30) {
            action = 'long';
          } else if (currentPrice > upper && rsi > 70) {
            action = 'short';
          }
        }
      } catch (error) {
        console.error('错误: 策略逻辑执行失败，使用默认保持:', error.message);
        action = 'hold';
      }

      // OBV 过滤
      if (action === 'long' && !(obv.length >= 2 && obv[obv.length - 1] > obv[obv.length - 2])) {
        console.log('OBV未上升，跳过开多');
        action = 'hold';
      } else if (action === 'short' && !(obv.length >= 2 && obv[obv.length - 1] < obv[obv.length - 2])) {
        console.log('OBV未下降，跳过开空');
        action = 'hold';
      }

      // 其他过滤条件
      if (action === 'long') {
        if (sentiment !== 'bullish' || fundingRate > 0.01 || netLargeVolume < 0 || dxy > dxyThreshold) {
          console.log('开多条件未满足:', { sentiment, fundingRate, netLargeVolume, dxy });
          action = 'hold';
        }
      } else if (action === 'short') {
        if (sentiment !== 'bearish' || fundingRate < -0.01 || netLargeVolume > 0 || dxy < 95) {
          console.log('开空条件未满足:', { sentiment, fundingRate, netLargeVolume, dxy });
          action = 'hold';
        }
      }

      if (action !== 'hold') {
        const riskBasedSize = (totalBalance * config.riskPerTrade) / (stopLossDistance || 1);
        const leverage = config.leverage;
        const maxInitialMargin = 0.2 * availableBalance;
        const maxNotional = maxInitialMargin * leverage;
        const maxQ = maxNotional / (currentPrice || 1);
        const positionSize = Math.min(riskBasedSize, maxQ);
        const stopLoss = action === 'long' ? currentPrice - stopLossDistance : currentPrice + stopLossDistance;
        const takeProfit = action === 'long' ? currentPrice + takeProfitDistance : currentPrice - takeProfitDistance;
        return { action, size: positionSize, stopLoss, takeProfit };
      }
      return { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
    } catch (error) {
      console.error('错误: 策略分析发生异常:', error.message);
      return { action: 'hold', size: 0, stopLoss: 0, takeProfit: 0 };
    }
  }

  calculateVolumeProfile(trades) {
    try {
      if (!Array.isArray(trades)) {
        console.log('警告: 交易数据无效，返回空成交量分布');
        return [];
      }
      const binSize = 50;
      const volumeProfile = {};
      trades.forEach(trade => {
        const price = parseFloat(trade.p) || 0;
        const bin = Math.floor(price / binSize) * binSize;
        volumeProfile[bin] = (volumeProfile[bin] || 0) + (parseFloat(trade.q) || 0);
      });
      const sortedBins = Object.entries(volumeProfile).sort((a, b) => b[1] - a[1]);
      return sortedBins.slice(0, 5).map(entry => parseFloat(entry[0]));
    } catch (error) {
      console.error('错误: 计算成交量分布失败:', error.message);
      return [];
    }
  }
}

module.exports = new LocalStrategy();