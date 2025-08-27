const axios = require('axios');
const db = require('./database');

class PaymentHandler {
  constructor() {
    this.flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    this.baseURL = 'https://api.flutterwave.com/v3';
  }

  async createPaymentLink(telegramId, plan, userInfo) {
    const prices = {
      premium: { amount: 1200, currency: 'NGN' }, // ₦1,200 (~$2.99)
      pro: { amount: 4000, currency: 'NGN' } // ₦4,000 (~$9.99)
    };

    const planPrice = prices[plan];
    
    const payload = {
      tx_ref: `${telegramId}_${plan}_${Date.now()}`,
      amount: planPrice.amount,
      currency: planPrice.currency,
      redirect_url: `https://t.me/Osezblessed?start=success`,
      payment_options: 'card,banktransfer,ussd',
      customer: {
        email: `user${telegramId}@videoshortsbot.com`,
        phone_number: userInfo.phone || '',
        name: userInfo.first_name
      },
      customizations: {
        title: 'VideoShortsBot Premium',
        description: `${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan Subscription`,
        logo: 'https://your-logo-url.com/logo.png'
      },
      meta: {
        telegram_id: telegramId,
        plan: plan,
        consumer_mac: 'videoshortsbot'
      }
    };

    try {
      const response = await axios.post(`${this.baseURL}/payments`, payload, {
        headers: {
          'Authorization': `Bearer ${this.flutterwaveSecretKey}`,
          'Content-Type': 'application/json'
        }
      });

      return response.data.data.link;
    } catch (error) {
      console.error('Flutterwave payment creation error:', error.response?.data);
      throw error;
    }
  }

  async verifyPayment(transactionId) {
    try {
      const response = await axios.get(`${this.baseURL}/transactions/${transactionId}/verify`, {
        headers: {
          'Authorization': `Bearer ${this.flutterwaveSecretKey}`
        }
      });

      return response.data;
    } catch (error) {
      console.error('Payment verification error:', error.response?.data);
      throw error;
    }
  }

  async handleWebhook(req, res) {
    const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!signature || signature !== secretHash) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body;

    // Handle successful payment
    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
      const { tx_ref, meta } = payload.data;
      const telegramId = meta.telegram_id;
      const plan = meta.plan;

      // Verify payment with Flutterwave
      const verification = await this.verifyPayment(payload.data.id);
      
      if (verification.data.status === 'successful') {
        // Update user subscription
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + 1); // 1 month subscription
        
        await db.upgradeUser(telegramId, plan, expiryDate);
        
        // Send success notification to user
        console.log(`Payment successful for user ${telegramId}, plan: ${plan}`);
      }
    }

    res.status(200).json({ status: 'ok' });
  }

  // Helper method for Nigerian pricing
  getPricingText() {
    return `
💰 **NIGERIAN PRICING** 🇳🇬

💎 **Premium - ₦1,200/month**
• Unlimited video processing
• All platforms (Instagram, Twitter)
• Priority processing
• Custom video lengths

🚀 **Pro - ₦4,000/month**
• Everything in Premium  
• API access
• White-label rights
• Custom branding
• Reseller opportunities

💳 **Payment Methods:**
• Debit Card (Visa, Mastercard)
• Bank Transfer
• USSD Code
• Mobile Money
    `;
  }
}

module.exports = new PaymentHandler();