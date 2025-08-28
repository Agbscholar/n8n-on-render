const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {polling: true});

// Middleware
app.use(express.json());

// In-memory storage for demo (replace with database in production)
const users = new Map();
const processingJobs = new Map();

// Initialize or get user
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

// Check if user can process videos
function canProcessVideo(telegramId) {
  const user = users.get(telegramId);
  if (!user) return false;
  
  if (user.subscription_type === 'premium' || user.subscription_type === 'pro') {
    return true;
  }
  
  return user.daily_usage < 3;
}

// Update user usage
function updateUsage(telegramId) {
  const user = users.get(telegramId);
  if (user) {
    user.daily_usage += 1;
    user.total_usage += 1;
  }
}

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = initUser(msg.from.id, msg.from);
  
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

// Stats command
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

// Upgrade command
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

// Help command
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
  // Skip commands
  if (msg.text && msg.text.startsWith('/')) return;
  
  // Check for video URLs
  if (msg.text && (msg.text.includes('youtube.com') || msg.text.includes('youtu.be') || 
                   msg.text.includes('tiktok.com') || msg.text.includes('instagram.com') ||
                   msg.text.includes('vm.tiktok.com') || msg.text.includes('twitter.com'))) {
    
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const videoUrl = msg.text.trim();
    
    // Initialize user if not exists
    const user = initUser(telegramId, msg.from);
    
    // Check limits
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
    
    // Check Instagram restriction for free users
    if (user.subscription_type === 'free' && videoUrl.includes('instagram.com')) {
      return bot.sendMessage(chatId, '🔒 Instagram processing requires Premium subscription. Contact @Osezblessed to upgrade!');
    }
    
    // Send processing message
    bot.sendMessage(chatId, '🎬 Processing your video... This may take 1-3 minutes.');
    
    // Update usage
    updateUsage(telegramId);
    
    try {
      // Call n8n workflow
      const response = await axios.post('https://n8n-on-render-wf30.onrender.com/webhook/video-processing', {
        telegram_id: telegramId,
        chat_id: chatId,
        video_url: videoUrl,
        user_name: user.first_name,
        subscription_type: user.subscription_type,
        webhook_secret: '7f9d0d2e8a6f4f38a13a2bcf5b6d441b91c9d26e8b72714d2edcf7c4e2a843ke',
        business_bot_url: 'https://video-shorts-business-bot.onrender.com'
      }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log('n8n response:', response.data);
      
      // Store processing job
      if (response.data.processing_id) {
        processingJobs.set(response.data.processing_id, {
          telegramId,
          chatId,
          videoUrl,
          startTime: Date.now()
        });
      }
      
    } catch (error) {
      console.error('Error calling n8n:', error.message);
      
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

// Webhook endpoint to receive n8n callbacks
app.post('/webhook/n8n-callback', async (req, res) => {
  console.log('Received n8n callback:', req.body);
  
  try {
    const {
      processing_id,
      telegram_id,
      chat_id,
      status,
      shorts_results,
      total_shorts,
      subscription_type
    } = req.body;
    
    // Validate required fields
    if (!telegram_id || !chat_id) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing telegram_id or chat_id'
      });
    }
    
    if (status === 'completed' && shorts_results) {
      // Parse shorts_results if it's a string
      let results;
      try {
        results = typeof shorts_results === 'string' ? JSON.parse(shorts_results) : shorts_results;
      } catch (e) {
        results = shorts_results;
      }
      
      // Send success message
      let message = `✅ Your ${total_shorts || results.length} shorts are ready!

🎬 Processing completed successfully
📱 Quality: ${results[0]?.quality || '720p'}
⏱️ Platform: Auto-detected

📥 Download links:`;
      
      // Add download links
      if (Array.isArray(results)) {
        results.forEach((short, index) => {
          message += `\n\n🎥 Short ${index + 1}: ${short.title || 'Video Short'}`;
          if (short.file_url) {
            message += `\n📎 ${short.file_url}`;
          }
        });
      }
      
      // Add upgrade message for free users
      if (subscription_type === 'free') {
        message += `\n\n🚀 Upgrade to Premium for:
• 🎯 HD Quality (1080p)
• 🚫 No Watermarks
• 📈 Unlimited Processing
• 🎵 Auto Music & Captions

Contact @Osezblessed to upgrade!`;
      }
      
      await bot.sendMessage(chat_id, message);
      
    } else if (status === 'error') {
      await bot.sendMessage(chat_id, `❌ Processing failed

Please try again or contact @Osezblessed for support.`);
    }
    
    res.json({ status: 'success', message: 'Callback processed' });
    
  } catch (error) {
    console.error('Error processing callback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process callback',
      error: error.message
    });
  }
});

// Error webhook endpoint
app.post('/webhook/n8n-error', async (req, res) => {
  console.log('Received n8n error:', req.body);
  
  try {
    const { telegram_id, chat_id, error_message } = req.body;
    
    if (chat_id) {
      await bot.sendMessage(chat_id, `❌ Video Processing Failed

🔍 Error: ${error_message || 'Unknown error occurred'}

🔄 What to do:
• Check if the video URL is valid
• Try again in a few minutes
• Contact @Osezblessed if the issue persists`);
      
      // Revert usage count on error
      const user = users.get(parseInt(telegram_id));
      if (user && user.daily_usage > 0) {
        user.daily_usage -= 1;
        user.total_usage -= 1;
      }
    }
    
    res.json({ status: 'success' });
    
  } catch (error) {
    console.error('Error processing error callback:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'VideoShortsBot Business API Running',
    timestamp: new Date(),
    users: users.size,
    processing_jobs: processingJobs.size
  });
});

// Admin stats endpoint
app.get('/admin/stats', (req, res) => {
  const stats = {
    total_users: users.size,
    premium_users: Array.from(users.values()).filter(u => u.subscription_type !== 'free').length,
    total_videos_processed: Array.from(users.values()).reduce((sum, u) => sum + u.total_usage, 0),
    active_processing_jobs: processingJobs.size
  };
  
  res.json(stats);
});

// Reset daily usage at midnight (simple version)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    users.forEach(user => {
      user.daily_usage = 0;
    });
    console.log('Daily usage reset for all users');
  }
}, 60000); // Check every minute

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🤖 VideoShortsBot Business API running on port ${PORT}`);
  console.log(`🌐 Webhook URL: https://video-shorts-business-bot.onrender.com/webhook/n8n-callback`);
});