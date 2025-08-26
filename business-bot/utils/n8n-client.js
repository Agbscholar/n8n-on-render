const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const db = require('./utils/database');
const payment = require('./utils/payment');
const n8nClient = require('./utils/n8n-client'); 

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {polling: true});

// Middleware
app.use(express.json());
app.use('/webhook', express.raw({type: 'application/json'}));

// Deduplication cache
const processingCache = new Map();
const MESSAGE_TIMEOUT = 30000; // 30 seconds

// Unified video processing handler
async function handleVideoProcessing(msg, url) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  // Deduplication check
  const cacheKey = `${telegramId}:${url}`;
  if (processingCache.has(cacheKey)) {
    const cached = processingCache.get(cacheKey);
    if (Date.now() - cached.timestamp < MESSAGE_TIMEOUT) {
      console.log('⚠️ Duplicate request ignored:', cacheKey);
      return null;
    }
  }
  
  processingCache.set(cacheKey, { timestamp: Date.now() });
  
  try {
    // Check if user can use service
    const canUse = await db.canUseService(telegramId);
    
    if (!canUse) {
      const limitMessage = `
🚫 **Daily limit reached!**

You've used your 3 free videos today.

💎 **Upgrade to Premium for:**
- ✅ Unlimited videos
- ✅ Priority processing  
- ✅ All platforms
- ✅ Custom lengths

Ready to upgrade? /upgrade
      `;
      
      const keyboard = {
        inline_keyboard: [
          [{text: '💎 Upgrade Now - $2.99', callback_data: 'upgrade_premium'}]
        ]
      };
      
      await bot.sendMessage(chatId, limitMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      return null;
    }

    // Get user data
    const userData = await db.getUser(telegramId);
    
    // Check platform restrictions for free users
    if (userData.subscription_type === 'free' && url.includes('instagram.com')) {
      await bot.sendMessage(chatId, 
        '🔒 **Instagram is Premium only!**\n\n💎 Upgrade to access Instagram: /upgrade',
        { parse_mode: 'Markdown' }
      );
      return null;
    }

    // Send single processing message
    const processingMsg = await bot.sendMessage(chatId, 
      '🎬 Processing your video... This may take 1-3 minutes.\n\n⏳ Please wait...'
    );

    // Trigger n8n workflow
    const processingData = await n8nClient.triggerVideoProcessing({
      telegram_id: telegramId,
      chat_id: chatId,
      subscription_type: userData.subscription_type,
      first_name: userData.first_name
    }, url);

    // Update database with processing start
    await db.logProcessingStart(telegramId, {
      url: url,
      platform: url.includes('youtube') ? 'YouTube' : 
               url.includes('tiktok') ? 'TikTok' : 'Instagram',
      processing_id: processingData.processing_id
    });

    return { processingMsg, processingData, chatId, telegramId };
    
  } catch (error) {
    console.error('Video processing error:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again later.');
    return null;
  }
}

// Single message handler for video URLs
bot.on('message', async (msg) => {
  if (!msg.text) return;
  
  const urlPatterns = [
    'youtube.com',
    'youtu.be', 
    'tiktok.com',
    'instagram.com'
  ];
  
  const hasVideoUrl = urlPatterns.some(pattern => msg.text.includes(pattern));
  
  if (hasVideoUrl) {
    const result = await handleVideoProcessing(msg, msg.text);
    
    if (result) {
      const { processingMsg, processingData, chatId, telegramId } = result;
      
      // Monitor processing status
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes max
      
      const checkStatus = setInterval(async () => {
        attempts++;
        
        if (attempts > maxAttempts) {
          clearInterval(checkStatus);
          bot.editMessageText(
            '⏱️ Processing is taking longer than expected. You\'ll receive your shorts when ready!',
            { chat_id: chatId, message_id: processingMsg.message_id }
          );
          return;
        }

        const status = await n8nClient.getProcessingStatus(processingData.processing_id);
        
        if (status.status === 'completed') {
          clearInterval(checkStatus);
          
          // Update usage count
          await db.incrementUsage(telegramId);
          
          bot.editMessageText(
            `✅ **Processing Complete!**\n\n🎬 Generated ${status.shorts_count} shorts\n📱 Optimized for mobile viewing`,
            { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
          );
          
        } else if (status.status === 'error') {
          clearInterval(checkStatus);
          bot.editMessageText(
            '❌ Processing failed. Please try with a different video URL.',
            { chat_id: chatId, message_id: processingMsg.message_id }
          );
        }
      }, 5000); // Check every 5 seconds
    }
  }
});

// Webhook endpoint for n8n callbacks
app.post('/webhook/n8n-callback', express.json(), async (req, res) => {
  const { processing_id, status, telegram_id, chat_id, shorts_results, total_shorts, error } = req.body;
  
  try {
    if (status === 'completed' && shorts_results) {
      // Send video files to user
      for (const short of shorts_results) {
        await bot.sendVideo(chat_id, short.file_url, {
          caption: `📹 ${short.title}\n\n🤖 Created by @your_bot_username`
        });
      }
      
      // Log successful completion
      await db.logProcessingComplete(telegram_id, {
        processing_id,
        shorts_count: shorts_results.length,
        status: 'completed'
      });
      
    } else if (status === 'error') {
      // Handle errors
      await db.logProcessingComplete(telegram_id, {
        processing_id,
        status: 'error',
        error_message: error
      });
      
      await bot.sendMessage(chat_id, 
        '❌ Processing failed. Please try with a different video URL.'
      );
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Start command with business messaging
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  
  // Create or get user
  await db.createUser({
    telegram_id: user.id,
    username: user.username,
    first_name: user.first_name
  });
  
  const userData = await db.getUser(user.id);
  
  const welcomeMessage = `
🎬 **Welcome to VideoShortsBot!**

Transform long videos into viral shorts instantly!

**YOUR PLAN: ${userData.subscription_type.toUpperCase()}**

📊 **Today's Usage:** ${userData.daily_usage}/3 (Free)
📈 **Total Processed:** ${userData.total_usage} videos

🆓 **FREE FEATURES:**
- 3 videos per day
- 60-second shorts
- YouTube & TikTok support

💎 **PREMIUM ($2.99/month):**
- ✅ Unlimited videos
- ✅ Custom lengths (15s-90s)
- ✅ All platforms + Instagram
- ✅ Priority processing

🚀 **PRO ($9.99/month):**
- ✅ Everything in Premium
- ✅ API access
- ✅ White-label rights
- ✅ Custom branding

**Ready? Send me any video URL!**

Commands:
/upgrade - View premium plans
/stats - Your statistics  
/help - Need assistance?
  `;
  
  bot.sendMessage(chatId, welcomeMessage, {parse_mode: 'Markdown'});
});

// Upgrade command
bot.onText(/\/upgrade/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  const premiumUrl = await payment.createPaymentLink(telegramId, 'premium', {
    first_name: msg.from.first_name,
    phone: msg.from.phone_number
  });
  const proUrl = await payment.createPaymentLink(telegramId, 'pro', {
    first_name: msg.from.first_name, 
    phone: msg.from.phone_number
  });
  
  const upgradeMessage = `
💎 **UPGRADE YOUR EXPERIENCE** 🇳🇬

${payment.getPricingText()}

Choose your plan:
  `;
  
  const keyboard = {
    inline_keyboard: [
      [{text: '💎 Get Premium - ₦1,200', url: premiumUrl}],
      [{text: '🚀 Get Pro - ₦4,000', url: proUrl}],
      [{text: '❓ Contact Support', url: 'https://t.me/your_support_username'}]
    ]
  };
  
  bot.sendMessage(chatId, upgradeMessage, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
  const userData = await db.getUser(msg.from.id);
  
  if (!userData) {
    return bot.sendMessage(msg.chat.id, 'Please start the bot first with /start');
  }
  
  const statsMessage = `
📊 **YOUR STATISTICS**

👤 **Account:** ${userData.first_name}
💳 **Plan:** ${userData.subscription_type.toUpperCase()}

📈 **Usage Today:** ${userData.daily_usage}/${userData.subscription_type === 'free' ? '3' : '∞'}
🎬 **Total Processed:** ${userData.total_usage} videos
📅 **Member Since:** ${new Date(userData.created_at).toLocaleDateString()}

${userData.subscription_type === 'free' ? 
  `🔓 **Want unlimited access?** /upgrade` : 
  `✅ **Premium active until:** ${new Date(userData.subscription_expires).toLocaleDateString()}`
}
  `;
  
  bot.sendMessage(msg.chat.id, statsMessage, {parse_mode: 'Markdown'});
});

// Clean cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of processingCache.entries()) {
    if (now - value.timestamp > MESSAGE_TIMEOUT) {
      processingCache.delete(key);
    }
  }
}, 60000); // Clean every minute

// Stripe webhook handler
app.post('/webhook', payment.handleWebhook);

// Health check for Render
app.get('/', (req, res) => {
  res.json({status: 'Bot is running!', timestamp: new Date()});
});

const PORT = process.env.PORT || 5678;
app.listen(PORT, () => {
  console.log(`🤖 Bot running on port ${PORT}`);
});