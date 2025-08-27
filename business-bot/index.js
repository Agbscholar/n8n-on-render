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


bot.on('message', async (msg) => {
  if (msg.text && (msg.text.includes('youtube.com') || msg.text.includes('youtu.be') || 
                   msg.text.includes('tiktok.com') || msg.text.includes('instagram.com'))) {
    
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const url = msg.text;
    
    try {
      // Check if user can use service
      const canUse = await db.canUseService(telegramId);
      
      if (!canUse) {
        // ... (existing limit handling code)
        return;
      }

      // Get user data
      const userData = await db.getUser(telegramId);
      
      // Check platform restrictions for free users
      if (userData.subscription_type === 'free' && url.includes('instagram.com')) {
        return bot.sendMessage(chatId, 
          '🔒 **Instagram is Premium only!**\n\n💎 Upgrade to access Instagram: /upgrade'
        );
      }

      // Send processing message
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

    } catch (error) {
      console.error('Video processing error:', error);
      bot.sendMessage(chatId, '❌ An error occurred. Please try again later.');
    }
  }
});

// Webhook endpoint for n8n callbacks
app.post('/webhook/video-processing express.json(), async (req, res) => {
  const { processing_id, status, telegram_id, chat_id, shorts_data, error } = req.body;
  
  try {
    if (status === 'completed' && shorts_data) {
      // Send video files to user
      for (const short of shorts_data) {
        await bot.sendVideo(chat_id, short.file_url, {
          caption: `📹 ${short.title}\n\n🤖 Created by @your_bot_username`
        });
      }
      
      // Log successful completion
      await db.logProcessingComplete(telegram_id, {
        processing_id,
        shorts_count: shorts_data.length,
        status: 'completed'
      });
      
    } else if (status === 'error') {
      // Handle errors
      await db.logProcessingComplete(telegram_id, {
        processing_id,
        status: 'error',
        error_message: error
      });
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
      [{text: '❓ Contact Support', url: 'https://t.me/Osezblessed'}]
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

// Handle video URLs with business logic
bot.on('message', async (msg) => {
  if (msg.text && (msg.text.includes('youtube.com') || msg.text.includes('youtu.be') || 
                   msg.text.includes('tiktok.com') || msg.text.includes('instagram.com'))) {
    
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const url = msg.text;
    
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
      
      return bot.sendMessage(chatId, limitMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
    
    // Process the video (integrate with your n8n workflow)
    bot.sendMessage(chatId, '🎬 Processing your video... This may take 1-3 minutes.');
    
    // Here you would trigger your n8n workflow
    // For now, simulate processing
    setTimeout(async () => {
      await db.logUsage(telegramId, {
        url: url,
        platform: url.includes('youtube') ? 'YouTube' : 'TikTok',
        status: 'success',
        shorts_created: 2,
        processing_time: 45
      });
      
      bot.sendMessage(chatId, '✅ Your shorts are ready! Check messages above.');
    }, 2000);
  }
});

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