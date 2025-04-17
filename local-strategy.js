const tulind = require('tulind');
const config = require('./config.json');
const SidewaysStrategy = require('./sideways-strategy');
const TrendingStrategy = require('./trending-strategy');
const BreakoutStrategy = require('./breakout-strategy');
const FalseBreakoutStrategy = require('./false-breakout-strategy');
const AccelerationStrategy = require('./acceleration-strategy');
const NewsDrivenStrategy = require('./news-driven-strategy');

class LocalStrategy {
  async analyze({ secondKlines, account, fundingRate = 0, orderBook = { bids: [], asks: [] } }) {
    try {
      // 检查账户数据
      if (!account || !account.totalMarginBalance || isNaN(parseFloat(account.totalMarginBalance))) {
        console.error('错误: 账户信息无效或余额数据缺失，无法执行策略');
        throw new Error('Invalid account data');
      }
      if (!account.availableBalance || isNaN(parseFloat(account.availableBalance))) {
        console.error('错误: 可用余额数据无效，无法执行策略');
        throw new Error('Invalid available balance');
      }

      const totalBalance = parseFloat(account.totalMarginBalance);
      const availableBalance = parseFloat(account.availableBalance);

      if (totalBalance <= 0 || availableBalance <= 0) {
        console.error('错误: 账户余额不足，无法交易', { totalBalance, availableBalance });
        return { action: 'hold', size: 0 };
      }

      if (!Array.isArray(secondKlines) || secondKlines.length < 50) {
        console.log('秒级K线数据不足:', secondKlines?.length || 0);
        return { action: 'hold', size: 0 };
      }

      const closes = secondKlines.map(k => k.c);
      const highs = secondKlines.map(k => k.h);
      const lows = secondKlines.map(k => k.l);
      const volumes = secondKlines.map(k => k.v);
      const currentPrice = closes[closes.length - 1];

      // 检测市场状态
      let marketCondition = await this.detectMarketCondition(highs, lows, closes, volumes);
      console.log('当前市场状态:', marketCondition);

      // 根据市场状态选择策略
      let action = 'hold';
      let positionSize = 0;

      switch (marketCondition) {
        case 'sideways':
          ({ action, size: positionSize } = await SidewaysStrategy.analyze(secondKlines, account, currentPrice));
          break;
        case 'trending':
          ({ action, size: positionSize } = await TrendingStrategy.analyze(secondKlines, account, currentPrice));
          break;
        case 'breakout':
          ({ action, size: positionSize } = await BreakoutStrategy.analyze(secondKlines, account, currentPrice));
          break;
        case 'false_breakout':
          ({ action, size: positionSize } = await FalseBreakoutStrategy.analyze(secondKlines, account, currentPrice));
          break;
        case 'acceleration':
          ({ action, size: positionSize } = await AccelerationStrategy.analyze(secondKlines, account, currentPrice));
          break;
        case 'news_driven':
          ({ action, size: positionSize } = await NewsDrivenStrategy.analyze(secondKlines, account, currentPrice));
          break;
        default:
          console.log('未知市场状态，保持现状');
          return { action: 'hold', size: 0 };
      }

      return { action, size: positionSize };
    } catch (error) {
      console.error('错误: 策略分析发生异常:', error.message);
      return { action: 'hold', size: 0 };
    }
  }

  async detectMarketCondition(highs, lows, closes, volumes, previousCondition = null, persistenceCount = 0) {
    let adx = 0, bbWidth = 0, rsi = 0;
    try {
      const adxResult = await tulind.indicators.adx.indicator([highs, lows, closes], [14]);
      adx = adxResult[0][adxResult[0].length - 1] || 0;
      const bbResult = await tulind.indicators.bbands.indicator([closes], [20, 2]);
      const upper = bbResult[0][bbResult[0].length - 1];
      const lower = bbResult[2][bbResult[0].length - 1];
      const middle = bbResult[1][bbResult[0].length - 1];
      bbWidth = (upper - lower) / middle;
      const rsiResult = await tulind.indicators.rsi.indicator([closes], [14]);
      rsi = rsiResult[0][rsiResult[0].length - 1] || 0;
    } catch (error) {
      console.error('错误: 指标计算失败:', error.message);
      return previousCondition || 'unknown';
    }
  
    const recentVolumes = volumes.slice(-5);
    const avgVolume = recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
    const latestVolume = volumes[volumes.length - 1];
    const volumeSpike = latestVolume > avgVolume * 2;
  
    let newCondition;
    if (adx < 25 && bbWidth < 0.1) {
      newCondition = 'sideways';
    } else if (adx > 25 && rsi > 70) {
      newCondition = 'trending';
    } else if (volumeSpike && bbWidth > 0.15) {
      newCondition = 'breakout';
    } else if (adx < 25 && rsi > 70 && !volumeSpike) {
      newCondition = 'false_breakout';
    } else if (adx > 40 && rsi > 80) {
      newCondition = 'acceleration';
    } 
    else {
      newCondition = 'unknown';//  newCondition = 'news_driven';
    }
  
    // 持久性检查
    if (previousCondition && newCondition !== previousCondition) {
      if (persistenceCount < 5) {
        return previousCondition; // 持续5周期后才切换
      }
    }
  
    return newCondition;
  }
}

module.exports = new LocalStrategy();