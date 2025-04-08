const axios = require('axios');
const compromise = require('compromise');
const config = require('./config.json');

class MarketSentiment {
  async analyzeNews(symbol) {
    try {
      if (!symbol || !config.polygonApiKey) {
        console.log('警告: 无效的交易对或API密钥，返回中性情绪');
        return 'neutral';
      }
      const newsResponse = await axios({
        method: 'get',
        url: `https://api.polygon.io/v2/reference/news?tickers=${symbol}&apiKey=${config.polygonApiKey}`,
        timeout: 5000
      });
      const articles = newsResponse.data.results || [];
      let sentimentScore = 0;
      articles.forEach(article => {
        try {
          const doc = compromise(article.title || '');
          sentimentScore += doc.match('#Positive').out('array').length - doc.match('#Negative').out('array').length;
        } catch (error) {
          console.error('错误: 分析单篇新闻失败:', error.message);
        }
      });
      return sentimentScore > 0 ? 'bullish' : sentimentScore < 0 ? 'bearish' : 'neutral';
    } catch (error) {
      console.error('错误: 新闻API调用失败或超时:', error.message);
      return 'neutral';
    }
  }
}

module.exports = new MarketSentiment();