const Binance = require('node-binance-api');
const config = require('./config.json');
const envConfig = config[config.environment] || config.test;
const winston = require('winston');

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

class RestAPI {
  constructor() {
    try {
      this.binance = new Binance().options({
        APIKEY: envConfig.apiKey || '',
        APISECRET: envConfig.secretKey || '',
        baseURL: envConfig.baseUrl || 'https://testnet.binancefuture.com',
        test: config.environment === 'test',
        useServerTime: true,
        recvWindow: 10000,
        family: 4
      });
      this.timeOffset = 0;
      this.syncTime();
      setInterval(() => this.syncTime(), 60 * 60 * 1000);
    } catch (error) {
      console.error('错误: 初始化RestAPI失败:', error.message);
    }
  }

  async syncTime() {
    try {
      const serverTime = await this.binance.futuresTime();
      this.timeOffset = serverTime - Date.now();
      console.log('时间同步成功，偏移量:', this.timeOffset);
    } catch (error) {
      console.error('错误: 时间同步失败:', error.message);
      this.timeOffset = 0;
    }
  }

  async getSymbolPrecision(symbol) {
    try {
      const exchangeInfo = await this.binance.futuresExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
      if (!symbolInfo) throw new Error('交易对未找到');
      return { quantityPrecision: symbolInfo.quantityPrecision || 3, pricePrecision: symbolInfo.pricePrecision || 2 };
    } catch (error) {
      console.error('错误: 获取交易对精度失败:', error.message);
      return { quantityPrecision: 3, pricePrecision: 2 };
    }
  }

  async placeOrder(symbol, side, quantity) {
    try {
      if (!symbol || !side || !quantity || quantity <= 0) {
        console.log('警告: 订单参数无效，跳过下单');
        return null;
      }
      const precision = await this.getSymbolPrecision(symbol);
      const adjustedQuantity = Number(quantity.toFixed(precision.quantityPrecision));
      const order = await this.binance.futuresOrder(side, symbol, adjustedQuantity, null, { type: 'MARKET' });
      console.log('订单提交成功:', order);
      return order;
    } catch (error) {
      console.error('错误: 订单提交失败:', error.message);
      throw error;
    }
  }

  async placeOrderWithSLTP(symbol, side, quantity, stopLossPrice, takeProfitPrice) {
    try {
      if (!symbol || !side || !quantity || quantity <= 0 || !stopLossPrice || !takeProfitPrice) {
        console.log('警告: 订单参数无效，跳过下单');
        return null;
      }
      const precision = await this.getSymbolPrecision(symbol);
      const roundedQuantity = Number(quantity.toFixed(precision.quantityPrecision));
      const roundedStopLoss = Number(stopLossPrice.toFixed(precision.pricePrecision));
      const roundedTakeProfit = Number(takeProfitPrice.toFixed(precision.pricePrecision));

      const marketOrder = await this.binance.futuresOrder(side, symbol, roundedQuantity, null, { type: 'MARKET' });
      logger.info('市价订单已提交:', marketOrder);

      const slSide = side === 'BUY' ? 'SELL' : 'BUY';
      const tpSide = slSide;

      const slOrder = await this.binance.futuresOrder(slSide, symbol, roundedQuantity, null, {
        type: 'STOP_MARKET',
        stopPrice: roundedStopLoss,
        reduceOnly: true
      });
      logger.info('止损订单已提交:', slOrder);

      const tpOrder = await this.binance.futuresOrder(tpSide, symbol, roundedQuantity, null, {
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: roundedTakeProfit,
        reduceOnly: true
      });
      logger.info('止盈订单已提交:', tpOrder);

      return { marketOrder, slOrder, tpOrder };
    } catch (error) {
      console.error('错误: 开仓及设置止损止盈失败:', error.message);
      throw error;
    }
  }

  async getAccount() {
    try {
        const timestamp = Date.now() + (this.timeOffset || 0);
        return await this._callWithRetry(() => this.binance.futuresAccount({ timestamp }));
    } catch (error) {
        console.error('错误: 获取账户信息失败:', error.message);
        return null;
    }
}

  async getFundingRate(symbol) {
    try {
      if (!symbol) throw new Error('交易对无效');
      const fundingRates = await this.binance.futuresFundingRate({ symbol });
      const rate = parseFloat(fundingRates[fundingRates.length - 1].fundingRate) || 0;
      console.log('获取资金费率成功:', rate);
      return rate;
    } catch (error) {
      console.error('错误: 获取资金费率失败:', error.message);
      return 0;
    }
  }

  async getOpenInterest(symbol) {
    try {
      if (!symbol) throw new Error('交易对无效');
      const openInterest = await this.binance.futuresOpenInterest({ symbol });
      const value = parseFloat(openInterest.openInterest) || 0;
      console.log('获取持仓量成功:', value);
      return value;
    } catch (error) {
      console.error('错误: 获取持仓量失败:', error.message);
      return 0;
    }
  }

  async getOpenOrders(symbol) {
    try {
      if (!symbol) throw new Error('交易对无效');
      const timestamp = Date.now() + (this.timeOffset || 0);
      const openOrders = await this.binance.futuresOpenOrders({ symbol, timestamp });
      console.log('获取未完成订单成功，数量:', openOrders.length);
      return openOrders || [];
    } catch (error) {
      console.error('错误: 获取未完成订单失败:', error.message);
      return [];
    }
  }

  async _callWithRetry(func) {
    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
        try {
            return await func();
        } catch (error) {
            if (error.code === -1128 || (error.response && error.response.status === 429)) {
                const delay = Math.pow(2, retries) * 1000;
                console.log(`Rate limit exceeded. Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                retries++;
            } else {
                throw error;
            }
        }
    }
    throw new Error('Max retries exceeded');
}
}

module.exports = new RestAPI();