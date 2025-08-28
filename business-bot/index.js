const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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

// FILE STORAGE SETUP
const ensureDirectoryExists = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
};

// Create storage directories
ensureDirectoryExists('./downloads');
ensureDirectoryExists('./thumbnails');
ensureDirectoryExists('./temp');

// Serve static files
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
app.use('/thumbs', express.static(path.join(__dirname, 'thumbnails')));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (file.fieldname === 'video') {
      cb(null, './downloads/');
    } else if (file.fieldname === 'thumbnail') {
      cb(null, './thumbnails/');
    } else {
      cb(null, './temp/');
    }
  },
  filename: function (req, file, cb) {
    const { short_id } = req.body;
    const extension = path.extname(file.originalname);
    cb(null, `${short_id}${extension}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
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
      subscription_expires: null,
      daily_usage: 0,
      total_usage: 0,
      created_at: new Date().toISOString(),
      referral_code: `REF${telegramId}`,
      referred_users: 0
    });
  }
  return users.get(telegramId);
}

function canProcessVideo(telegramId) {
  const user = users.get(telegramId);
  if (!user) return false;
  
  // Check if premium/pro subscription is still valid
  if (user.subscription_type === 'premium' || user.subscription_type === 'pro') {
    if (user.subscription_expires && new Date() < new Date(user.subscription_expires)) {
      return true;
    } else if (user.subscription_expires && new Date() >= new Date(user.subscription_expires)) {
      // Subscription expired, downgrade to free
      user.subscription_type = 'free';
      user.subscription_expires = null;
    }
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

// Reset daily usage at midnight
function resetDailyUsage() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const msUntilMidnight = tomorrow.getTime() - now.getTime();
  
  setTimeout(() => {
    console.log('Resetting daily usage for all users...');
    users.forEach(user => {
      user.daily_usage = 0;
    });
    
    // Schedule next reset (24 hours)
    setInterval(() => {
      console.log('Daily usage reset completed');
      users.forEach(user => {
        user.daily_usage = 0;
      });
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// Initialize daily usage reset
resetDailyUsage();

// Bot commands
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const user = initUser(msg.from.id, msg.from);
  const referralCode = match && match[1] ? match[1] : null;
  
  console.log(`New user: ${msg.from.id}, Chat: ${chatId}, Referral: ${referralCode}`);
  
  // Handle referrals
  if (referralCode && referralCode.startsWith('REF') && referralCode !== user.referral_code) {
    const referrerId = referralCode.replace('REF', '');
    const referrer = users.get(parseInt(referrerId));
    if (referrer) {
      referrer.referred_users += 1;
      console.log(`Referral tracked: ${referrerId} referred ${msg.from.id}`);
    }
  }
  
  const subscriptionStatus = user.subscription_expires && new Date() < new Date(user.subscription_expires) 
    ? `Active until ${new Date(user.subscription_expires).toLocaleDateString()}` 
    : 'Free Plan';
  
  const welcomeMessage = `🎬 Welcome to VideoShortsBot!

Transform long videos into viral shorts instantly!

YOUR PLAN: ${user.subscription_type.toUpperCase()}
Status: ${subscriptionStatus}

📊 Today's Usage: ${user.daily_usage}/3 (Free users)
📈 Total Processed: ${user.total_usage} videos
👥 Referrals: ${user.referred_users} users

🆓 FREE FEATURES:
• 3 videos per day
• 60-second shorts
• YouTube & TikTok support

💎 PREMIUM ($2.99/month):
• ✅ Unlimited videos
• ✅ Custom lengths (15s-90s)
• ✅ All platforms + Instagram
• ✅ Priority processing
• ✅ No watermarks

🚀 PRO ($9.99/month):
• ✅ Everything in Premium
• ✅ API access
• ✅ White-label rights
• ✅ Custom branding
• ✅ Reseller dashboard

Ready? Send me any video URL!

Commands:
/upgrade - View premium plans
/stats - Your statistics  
/referral - Get your referral link
/help - Need assistance?`;
  
  bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/stats/, (msg) => {
  const user = users.get(msg.from.id);
  
  if (!user) {
    return bot.sendMessage(msg.chat.id, 'Please start the bot first with /start');
  }
  
  const subscriptionStatus = user.subscription_expires && new Date() < new Date(user.subscription_expires)
    ? `Active until ${new Date(user.subscription_expires).toLocaleDateString()}`
    : user.subscription_type === 'free' ? 'Free Plan' : 'Expired';
  
  const statsMessage = `📊 YOUR STATISTICS

👤 Account: ${user.first_name}
💳 Plan: ${user.subscription_type.toUpperCase()}
📅 Status: ${subscriptionStatus}

📈 Usage Today: ${user.daily_usage}/${user.subscription_type === 'free' ? '3' : '∞'}
🎬 Total Processed: ${user.total_usage} videos
👥 Referred Users: ${user.referred_users}
📅 Member Since: ${new Date(user.created_at).toLocaleDateString()}

🔗 Your Referral Code: ${user.referral_code}
Share: https://t.me/videoshortsaibot?start=${user.referral_code}

${user.subscription_type === 'free' ? 
  '🔓 Want unlimited access? /upgrade' : 
  subscriptionStatus.includes('Active') ? '✅ Premium account active' : '⚠️ Subscription expired - /upgrade'
}`;
  
  bot.sendMessage(msg.chat.id, statsMessage);
});

bot.onText(/\/referral/, (msg) => {
  const user = users.get(msg.from.id);
  
  if (!user) {
    return bot.sendMessage(msg.chat.id, 'Please start the bot first with /start');
  }
  
  const referralMessage = `🤝 REFERRAL PROGRAM

Your Referral Link:
https://t.me/videoshortsaibot?start=${user.referral_code}

📊 Your Stats:
👥 Referred Users: ${user.referred_users}
🎁 Bonus Credits: ${Math.floor(user.referred_users / 5)} months free

🎯 REWARDS:
• 5 referrals = 1 month Premium FREE
• 10 referrals = 2 months Premium FREE  
• 20 referrals = Pro access for 1 month

💰 PRO REFERRALS:
Earn 30% commission on Premium/Pro sales from your referrals!

Share your link and start earning!`;
  
  bot.sendMessage(msg.chat.id, referralMessage);
});

bot.onText(/\/upgrade/, (msg) => {
  const user = users.get(msg.from.id);
  
  const upgradeMessage = `💎 UPGRADE YOUR EXPERIENCE

🇳🇬 NIGERIAN PRICING:

💎 PREMIUM - ₦1,200/month (~$2.99):
• ✅ Unlimited videos
• ✅ Custom lengths (15s-90s)
• ✅ All platforms + Instagram + Twitter
• ✅ Priority processing
• ✅ No watermarks
• ✅ Batch processing

🚀 PRO - ₦4,000/month (~$9.99):
• ✅ Everything in Premium
• ✅ API access for developers
• ✅ White-label bot rights
• ✅ Custom branding & watermarks
• ✅ Reseller dashboard
• ✅ 30% commission on referrals
• ✅ Priority support

💳 Payment Methods:
• Bank Transfer • Debit Cards
• USSD • Mobile Money

Contact @Osezblessed to upgrade!
Or use referral code: ${user.referral_code} for discount!`;
  
  const keyboard = {
    inline_keyboard: [
      [{text: '💎 Upgrade to Premium', url: 'https://t.me/Osezblessed'}],
      [{text: '🚀 Upgrade to Pro', url: 'https://t.me/Osezblessed'}],
      [{text: '🤝 Referral Program', callback_data: 'referral_info'}]
    ]
  };
  
  bot.sendMessage(msg.chat.id, upgradeMessage, {reply_markup: keyboard});
});

bot.onText(/\/help/, (msg) => {
  const helpMessage = `❓ HOW TO USE VIDEOSHORTSBOT

1️⃣ Send any video URL from:
   • YouTube (youtube.com, youtu.be)
   • TikTok (tiktok.com, vm.tiktok.com)
   • Instagram (instagram.com) - Premium only
   • Twitter/X (twitter.com, x.com) - Premium only

2️⃣ Wait 1-3 minutes for processing

3️⃣ Receive your viral shorts with download links!

📝 SUPPORTED FORMATS:
• Direct video links
• Social media URLs
• Public videos only (no private/restricted content)

🚫 NOT SUPPORTED:
• Private videos or stories
• Live streams
• Videos > 30 minutes (free users)
• Copyrighted content without permission

⚡ PROCESSING TIMES:
• Free users: 2-5 minutes
• Premium: 1-2 minutes (priority queue)
• Pro: 30 seconds - 1 minute (highest priority)

💡 TIPS:
• Shorter videos (5-15 min) work best
• Ensure good internet connection
• Try different video qualities if processing fails

Need help? Contact @Osezblessed
Report bugs: Forward error messages to @Osezblessed`;
  
  bot.sendMessage(msg.chat.id, helpMessage);
});

// Handle callback queries
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  if (data === 'referral_info') {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, 'Use /referral to get your referral link and start earning!');
  }
});

// Handle video URLs
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  if (msg.text && (msg.text.includes('youtube.com') || msg.text.includes('youtu.be') || 
                   msg.text.includes('tiktok.com') || msg.text.includes('instagram.com') ||
                   msg.text.includes('vm.tiktok.com') || msg.text.includes('twitter.com') || 
                   msg.text.includes('x.com'))) {
    
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
• ✅ No watermarks

Or wait until tomorrow for your free videos to reset!

Contact @Osezblessed to upgrade instantly!`;
      
      const keyboard = {
        inline_keyboard: [
          [{text: '💎 Upgrade Now', url: 'https://t.me/Osezblessed'}],
          [{text: '🤝 Get Free Credits via Referrals', callback_data: 'referral_info'}]
        ]
      };
      
      return bot.sendMessage(chatId, limitMessage, {reply_markup: keyboard});
    }
    
    // Check platform restrictions
    if (user.subscription_type === 'free') {
      if (videoUrl.includes('instagram.com')) {
        return bot.sendMessage(chatId, '🔒 Instagram processing requires Premium subscription. Contact @Osezblessed to upgrade!');
      }
      if (videoUrl.includes('twitter.com') || videoUrl.includes('x.com')) {
        return bot.sendMessage(chatId, '🔒 Twitter/X processing requires Premium subscription. Contact @Osezblessed to upgrade!');
      }
    }
    
    const processingMessage = user.subscription_type === 'free' 
      ? '🎬 Processing your video... This may take 2-5 minutes.'
      : user.subscription_type === 'premium'
      ? '🎬 ⚡ Premium processing started... 1-2 minutes remaining.'
      : '🎬 🚀 Pro processing initiated... 30-60 seconds remaining.';
    
    bot.sendMessage(chatId, processingMessage);
    
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
        business_bot_url: 'https://video-shorts-business-bot.onrender.com',
        user_limits: {
          max_shorts: user.subscription_type === 'free' ? 2 : user.subscription_type === 'premium' ? 4 : 6,
          max_duration: user.subscription_type === 'free' ? 60 : 90,
          priority: user.subscription_type === 'free' ? 'low' : user.subscription_type === 'premium' ? 'medium' : 'high'
        }
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
          startTime: Date.now(),
          subscription_type: user.subscription_type
        });
        
        // Set timeout based on subscription type
        const timeoutDuration = user.subscription_type === 'free' ? 10 * 60 * 1000 : // 10 minutes
                               user.subscription_type === 'premium' ? 5 * 60 * 1000 : // 5 minutes  
                               3 * 60 * 1000; // 3 minutes for pro
        
        setTimeout(() => {
          if (processingJobs.has(response.data.processing_id)) {
            console.log(`Timeout for processing ${response.data.processing_id}`);
            bot.sendMessage(chatId, `⏰ Processing is taking longer than expected.

This might be due to:
• High server load
• Large video file
• Complex video content

Please wait a bit more or contact @Osezblessed if this persists.`);
            processingJobs.delete(response.data.processing_id);
          }
        }, timeoutDuration);
      }
      
    } catch (error) {
      console.error('Error calling n8n workflow:', error.message);
      
      bot.sendMessage(chatId, `❌ Processing failed: ${error.response?.data?.message || error.message}

🔄 Please try again in a few minutes.
📞 If the issue persists, contact @Osezblessed

Error code: ${error.response?.status || 'NETWORK_ERROR'}`);
      
      // Revert usage count on error
      const user = users.get(telegramId);
      if (user && user.daily_usage > 0) {
        user.daily_usage -= 1;
        user.total_usage -= 1;
      }
    }
  }
});

// FILE UPLOAD ENDPOINTS

// Upload processed video files from n8n
app.post('/upload-processed-video', upload.single('video'), (req, res) => {
  try {
    console.log('Received file upload:', req.file);
    console.log('Upload body:', req.body);
    
    const { processing_id, short_id } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileUrl = `https://video-shorts-business-bot.onrender.com/downloads/${file.filename}`;
    
    console.log(`File uploaded successfully: ${fileUrl}`);
    
    res.json({ 
      success: true, 
      file_url: fileUrl,
      file_size: file.size,
      filename: file.filename
    });
    
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// Upload thumbnail
app.post('/upload-thumbnail', upload.single('thumbnail'), (req, res) => {
  try {
    const { processing_id, short_id } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No thumbnail uploaded' });
    }
    
    const thumbnailUrl = `https://video-shorts-business-bot.onrender.com/thumbs/${file.filename}`;
    
    res.json({ 
      success: true, 
      thumbnail_url: thumbnailUrl,
      filename: file.filename
    });
    
  } catch (error) {
    console.error('Thumbnail upload error:', error);
    res.status(500).json({ error: 'Thumbnail upload failed', details: error.message });
  }
});

// Handle missing files gracefully
app.get('/downloads/:filename', (req, res, next) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'downloads', filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'File not found',
      message: 'This file may not have been processed yet, or this is a demo link.',
      filename: filename,
      suggestion: 'Please wait for processing to complete, or contact support if this persists.'
    });
  }
  
  // File exists, let express.static handle it
  next();
});

app.get('/thumbs/:filename', (req, res, next) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'thumbnails', filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Thumbnail not found',
      message: 'Thumbnail may still be generating.',
      filename: filename
    });
  }
  
  next();
});

// WEBHOOK ENDPOINTS

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
      processing_completed_at,
      video_info
    } = req.body;
    
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
${video_info?.title ? `🎯 Source: ${video_info.title.substring(0, 50)}...` : ''}

📥 Download links:`;
      
      results.forEach((short, index) => {
        message += `\n\n🎥 Short ${index + 1}: ${short.title || 'Video Short'}`;
        if (short.file_url && !short.file_url.includes('example.com')) {
          message += `\n📎 ${short.file_url}`;
        } else {
          message += `\n📎 [Processing complete - file will be available shortly]`;
        }
        if (short.thumbnail_url && !short.thumbnail_url.includes('placeholder')) {
          message += `\n🖼️ Preview: ${short.thumbnail_url}`;
        }
        if (short.duration) {
          message += `\n⏱️ Duration: ${short.duration}s`;
        }
        if (short.watermark && subscription_type === 'free') {
          message += `\n💧 Watermark: ${short.watermark}`;
        }
      });
      
      if (subscription_type === 'free') {
        message += `\n\n🚀 Upgrade to Premium for:
• 🎯 HD Quality (1080p)
• 🚫 No Watermarks
• 📈 Unlimited Processing
• 🎵 Auto Music & Captions
• ⚡ Priority Processing

Contact @Osezblessed to upgrade!`;
      }
      
      // Add usage stats for premium users
      if (subscription_type !== 'free') {
        message += `\n\n📊 This ${subscription_type} processing:
• Quality: ${results[0]?.quality}${subscription_type === 'pro' ? ' (Ultra HD)' : ''}
• Features: ${results[0]?.features_applied?.join(', ') || 'Standard'}
${subscription_type === 'pro' ? '• Analytics: Available in Pro dashboard' : ''}`;
      }
      
      await bot.sendMessage(chatIdNum, message);
      console.log(`✅ Success message sent to chat ${chatIdNum}`);
      
    } else if (status === 'error' || status === 'failed') {
      const errorMsg = `❌ Processing failed

${req.body.error_message || 'Unknown error occurred'}

🔄 What to try:
• Check if video URL is accessible
• Try a shorter video (under 20 minutes)
• Ensure video is not private/restricted
• Wait a few minutes and try again

Contact @Osezblessed if this persists.
Processing ID: ${processing_id}`;

      await bot.sendMessage(chatIdNum, errorMsg);
      console.log(`❌ Error message sent to chat ${chatIdNum}`);
      
      // Revert usage for failed processing
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
    const { telegram_id, chat_id, error_message, processing_id, error_type } = req.body;
    
    const chatIdNum = parseInt(chat_id);
    const telegramIdNum = parseInt(telegram_id);
    
    if (chatIdNum) {
      const errorMsg = `❌ Video Processing Failed

🔍 Error: ${error_message || 'Unknown error occurred'}
📝 Type: ${error_type || 'processing_error'}

🔄 What to do:
• Check if the video URL is valid and accessible
• Ensure the video is public (not private/restricted)
• Try with a shorter video (under 20 minutes for free users)
• Wait a few minutes and try again
• Contact @Osezblessed if the issue persists

💡 Tips:
• YouTube videos work best
• Avoid very long videos (30+ minutes)
• Ensure stable internet connection

Processing ID: ${processing_id || 'N/A'}`;

      await bot.sendMessage(chatIdNum, errorMsg);
      
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

// ADMIN AND ANALYTICS ENDPOINTS

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'VideoShortsBot Business API Running',
    version: '2.0.0',
    timestamp: new Date(),
    stats: {
      total_users: users.size,
      active_processing_jobs: processingJobs.size,
      uptime_seconds: Math.floor(process.uptime())
    },
    features: [
      'File Storage',
      'Premium Subscriptions', 
      'Referral System',
      'Multi-platform Support'
    ]
  });
});

// Enhanced admin stats endpoint
app.get('/admin/stats', (req, res) => {
  const now = new Date();
  const today = now.toDateString();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  const stats = {
    overview: {
      total_users: users.size,
      free_users: Array.from(users.values()).filter(u => u.subscription_type === 'free').length,
      premium_users: Array.from(users.values()).filter(u => u.subscription_type === 'premium').length,
      pro_users: Array.from(users.values()).filter(u => u.subscription_type === 'pro').length,
      active_processing_jobs: processingJobs.size
    },
    usage_stats: {
      total_videos_processed: Array.from(users.values()).reduce((sum, u) => sum + u.total_usage, 0),
      videos_today: Array.from(users.values()).reduce((sum, u) => sum + u.daily_usage, 0),
      average_daily_usage: users.size > 0 ? (Array.from(users.values()).reduce((sum, u) => sum + u.daily_usage, 0) / users.size).toFixed(2) : 0
    },
    referral_stats: {
      total_referrals: Array.from(users.values()).reduce((sum, u) => sum + u.referred_users, 0),
      top_referrers: Array.from(users.values())
        .filter(u => u.referred_users > 0)
        .sort((a, b) => b.referred_users - a.referred_users)
        .slice(0, 5)
        .map(u => ({
          name: u.first_name,
          telegram_id: u.telegram_id,
          referrals: u.referred_users
        }))
    },
    revenue_projection: {
      monthly_premium_revenue: Array.from(users.values()).filter(u => u.subscription_type === 'premium').length * 2.99,
      monthly_pro_revenue: Array.from(users.values()).filter(u => u.subscription_type === 'pro').length * 9.99,
      total_monthly_projection: (Array.from(users.values()).filter(u => u.subscription_type === 'premium').length * 2.99) + 
                               (Array.from(users.values()).filter(u => u.subscription_type === 'pro').length * 9.99)
    },
    recent_users: Array.from(users.entries())
      .sort(([,a], [,b]) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10)
      .map(([id, user]) => ({
        telegram_id: id,
        name: user.first_name,
        subscription: user.subscription_type,
        daily_usage: user.daily_usage,
        total_usage: user.total_usage,
        joined: user.created_at
      }))
  };
  
  res.json(stats);
});

// Analytics dashboard (HTML)
app.get('/dashboard', (req, res) => {
  const stats = {
    total_users: users.size,
    premium_users: Array.from(users.values()).filter(u => u.subscription_type === 'premium').length,
    pro_users: Array.from(users.values()).filter(u => u.subscription_type === 'pro').length,
    total_videos: Array.from(users.values()).reduce((sum, u) => sum + u.total_usage, 0)
  };
  
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>VideoShortsBot Dashboard</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
      .card { background: white; padding: 20px; margin: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .stat { font-size: 2em; font-weight: bold; color: #2196F3; }
      .label { color: #666; margin-top: 5px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
    </style>
  </head>
  <body>
    <h1>📊 VideoShortsBot Analytics Dashboard</h1>
    <div class="grid">
      <div class="card">
        <div class="stat">${stats.total_users}</div>
        <div class="label">Total Users</div>
      </div>
      <div class="card">
        <div class="stat">${stats.premium_users}</div>
        <div class="label">Premium Users</div>
      </div>
      <div class="card">
        <div class="stat">${stats.pro_users}</div>
        <div class="label">Pro Users</div>
      </div>
      <div class="card">
        <div class="stat">${stats.total_videos}</div>
        <div class="label">Videos Processed</div>
      </div>
      <div class="card">
        <div class="stat">${((stats.premium_users * 2.99) + (stats.pro_users * 9.99)).toFixed(2)}</div>
        <div class="label">Monthly Revenue</div>
      </div>
    </div>
    
    <div class="card">
      <h3>Quick Stats</h3>
      <p>Conversion Rate: ${stats.total_users > 0 ? (((stats.premium_users + stats.pro_users) / stats.total_users) * 100).toFixed(1) : 0}%</p>
      <p>Average Revenue Per User: ${stats.total_users > 0 ? (((stats.premium_users * 2.99) + (stats.pro_users * 9.99)) / stats.total_users).toFixed(2) : 0}</p>
      <p>Last Updated: ${new Date().toLocaleString()}</p>
    </div>
  </body>
  </html>
  `;
  
  res.send(html);
});

// Test endpoint for debugging
app.get('/test', (req, res) => {
  res.json({
    message: 'Test endpoint working',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    endpoints: {
      webhooks: [
        'POST /webhook/n8n-callback',
        'POST /webhook/n8n-error'
      ],
      files: [
        'POST /upload-processed-video',
        'POST /upload-thumbnail',
        'GET /downloads/:filename',
        'GET /thumbs/:filename'
      ],
      admin: [
        'GET /admin/stats',
        'GET /dashboard'
      ]
    },
    storage: {
      downloads_dir: './downloads',
      thumbnails_dir: './thumbnails',
      temp_dir: './temp'
    }
  });
});

// Test upload endpoint
app.get('/test-upload', (req, res) => {
  res.send(`
    <html>
    <body>
      <h2>Test File Upload</h2>
      <form action="/upload-processed-video" method="post" enctype="multipart/form-data">
        <input type="text" name="processing_id" placeholder="Processing ID" required><br><br>
        <input type="text" name="short_id" placeholder="Short ID" required><br><br>
        <input type="file" name="video" accept="video/*" required><br><br>
        <button type="submit">Upload Video</button>
      </form>
      
      <form action="/upload-thumbnail" method="post" enctype="multipart/form-data">
        <input type="text" name="processing_id" placeholder="Processing ID" required><br><br>
        <input type="text" name="short_id" placeholder="Short ID" required><br><br>
        <input type="file" name="thumbnail" accept="image/*" required><br><br>
        <button type="submit">Upload Thumbnail</button>
      </form>
    </body>
    </html>
  `);
});

// API endpoint for checking processing status
app.get('/api/processing/:processing_id', (req, res) => {
  const processingId = req.params.processing_id;
  const job = processingJobs.get(processingId);
  
  if (!job) {
    return res.status(404).json({
      error: 'Processing job not found',
      processing_id: processingId,
      status: 'not_found'
    });
  }
  
  const elapsedTime = Date.now() - job.startTime;
  const estimatedCompletion = job.subscription_type === 'free' ? 5 * 60 * 1000 : // 5 minutes
                             job.subscription_type === 'premium' ? 2 * 60 * 1000 : // 2 minutes
                             1 * 60 * 1000; // 1 minute for pro
  
  res.json({
    processing_id: processingId,
    status: 'processing',
    elapsed_time_ms: elapsedTime,
    estimated_completion_ms: estimatedCompletion,
    progress: Math.min((elapsedTime / estimatedCompletion) * 100, 95), // Never show 100% until complete
    subscription_type: job.subscription_type
  });
});

// Webhook for payment confirmations (placeholder for Flutterwave integration)
app.post('/webhook/payment', express.raw({type: 'application/json'}), (req, res) => {
  console.log('Payment webhook received');
  
  // In production, you would:
  // 1. Verify webhook signature
  // 2. Update user subscription in database
  // 3. Send confirmation to user
  
  res.json({ status: 'received' });
});

// 404 handler
app.use((req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.path,
    available_endpoints: {
      webhooks: [
        'POST /webhook/n8n-callback',
        'POST /webhook/n8n-error',
        'POST /webhook/payment'
      ],
      files: [
        'POST /upload-processed-video',
        'POST /upload-thumbnail', 
        'GET /downloads/:filename',
        'GET /thumbs/:filename'
      ],
      admin: [
        'GET /',
        'GET /test',
        'GET /dashboard',
        'GET /admin/stats',
        'GET /test-upload'
      ],
      api: [
        'GET /api/processing/:processing_id'
      ]
    }
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🤖 VideoShortsBot Business API v2.0 running on port ${PORT}`);
  console.log(`🌐 Main URL: https://video-shorts-business-bot.onrender.com`);
  console.log(`🌐 Webhook URL: https://video-shorts-business-bot.onrender.com/webhook/n8n-callback`);
  console.log(`🌐 Error Webhook: https://video-shorts-business-bot.onrender.com/webhook/n8n-error`);
  console.log(`🌐 Dashboard: https://video-shorts-business-bot.onrender.com/dashboard`);
  console.log(`📁 File Storage: Enabled (downloads, thumbnails)`);
  console.log(`👥 Current Users: ${users.size}`);
  console.log(`⚙️ Processing Jobs: ${processingJobs.size}`);
});