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
      setInterval(() => {
        this.syncTime().catch(err => console.error('定时同步时间失败：', err.message));
      }, 60 * 60 * 1000);
    } catch (error) {
      console.error('初始化RestAPI时出错：', error.message);
    }
  }

  async syncTime() {
    try {
      const serverTime = await this.binance.futuresTime();
      this.timeOffset = serverTime - Date.now();
      console.log('时间已同步，偏移量：', this.timeOffset);
    } catch (error) {
      console.error('同步时间时出错：', error.message);
      this.timeOffset = 0;
    }
  }

  async getSymbolPrecision(symbol) {
    try {
      const exchangeInfo = await this.binance.futuresExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
      if (!symbolInfo) throw new Error('交易对未找到');
      return { 
        quantityPrecision: symbolInfo.quantityPrecision || 3, 
        pricePrecision: symbolInfo.pricePrecision || 2 
      };
    } catch (error) {
      console.error('获取交易对精度时出错：', error.message);
      return { quantityPrecision: 3, pricePrecision: 2 };
    }
  }

  async placeOrder(symbol, side, quantity) {
    try {
      if (!symbol || !side || !quantity || quantity <= 0) {
        console.log('无效的订单参数，跳过');
        return null;
      }
      const validSides = ['BUY', 'SELL'];
      if (!validSides.includes(side.toUpperCase())) {
        throw new Error('无效的交易方向');
      }
      const precision = await this.getSymbolPrecision(symbol);
      const adjustedQuantity = Number(quantity.toFixed(precision.quantityPrecision));
      const order = await this.binance.futuresOrder(side, symbol, adjustedQuantity, null, { type: 'MARKET' });
      console.log('订单已成功下单：', order);
      return order;
    } catch (error) {
      console.error('下单时出错：', error.message);
      throw error;
    }
  }

  async placeTrailingStopOrder(symbol, side, quantity, callbackRate) {
    try {
      if (!symbol || !side || !quantity || quantity <= 0 || typeof callbackRate !== 'number') {
        console.log('无效的跟踪止损订单参数，跳过');
        return null;
      }
      const validSides = ['BUY', 'SELL'];
      if (!validSides.includes(side.toUpperCase())) {
        throw new Error('无效的交易方向');
      }
      const precision = await this.getSymbolPrecision(symbol);
      const roundedQuantity = Number(quantity.toFixed(precision.quantityPrecision));
      const order = await this.binance.futuresOrder(side, symbol, roundedQuantity, null, {
        type: 'TRAILING_STOP_MARKET',
        callbackRate: callbackRate,
        reduceOnly: true
      });
      logger.info(`跟踪止损订单已下单：${JSON.stringify(order)}`);
      return order;
    } catch (error) {
      console.error('下跟踪止损订单时出错：', error.message);
      throw error;
    }
  }

  async placeOrderWithSLTP(symbol, side, quantity, stopLoss, takeProfit) {
    try {
      const precision = await this.getSymbolPrecision(symbol);
      const adjustedQuantity = Number(quantity.toFixed(precision.quantityPrecision));
      // Place market order
      const marketOrder = await this.binance.futuresOrder(side, symbol, adjustedQuantity, null, { type: 'MARKET' });
      console.log('Market order placed:', marketOrder);
      // Determine opposite side
      const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
      // Place STOP_MARKET for SL if provided
      if (stopLoss) {
        const slPrice = Number(stopLoss.toFixed(precision.pricePrecision));
        const slOrder = await this.binance.futuresOrder(oppositeSide, symbol, adjustedQuantity, null, {
          type: 'STOP_MARKET',
          stopPrice: slPrice,
          reduceOnly: true
        });
        console.log('Stop Loss order placed:', slOrder);
      }
      // Place TAKE_PROFIT_MARKET for TP if provided
      if (takeProfit) {
        const tpPrice = Number(takeProfit.toFixed(precision.pricePrecision));
        const tpOrder = await this.binance.futuresOrder(oppositeSide, symbol, adjustedQuantity, null, {
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: tpPrice,
          reduceOnly: true
        });
        console.log('Take Profit order placed:', tpOrder);
      }
      return marketOrder;
    } catch (error) {
      console.error('Error placing order with SL/TP:', error.message);
      throw error;
    }
  }

  async cancelOrder(symbol, orderId) {
    try {
      await this.binance.futuresCancel({ symbol, orderId });
      logger.info(`已取消订单：${orderId} 针对 ${symbol}`);
    } catch (error) {
      console.error(`取消订单 ${orderId} 时出错：`, error.message);
    }
  }

  async getAccount() {
    try {
      const timestamp = Date.now() + (this.timeOffset || 0);
      const account = await this.binance.futuresAccount({ timestamp });
      if (!account || !account.totalMarginBalance) throw new Error('账户信息无效');
      return account;
    } catch (error) {
      console.error('获取账户信息时出错：', error.message);
      return null;
    }
  }

  async getFundingRate(symbol) {
    try {
      if (!symbol) throw new Error('交易对无效');
      const fundingRates = await this.binance.futuresFundingRate({ symbol });
      if (!Array.isArray(fundingRates) || fundingRates.length === 0) {
        console.error('无资金费率数据');
        return 0;
      }
      const rate = parseFloat(fundingRates[fundingRates.length - 1].fundingRate) || 0;
      return rate;
    } catch (error) {
      console.error('获取资金费率时出错：', error.message);
      return 0;
    }
  }
  

  async getOpenOrders(symbol) {
    try {
      const timestamp = Date.now() + (this.timeOffset || 0);
      const response = await this.binance.futuresOpenOrders({ symbol, timestamp });
      if (!Array.isArray(response)) {
        console.error('Binance API returned non-array response:', response);
        return [];
      }
      console.log('已获取挂单，数量：', response.length);
      return response;
    } catch (error) {
      console.error('获取挂单时出错：', error.message);
      return [];
    }
  }

  async cancelAllOrders(symbol) {
    try {
      await this.binance.futuresCancelAll({ symbol });
      console.log(`已取消${symbol}的所有挂单`);
    } catch (error) {
      console.error(`取消${symbol}的所有挂单时出错：`, error.message);
    }
  }

  async getOrderStatus(symbol, orderId) {
    try {
      const timestamp = Date.now() + (this.timeOffset || 0);
      const status = await this.binance.futuresOrderStatus({ symbol, orderId, timestamp });
      return status;
    } catch (error) {
      console.error(`获取订单${orderId}状态失败：`, error.message);
      return null;
    }
  }
}

module.exports = new RestAPI();