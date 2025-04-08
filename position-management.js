const RestAPI = require('./rest-api');
const config = require('./config.json');

class PositionManagement {
  constructor() {
    this.monitoring = false;
  }

  async startMonitoring() {
    try {
      if (this.monitoring) return;
      this.monitoring = true;
      console.log('开始实时监控仓位');

      setInterval(async () => {
        try {
          const account = await RestAPI.getAccount();
          if (!account || !account.positions) {
            console.log('警告: 账户信息或仓位数据无效，跳过监控');
            return;
          }

          const positions = account.positions.filter(p => (parseFloat(p.positionAmt) || 0) !== 0);
          if (!positions.length) return;

          positions.forEach(pos => {
            console.log(`监控仓位: ${pos.symbol}, 数量: ${pos.positionAmt}, 未实现盈亏: ${pos.unrealizedProfit || 'N/A'}`);
          });
        } catch (error) {
          console.error('错误: 仓位监控失败:', error.message);
        }
      }, 5000);
    } catch (error) {
      console.error('错误: 启动仓位监控失败:', error.message);
    }
  }

  managePositions(positions) {
    try {
      if (!Array.isArray(positions)) {
        console.log('警告: 仓位数据无效，跳过管理');
        return;
      }
      positions.forEach(position => {
        console.log('管理仓位:', position.symbol, position.positionAmt);
      });
    } catch (error) {
      console.error('错误: 管理仓位失败:', error.message);
    }
  }
}

module.exports = new PositionManagement();