const axios = require('axios');
const tf = require('@tensorflow/tfjs');
const config = require('./config.json');

class DeepAI {
  constructor() {
    this.model = null;
  }

  async trainModel(historicalData) {
    try {
      if (!Array.isArray(historicalData) || historicalData.length === 0) {
        console.log('警告: 历史数据无效或为空，无法训练模型');
        return;
      }
      const inputs = tf.tensor2d(historicalData.map(d => [parseFloat(d.close) || 0, parseFloat(d.volume) || 0]), [historicalData.length, 2]);
      const labels = tf.tensor2d(historicalData.map(d => (parseFloat(d.close) || 0) > (parseFloat(d.open) || 0) ? 1 : 0), [historicalData.length, 1]);
      this.model = tf.sequential();
      this.model.add(tf.layers.dense({ units: 64, activation: 'relu', inputShape: [2] }));
      this.model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
      await this.model.fit(inputs, labels, { epochs: 10 });
      console.log('模型训练成功');
    } catch (error) {
      console.error('错误: 模型训练失败:', error.message);
      this.model = null;
    }
  }

  async analyze(data) {
    try {
      if (!this.model) {
        console.log('警告: DeepAI模型未训练，使用默认保持');
        return 'hold';
      }
      if (!data || typeof data.close !== 'string' || typeof data.volume !== 'string') {
        console.log('警告: 输入数据无效，使用默认保持');
        return 'hold';
      }
      const inputTensor = tf.tensor2d([[parseFloat(data.close) || 0, parseFloat(data.volume) || 0]], [1, 2]);
      const prediction = this.model.predict(inputTensor).dataSync()[0];
      console.log('本地模型预测结果:', prediction);
      return prediction > 0.5 ? 'long' : 'short';
    } catch (error) {
      console.error('错误: DeepAI分析失败:', error.message);
      return 'hold';
    }
  }
}

module.exports = new DeepAI();