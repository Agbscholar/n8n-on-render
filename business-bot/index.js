const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {polling: true});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  next();
});

// In-memory storage
const users = new Map();
const processingJobs = new Map();

// Keep the service awake (ping itself every 14 minutes)
setInterval(() => {
  axios.get('https://video-shorts-business-bot.onrender.com/')
    .catch(err => console.log('Self-ping failed:', err.message));
}, 14 * 60 * 1000);

function initUser(telegramId, userInfo) {
  if (!users.has(telegramId)) {
    users.set(telegramId, {
      telegram_id: telegramId,
      username: userInfo.username,
      first_name: userInfo.first_name,
      subscription_type: 'free',
      daily_usage: 0,
      total_usage: 0,
      created_at: new Date().toISOString()
    });
  }
  return users.get(telegramId);
}

function canProcessVideo(telegramId) {
  const user = users.get(telegramId);
  if (!user) return false;
  
  if (user.subscription_type === 'premium' || user.subscription_type === 'pro') {
    return true;
  }
  
  return user.daily_usage < 3;
}

function updateUsage(telegramId) {
  const user = users.get(telegramId);
  if (user) {
    user.daily_usage += 1;
    user.total_usage += 1;
  }
}

// Bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = initUser(msg.from.id, msg.from);
  
  console.log(`New user: ${msg.from.id}, Chat: ${chatId}`);
  
  const welcomeMessage = `🎬 Welcome to VideoShortsBot!

Transform long videos into viral shorts instantly!

YOUR PLAN: ${user.subscription_type.toUpperCase()}

📊 Today's Usage: ${user.daily_usage}/3 (Free)
📈 Total Processed: ${user.total_usage} videos

🆓 FREE FEATURES:
• 3 videos per day
• 60-second shorts
• YouTube & TikTok support

💎 PREMIUM:
• ✅ Unlimited videos
• ✅ Custom lengths (15s-90s)
• ✅ All platforms + Instagram
• ✅ Priority processing

Ready? Send me any video URL!

Commands:
/upgrade - View premium plans
/stats - Your statistics  
/help - Need assistance?`;
  
  bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/stats/, (msg) => {
  const user = users.get(msg.from.id);
  
  if (!user) {
    return bot.sendMessage(msg.chat.id, 'Please start the bot first with /start');
  }
  
  const statsMessage = `📊 YOUR STATISTICS

👤 Account: ${user.first_name}
💳 Plan: ${user.subscription_type.toUpperCase()}

📈 Usage Today: ${user.daily_usage}/${user.subscription_type === 'free' ? '3' : '∞'}
🎬 Total Processed: ${user.total_usage} videos
📅 Member Since: ${new Date(user.created_at).toLocaleDateString()}

${user.subscription_type === 'free' ? 
  '🔓 Want unlimited access? /upgrade' : 
  '✅ Premium account active'
}`;
  
  bot.sendMessage(msg.chat.id, statsMessage);
});

bot.onText(/\/upgrade/, (msg) => {
  const upgradeMessage = `💎 UPGRADE YOUR EXPERIENCE

💎 PREMIUM - $2.99/month:
• ✅ Unlimited videos
• ✅ Custom lengths (15s-90s)
• ✅ All platforms + Instagram
• ✅ Priority processing

🚀 PRO - $9.99/month:
• ✅ Everything in Premium
• ✅ API access
• ✅ White-label rights
• ✅ Custom branding

Contact @Osezblessed to upgrade!`;
  
  bot.sendMessage(msg.chat.id, upgradeMessage);
});

bot.onText(/\/help/, (msg) => {
  const helpMessage = `❓ HOW TO USE VIDEOSHORTSBOT

1️⃣ Send any video URL from:
   • YouTube (youtube.com, youtu.be)
   • TikTok (tiktok.com)
   • Instagram (instagram.com) - Premium only

2️⃣ Wait 1-3 minutes for processing

3️⃣ Receive your viral shorts!

📝 SUPPORTED FORMATS:
• Direct video links
• Social media URLs
• Public videos only

🚫 NOT SUPPORTED:
• Private videos
• Live streams
• Videos > 30 minutes (free)

Need help? Contact @Osezblessed`;
  
  bot.sendMessage(msg.chat.id, helpMessage);
});

// Handle video URLs
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  if (msg.text && (msg.text.includes('youtube.com') || msg.text.includes('youtu.be') || 
                   msg.text.includes('tiktok.com') || msg.text.includes('instagram.com') ||
                   msg.text.includes('vm.tiktok.com') || msg.text.includes('twitter.com'))) {
    
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const videoUrl = msg.text.trim();
    
    console.log(`Processing video request from user ${telegramId}, chat ${chatId}: ${videoUrl}`);
    
    const user = initUser(telegramId, msg.from);
    
    if (!canProcessVideo(telegramId)) {
      const limitMessage = `🚫 Daily limit reached!

You've used your 3 free videos today.

💎 Upgrade to Premium for:
• ✅ Unlimited videos
• ✅ Priority processing  
• ✅ All platforms
• ✅ Custom lengths

Contact @Osezblessed to upgrade!`;
      
      return bot.sendMessage(chatId, limitMessage);
    }
    
    if (user.subscription_type === 'free' && videoUrl.includes('instagram.com')) {
      return bot.sendMessage(chatId, '🔒 Instagram processing requires Premium subscription. Contact @Osezblessed to upgrade!');
    }
    
    bot.sendMessage(chatId, '🎬 Processing your video... This may take 1-3 minutes.');
    
    updateUsage(telegramId);
    
    try {
      console.log('Calling n8n workflow...');
      
      const response = await axios.post('https://n8n-on-render-wf30.onrender.com/webhook/video-processing', {
        telegram_id: telegramId,
        chat_id: chatId,
        video_url: videoUrl,
        user_name: user.first_name,
        subscription_type: user.subscription_type,
        webhook_secret: '7f9d0d2e8a6f4f38a13a2bcf5b6d441b91c9d26e8b72714d2edcf7c4e2a843ke',
        business_bot_url: 'https://video-shorts-business-bot.onrender.com'
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log('n8n workflow response:', response.data);
      
      if (response.data.processing_id) {
        processingJobs.set(response.data.processing_id, {
          telegramId,
          chatId,
          videoUrl,
          startTime: Date.now()
        });
        
        // Set a fallback timeout in case callback never arrives
        setTimeout(() => {
          if (processingJobs.has(response.data.processing_id)) {
            console.log(`Timeout for processing ${response.data.processing_id}`);
            bot.sendMessage(chatId, `⏰ Processing is taking longer than expected. Please wait a bit more or try again.

If the issue persists, contact @Osezblessed`);
            processingJobs.delete(response.data.processing_id);
          }
        }, 5 * 60 * 1000); // 5 minute timeout
      }
      
    } catch (error) {
      console.error('Error calling n8n workflow:', error.message);
      
      bot.sendMessage(chatId, `❌ Processing failed: ${error.message}

🔄 Please try again in a few minutes.
📞 If the issue persists, contact @Osezblessed`);
      
      // Revert usage count on error
      const user = users.get(telegramId);
      if (user && user.daily_usage > 0) {
        user.daily_usage -= 1;
        user.total_usage -= 1;
      }
    }
  }
});

// WEBHOOK ENDPOINTS - These are what n8n calls back to

// Primary callback endpoint (matches your n8n workflow)
app.post('/webhook/n8n-callback', async (req, res) => {
  console.log('📨 Received n8n callback:', JSON.stringify(req.body, null, 2));
  
  try {
    const {
      processing_id,
      telegram_id,
      chat_id,
      status,
      shorts_results,
      total_shorts,
      subscription_type,
      processing_completed_at
    } = req.body;
    
    // Convert to numbers if they're strings
    const telegramIdNum = parseInt(telegram_id);
    const chatIdNum = parseInt(chat_id);
    
    console.log(`Processing callback - Status: ${status}, Telegram: ${telegramIdNum}, Chat: ${chatIdNum}`);
    
    if (!telegramIdNum || !chatIdNum) {
      console.error('Missing or invalid telegram_id/chat_id:', { telegram_id, chat_id });
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid telegram_id or chat_id'
      });
    }
    
    if (status === 'completed') {
      let results;
      try {
        results = typeof shorts_results === 'string' ? JSON.parse(shorts_results) : shorts_results;
      } catch (e) {
        results = shorts_results || [];
      }
      
      if (!Array.isArray(results)) {
        results = [results];
      }
      
      let message = `✅ Your ${total_shorts || results.length} shorts are ready!

🎬 Processing completed successfully
📱 Quality: ${results[0]?.quality || '720p'}
⏱️ Processing time: ${processing_completed_at ? 'Just completed' : 'Unknown'}

📥 Download links:`;
      
      results.forEach((short, index) => {
        message += `\n\n🎥 Short ${index + 1}: ${short.title || 'Video Short'}`;
        if (short.file_url && short.file_url !== 'https://example.com/test.mp4') {
          message += `\n📎 ${short.file_url}`;
        } else {
          message += `\n📎 [Demo mode - no actual file]`;
        }
        if (short.thumbnail_url) {
          message += `\n🖼️ Thumbnail: ${short.thumbnail_url}`;
        }
      });
      
      if (subscription_type === 'free') {
        message += `\n\n🚀 Upgrade to Premium for:
• 🎯 HD Quality (1080p)
• 🚫 No Watermarks
• 📈 Unlimited Processing
• 🎵 Auto Music & Captions

Contact @Osezblessed to upgrade!`;
      }
      
      await bot.sendMessage(chatIdNum, message);
      console.log(`✅ Success message sent to chat ${chatIdNum}`);
      
    } else if (status === 'error' || status === 'failed') {
      await bot.sendMessage(chatIdNum, `❌ Processing failed

Please try again or contact @Osezblessed for support.`);
      console.log(`❌ Error message sent to chat ${chatIdNum}`);
    }
    
    // Clean up processing job
    if (processing_id) {
      processingJobs.delete(processing_id);
    }
    
    res.json({ 
      status: 'success', 
      message: 'Callback processed successfully',
      processed_for: chatIdNum
    });
    
  } catch (error) {
    console.error('Error processing callback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process callback',
      error: error.message
    });
  }
});

// Error callback endpoint
app.post('/webhook/n8n-error', async (req, res) => {
  console.log('📨 Received n8n error callback:', JSON.stringify(req.body, null, 2));
  
  try {
    const { telegram_id, chat_id, error_message, processing_id } = req.body;
    
    const chatIdNum = parseInt(chat_id);
    const telegramIdNum = parseInt(telegram_id);
    
    if (chatIdNum) {
      await bot.sendMessage(chatIdNum, `❌ Video Processing Failed

🔍 Error: ${error_message || 'Unknown error occurred'}

🔄 What to do:
• Check if the video URL is valid
• Try again in a few minutes
• Contact @Osezblessed if the issue persists

Processing ID: ${processing_id || 'N/A'}`);
      
      // Revert usage count on error
      const user = users.get(telegramIdNum);
      if (user && user.daily_usage > 0) {
        user.daily_usage -= 1;
        user.total_usage -= 1;
      }
    }
    
    // Clean up processing job
    if (processing_id) {
      processingJobs.delete(processing_id);
    }
    
    res.json({ status: 'success', message: 'Error callback processed' });
    
  } catch (error) {
    console.error('Error processing error callback:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'VideoShortsBot Business API Running',
    timestamp: new Date(),
    users: users.size,
    processing_jobs: processingJobs.size,
    uptime: process.uptime()
  });
});

// Test endpoint for debugging
app.get('/test', (req, res) => {
  res.json({
    message: 'Test endpoint working',
    webhook_urls: [
      'POST /webhook/n8n-callback',
      'POST /webhook/n8n-error'
    ]
  });
});

// Admin stats endpoint
app.get('/admin/stats', (req, res) => {
  const stats = {
    total_users: users.size,
    premium_users: Array.from(users.values()).filter(u => u.subscription_type !== 'free').length,
    total_videos_processed: Array.from(users.values()).reduce((sum, u) => sum + u.total_usage, 0),
    active_processing_jobs: processingJobs.size,
    users_list: Array.from(users.entries()).map(([id, user]) => ({
      telegram_id: id,
      name: user.first_name,
      subscription: user.subscription_type,
      daily_usage: user.daily_usage
    }))
  };
  
  res.json(stats);
});

// 404 handler
app.use((req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.path,
    available_endpoints: [
      'GET /',
      'GET /test',
      'GET /admin/stats',
      'POST /webhook/n8n-callback',
      'POST /webhook/n8n-error'
    ]
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🤖 VideoShortsBot Business API running on port ${PORT}`);
  console.log(`🌐 Webhook URL: https://video-shorts-business-bot.onrender.com/webhook/n8n-callback`);
  console.log(`🌐 Error Webhook URL: https://video-shorts-business-bot.onrender.com/webhook/n8n-error`);
});