const axios = require('axios');

class N8nClient {
  constructor() {
    this.n8nBaseUrl = process.env.N8N_BASE_URL || 'https://n8n-on-render-wf30.onrender.com/';
    this.webhookSecret = process.env.N8N_WEBHOOK_SECRET || 'your-secret-key';
  }

  async triggerVideoProcessing(userData, videoUrl) {
    try {
      const payload = {
        telegram_id: userData.telegram_id,
        chat_id: userData.chat_id,
        video_url: videoUrl,
        subscription_type: userData.subscription_type,
        user_limits: {
          can_process_instagram: ['premium', 'pro'].includes(userData.subscription_type),
          max_shorts: userData.subscription_type === 'pro' ? 5 : 3,
          custom_length: userData.subscription_type !== 'free'
        },
        webhook_secret: this.webhookSecret
      };

      const response = await axios.post(
        `${this.n8nBaseUrl}/webhook/video-processing`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.webhookSecret}`
          },
          timeout: 30000 // 30 second timeout
        }
      );


      return response.data;
    } catch (error) {
      console.error('n8n trigger error:', error.response?.data || error.message);
      throw error;
    }
  }

  async getProcessingStatus(processingId) {
    try {
      const response = await axios.get(
        `${this.n8nBaseUrl}/webhook/status/${processingId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.webhookSecret}`
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('Status check error:', error.response?.data || error.message);
      return { status: 'error', message: 'Could not check status' };
    }
  }
}

module.exports = new N8nClient();