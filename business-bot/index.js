const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const FormData = require('form-data');
const mime = require('mime-types');
const cron = require('cron');
const { createClient } = require('@supabase/supabase-js');

// Import utilities
const db = require('./utils/supabase');
const logger = require('./utils/logger');
const rateLimiterModule = require('./middleware/rateLimiter');
const validator = require('./utils/validator');

// Extract the middleware function from the module
const rateLimiter = rateLimiterModule.middleware;

// Initialize Express app and Telegram bot
const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
  request: {
    timeout: 30000,
    retries: 3
  }
});

// Enhanced middleware setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(rateLimiterModule.expressMiddleware);

// Request logging with correlation IDs
app.use((req, res, next) => {
  req.correlationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  logger.info(`${req.method} ${req.path}`, { 
    correlationId: req.correlationId,
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });
  next();
});

// Health check middleware
app.use('/health', (req, res, next) => {
  res.setHeader('X-Health-Check', 'true');
  next();
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Keep-alive service
class ServiceKeepAlive {
  constructor() {
    this.services = [
      { name: 'Business Bot', url: `${process.env.RENDER_EXTERNAL_URL || 'https://video-shorts-business-bot.onrender.com'}/health` },
      { name: 'n8n Workflow', url: `${process.env.N8N_URL || 'https://n8n-on-render-wf30.onrender.com'}/health` }
    ];
    this.failureCount = new Map();
    this.circuitOpen = new Map();
  }

  async pingService(service) {
    const failures = this.failureCount.get(service.name) || 0;
    const isCircuitOpen = this.circuitOpen.get(service.name) || false;

    if (isCircuitOpen && failures > 5) {
      logger.warn(`Circuit breaker open for ${service.name}, skipping ping`);
      return;
    }

    try {
      const response = await axios.get(service.url, { 
        timeout: 10000,
        headers: { 'X-Health-Check': 'keep-alive' }
      });
      
      logger.info(`Service ${service.name} is alive: ${response.status}`);
      this.failureCount.set(service.name, 0);
      this.circuitOpen.set(service.name, false);
      
    } catch (error) {
      const newFailureCount = failures + 1;
      this.failureCount.set(service.name, newFailureCount);
      
      if (newFailureCount > 5) {
        this.circuitOpen.set(service.name, true);
        logger.error(`Circuit breaker opened for ${service.name}`, { error: error.message });
      } else {
        logger.warn(`${service.name} ping failed (${newFailureCount}/5)`, { error: error.message });
      }
    }
  }

  async pingAll() {
    await Promise.allSettled(
      this.services.map(service => this.pingService(service))
    );
  }
}

const keepAlive = new ServiceKeepAlive();

// Ping every 14 minutes
setInterval(() => keepAlive.pingAll(), 14 * 60 * 1000);
setTimeout(() => keepAlive.pingAll(), 5000);

// Daily usage reset
const dailyResetJob = new cron.CronJob('0 0 * * *', async () => {
  logger.info('Starting daily usage reset...');
  let retries = 3;
  
  while (retries > 0) {
    try {
      await db.resetDailyUsage();
      logger.info('Daily usage reset completed successfully');
      break;
    } catch (error) {
      retries--;
      logger.error(`Daily reset failed (${3 - retries}/3)`, { error: error.message });
      
      if (retries === 0) {
        await sendAdminAlert('Daily usage reset failed after 3 attempts', error);
      } else {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}, null, true, 'UTC');

// Multer configuration
const upload = multer({
  dest: './temp/',
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mov|avi|webm|mkv|jpg|jpeg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video and image files are allowed.'));
    }
  }
});

// User service class
class UserService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  async initUser(telegramId, userInfo) {
    const cacheKey = `user_${telegramId}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.user;
    }

    try {
      let user = await db.getUser(telegramId);
      if (!user) {
        user = await db.createUser({
          telegram_id: telegramId,
          username: userInfo.username,
          first_name: userInfo.first_name
        });
        logger.info('New user created', { telegramId, username: userInfo.username });
      }

      this.cache.set(cacheKey, { user, timestamp: Date.now() });
      return user;
    } catch (error) {
      logger.error('Failed to initialize user', { telegramId, error: error.message });
      throw error;
    }
  }

  clearCache(telegramId) {
    this.cache.delete(`user_${telegramId}`);
  }

  async canProcessVideo(telegramId) {
    try {
      return await db.canUseService(telegramId);
    } catch (error) {
      logger.error('Failed to check video processing eligibility', { telegramId, error: error.message });
      return false;
    }
  }

  async updateUsage(telegramId) {
    this.clearCache(telegramId);
    return await db.incrementUsage(telegramId);
  }

  async revertUsage(telegramId) {
    this.clearCache(telegramId);
    return await db.decrementUsage(telegramId);
  }
}

const userService = new UserService();

// Platform detection
function detectPlatform(url) {
  if (!validator.isValidUrl(url)) {
    throw new Error('Invalid URL format');
  }

  const videoUrl = url.toLowerCase();
  const platforms = [
    { name: 'YouTube', patterns: ['youtube.com', 'youtu.be'] },
    { name: 'TikTok', patterns: ['tiktok.com', 'vm.tiktok.com'] },
    { name: 'Instagram', patterns: ['instagram.com'] },
    { name: 'Twitter', patterns: ['twitter.com', 'x.com'] }
  ];

  for (const platform of platforms) {
    if (platform.patterns.some(pattern => videoUrl.includes(pattern))) {
      return platform.name;
    }
  }
  return 'Unknown';
}

// Admin alert system
async function sendAdminAlert(message, error = null) {
  try {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (adminChatId) {
      const alertMessage = `ADMIN ALERT\n\n${message}\n\nTime: ${new Date().toISOString()}${error ? `\n\nError: ${error.message}` : ''}`;
      await bot.sendMessage(adminChatId, alertMessage);
    }
    logger.error('Admin alert sent', { message, error: error?.message });
  } catch (alertError) {
    logger.error('Failed to send admin alert', { error: alertError.message });
  }
}

// Processing queue with per-user limits
class VideoProcessingQueue {
  constructor() {
    this.userProcessing = new Map();
    this.processing = new Map();
    this.maxPerUser = {
      free: 1,
      premium: 3,
      pro: 5
    };
    this.maxGlobal = {
      free: 10,
      premium: 20,
      pro: 50
    };
    this.globalProcessing = {
      free: 0,
      premium: 0,
      pro: 0
    };
  }

  canProcess(telegramId, subscriptionType) {
    const userCount = this.userProcessing.get(telegramId) || 0;
    if (userCount >= this.maxPerUser[subscriptionType]) {
      logger.warn('User processing limit reached', { telegramId, userCount, limit: this.maxPerUser[subscriptionType] });
      return false;
    }

    if (this.globalProcessing[subscriptionType] >= this.maxGlobal[subscriptionType]) {
      logger.warn('Global processing limit reached', { 
        subscriptionType, 
        current: this.globalProcessing[subscriptionType], 
        limit: this.maxGlobal[subscriptionType] 
      });
      return false;
    }

    return true;
  }

  startProcessing(processingId, telegramId, subscriptionType) {
    const userCount = this.userProcessing.get(telegramId) || 0;
    this.userProcessing.set(telegramId, userCount + 1);
    
    this.globalProcessing[subscriptionType]++;
    
    this.processing.set(processingId, { 
      telegramId, 
      subscriptionType,
      startTime: Date.now()
    });
    
    logger.info('Processing started', { 
      processingId, 
      telegramId, 
      subscriptionType,
      userCount: userCount + 1,
      globalCount: this.globalProcessing[subscriptionType]
    });
  }

  finishProcessing(processingId) {
    const processInfo = this.processing.get(processingId);
    if (processInfo) {
      const { telegramId, subscriptionType } = processInfo;
      
      const userCount = this.userProcessing.get(telegramId) || 0;
      if (userCount > 0) {
        this.userProcessing.set(telegramId, userCount - 1);
        if (userCount - 1 === 0) {
          this.userProcessing.delete(telegramId);
        }
      }
      
      if (this.globalProcessing[subscriptionType] > 0) {
        this.globalProcessing[subscriptionType]--;
      }
      
      this.processing.delete(processingId);
      
      const processingTime = Date.now() - processInfo.startTime;
      logger.info('Processing finished', { 
        processingId, 
        telegramId, 
        subscriptionType,
        processingTimeMs: processingTime,
        remainingUserCount: this.userProcessing.get(telegramId) || 0,
        remainingGlobalCount: this.globalProcessing[subscriptionType]
      });
    }
  }

  cleanupStaleProcessing() {
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    const staleEntries = [];
    
    for (const [processingId, processInfo] of this.processing.entries()) {
      if (processInfo.startTime < thirtyMinutesAgo) {
        staleEntries.push(processingId);
      }
    }
    
    for (const processingId of staleEntries) {
      logger.warn('Cleaning up stale processing entry', { processingId });
      this.finishProcessing(processingId);
    }
    
    return staleEntries.length;
  }

  getStatus() {
    return {
      userProcessing: Object.fromEntries(this.userProcessing),
      globalProcessing: this.globalProcessing,
      totalActive: this.processing.size,
      activeProcesses: Array.from(this.processing.entries()).map(([id, info]) => ({
        id,
        telegramId: info.telegramId,
        subscriptionType: info.subscriptionType,
        duration: Date.now() - info.startTime
      }))
    };
  }
}

const processingQueue = new VideoProcessingQueue();

// Clean up stale processing every 5 minutes
setInterval(() => {
  const cleaned = processingQueue.cleanupStaleProcessing();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} stale processing entries`);
  }
}, 5 * 60 * 1000);

// ==================== TELEGRAM BOT COMMANDS ====================

// START command
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  try {
    const user = await userService.initUser(telegramId, msg.from);
    const referralCode = match && match[1] ? match[1] : null;
    
    if (referralCode && referralCode.startsWith('REF') && referralCode !== user.referral_code) {
      const referrerId = referralCode.replace('REF', '');
      if (referrerId !== telegramId.toString()) {
        try {
          logger.info('Referral processed', { referrerId, newUserId: telegramId });
        } catch (err) {
          logger.warn('Referral processing failed', { referrerId, error: err.message });
        }
      }
    }
    
    const subscriptionStatus = user.subscription_expires && new Date() < new Date(user.subscription_expires) 
      ? `Active until ${new Date(user.subscription_expires).toLocaleDateString()}` 
      : 'Free Plan';
    
    const welcomeMessage = `Welcome to VideoShortsBot!

Transform long videos into viral shorts instantly!

YOUR PLAN: ${user.subscription_type.toUpperCase()}
Status: ${subscriptionStatus}

Today's Usage: ${user.daily_usage}/3 (Free users)
Total Processed: ${user.total_usage} videos
Referrals: ${user.referred_users} users

FREE FEATURES:
• 3 videos per day
• 60-second shorts
• YouTube & TikTok support

PREMIUM ($2.99/month):
• Unlimited videos
• Custom lengths (15s-90s)
• All platforms + Instagram
• Priority processing
• No watermarks

PRO ($9.99/month):
• Everything in Premium
• API access
• White-label rights
• Custom branding
• Reseller dashboard

Ready? Use these commands:

/url - Process video from URL
/upload - Upload video file
/stats - View your statistics
/upgrade - Upgrade your plan
/referral - Get referral link
/help - Get help

You can also just send me a video URL or file directly!`;
    
    await bot.sendMessage(chatId, welcomeMessage);
    
    await db.logUsage({
      telegram_id: telegramId,
      action: 'bot_started',
      success: true
    });
    
  } catch (error) {
    logger.error('Start command error', { telegramId, error: error.message });
    await bot.sendMessage(chatId, 'Welcome to VideoShortsBot! There was a temporary issue, but you can start using the bot by sending a video URL.');
  }
});

// URL command
bot.onText(/\/url/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const chatId = msg.chat.id;
  
  const urlMessage = `Send me a video URL to process!

Supported platforms:
• YouTube (youtube.com, youtu.be)
• TikTok (tiktok.com)
• Instagram (instagram.com) - Premium only
• Twitter/X (twitter.com, x.com) - Premium only

Just paste the URL and I'll process it for you!

Example:
https://www.youtube.com/watch?v=example
https://youtu.be/example
https://www.tiktok.com/@user/video/123`;

  await bot.sendMessage(chatId, urlMessage);
});

// UPLOAD command
bot.onText(/\/upload/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  try {
    const user = await userService.initUser(telegramId, msg.from);
    
    const uploadMessage = `Upload a video file to process!

File requirements:
• Max size: ${user.subscription_type === 'free' ? '50MB' : user.subscription_type === 'premium' ? '200MB' : '1GB'}
• Formats: MP4, MOV, AVI, WEBM, MKV
• Duration: Up to ${user.subscription_type === 'free' ? '1.5 minutes' : '10 minutes'}

Just send me your video file and I'll create viral shorts from it!

Tip: Compress large videos before uploading for faster processing.`;

    await bot.sendMessage(chatId, uploadMessage);
  } catch (error) {
    logger.error('Upload command error', { telegramId, error: error.message });
    await bot.sendMessage(chatId, 'Send me a video file to process into viral shorts!');
  }
});

// STATS command
bot.onText(/\/stats/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  
  try {
    const user = await db.getUser(telegramId);
    
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the bot first with /start');
    }
    
    const subscriptionStatus = user.subscription_expires && new Date() < new Date(user.subscription_expires)
      ? `Active until ${new Date(user.subscription_expires).toLocaleDateString()}`
      : user.subscription_type === 'free' ? 'Free Plan' : 'Expired';
    
    const statsMessage = `YOUR STATISTICS

Account: ${user.first_name}
Plan: ${user.subscription_type.toUpperCase()}
Status: ${subscriptionStatus}

Usage Today: ${user.daily_usage}/${user.subscription_type === 'free' ? '3' : 'Unlimited'}
Total Processed: ${user.total_usage} videos
Referred Users: ${user.referred_users}
Member Since: ${new Date(user.created_at).toLocaleDateString()}

Your Referral Code: ${user.referral_code}
Share: https://t.me/videoshortsaibot?start=${user.referral_code}

${user.subscription_type === 'free' ? 
  'Want unlimited access? /upgrade' : 
  subscriptionStatus.includes('Active') ? 'Premium account active' : 'Subscription expired - /upgrade'
}`;
    
    await bot.sendMessage(chatId, statsMessage);
    
  } catch (error) {
    logger.error('Stats command error', { telegramId, error: error.message });
    await bot.sendMessage(chatId, 'Unable to fetch your statistics right now. Please try again later.');
  }
});

// UPGRADE command
bot.onText(/\/upgrade/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const upgradeMessage = `UPGRADE YOUR EXPERIENCE

NIGERIAN PRICING:

PREMIUM - N1,200/month (~$2.99):
• Unlimited videos
• Custom lengths (15s-90s)
• All platforms + Instagram + Twitter
• Priority processing
• No watermarks
• Batch processing

PRO - N4,000/month (~$9.99):
• Everything in Premium
• API access for developers
• White-label bot rights
• Custom branding & watermarks
• Reseller dashboard
• 30% commission on referrals
• Priority support

Payment Methods:
• Bank Transfer • Debit Cards
• USSD • Mobile Money

Contact @Osezblessed to upgrade!`;
  
  const keyboard = {
    inline_keyboard: [
      [{text: 'Upgrade to Premium', url: 'https://t.me/Osezblessed'}],
      [{text: 'Upgrade to Pro', url: 'https://t.me/Osezblessed'}],
      [{text: 'Referral Program', callback_data: 'referral_info'}]
    ]
  };
  
  bot.sendMessage(msg.chat.id, upgradeMessage, {reply_markup: keyboard});
});

// REFERRAL command
bot.onText(/\/referral/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  
  try {
    const user = await db.getUser(telegramId);
    
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the bot first with /start');
    }
    
    const referralMessage = `REFERRAL PROGRAM

Your referral link:
https://t.me/videoshortsaibot?start=${user.referral_code}

Your Stats:
• Referred Users: ${user.referred_users}
• Your Code: ${user.referral_code}

Rewards:
• Free users: 1 extra video per referral
• Premium users: N100 commission per referral
• Pro users: N300 commission per referral

Share your link and earn rewards when people join!`;
    
    await bot.sendMessage(chatId, referralMessage);
    
  } catch (error) {
    logger.error('Referral command error', { telegramId, error: error.message });
    await bot.sendMessage(chatId, 'Unable to get your referral info right now. Please try again later.');
  }
});

// HELP command
bot.onText(/\/help/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const helpMessage = `HELP & SUPPORT

Commands:
/url - Process video from URL
/upload - Upload video file
/stats - View statistics
/upgrade - Upgrade plan
/referral - Referral program
/help - This help message

How to use:
1. Send /url and paste a video URL
2. Or send /upload and send a video file
3. Wait for processing (1-5 minutes)
4. Download your viral shorts!

Supported platforms:
• YouTube
• TikTok
• Instagram (Premium)
• Twitter/X (Premium)

Need help?
Contact @Osezblessed for support

Tips:
• Use shorter videos for faster processing
• Premium users get priority processing
• Check /stats for usage limits`;
  
  await bot.sendMessage(msg.chat.id, helpMessage);
});

// Handle video URL processing
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const videoUrlPattern = /(youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok\.com|instagram\.com|twitter\.com|x\.com)/i;
  
  if (msg.text && videoUrlPattern.test(msg.text)) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const videoUrl = msg.text.trim();
    let processingId = null;
    
    logger.info('Processing video request', { telegramId, videoUrl });
    
    try {
      if (!validator.isValidUrl(videoUrl)) {
        return bot.sendMessage(chatId, 'Invalid URL format. Please send a valid video URL.');
      }

      const user = await userService.initUser(telegramId, msg.from);
      
      if (!(await userService.canProcessVideo(telegramId))) {
        const limitMessage = `Daily limit reached!

You've used your 3 free videos today.

Upgrade to Premium for unlimited access!
Contact @Osezblessed to upgrade instantly!`;
        
        return bot.sendMessage(chatId, limitMessage);
      }
      
      if (user.subscription_type === 'free') {
        const platform = detectPlatform(videoUrl);
        if (['Instagram', 'Twitter'].includes(platform)) {
          return bot.sendMessage(chatId, `${platform} processing requires Premium subscription. Contact @Osezblessed to upgrade!`);
        }
      }

      if (!processingQueue.canProcess(telegramId, user.subscription_type)) {
        const queueStatus = processingQueue.getStatus();
        const userProcessingCount = queueStatus.userProcessing[telegramId] || 0;
        
        return bot.sendMessage(chatId, `You already have ${userProcessingCount} video(s) processing. Please wait for them to complete.

Your limit: ${processingQueue.maxPerUser[user.subscription_type]} concurrent videos
${user.subscription_type === 'free' ? '\nUpgrade to Premium for higher limits!' : ''}`);
      }
      
      processingId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      processingQueue.startProcessing(processingId, telegramId, user.subscription_type);
      
      const processingMessages = {
        free: 'Processing your video... This may take 2-5 minutes.',
        premium: 'Premium processing started... 1-2 minutes remaining.',
        pro: 'Pro processing initiated... 30-60 seconds remaining.'
      };
      
      await bot.sendMessage(chatId, processingMessages[user.subscription_type]);
      
      const videoRecord = await db.createVideo({
        processing_id: processingId,
        telegram_id: telegramId,
        video_url: videoUrl,
        platform: detectPlatform(videoUrl),
        subscription_type: user.subscription_type
      });
      
      await userService.updateUsage(telegramId);
      
      const n8nPayload = {
       telegram_id: String(telegramId),  // Convert to string
  chat_id: String(chatId),          // Convert to string
        video_url: videoUrl,
        user_name: user.first_name,
        subscription_type: user.subscription_type,
        webhook_secret: process.env.N8N_WEBHOOK_SECRET || '7f9d0d2e8a6f4f38a13a2bcf5b6d441b91c9d26e8b72714d2edcf7c4e2a843ke',
        callback_url: `${process.env.RENDER_EXTERNAL_URL || 'https://video-shorts-business-bot.onrender.com'}/webhook/n8n-callback`,
        processing_id: processingId,
        user_limits: {
          max_shorts: user.subscription_type === 'free' ? 2 : user.subscription_type === 'premium' ? 4 : 6,
          max_duration: user.subscription_type === 'free' ? 60 : 90,
          priority: user.subscription_type === 'free' ? 'low' : user.subscription_type === 'premium' ? 'medium' : 'high'
        }
      };

      let retries = 3;
      let lastError;
      
      while (retries > 0) {
        try {
          const response = await axios.post(
            'https://n8n-on-render-wf30.onrender.com/webhook/video-processing',
            n8nPayload,
            {
              timeout: 30000,
              headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.N8N_WEBHOOK_SECRET}`
    }
            }
          );
          
          logger.info('n8n workflow triggered successfully', { 
            processingId, 
            telegramId, 
            response: response.data 
          });
          break;
          
        } catch (error) {
          lastError = error;
          retries--;
          
          if (retries > 0) {
            logger.warn(`n8n call failed, retrying (${3-retries}/3)`, { 
              processingId, 
              error: error.message 
            });
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      
      if (retries === 0) {
        throw lastError;
      }
      
      await db.logUsage({
        telegram_id: telegramId,
        processing_id: processingId,
        action: 'video_processing_started',
        platform: detectPlatform(videoUrl),
        success: true
      });
      
    } catch (error) {
      logger.error('Video processing error', { telegramId, videoUrl, error: error.message });
      
      await bot.sendMessage(chatId, `Processing failed: ${error.response?.data?.message || error.message}

Please try again in a few minutes.
If the issue persists, contact @Osezblessed

Error code: ${error.response?.status || 'NETWORK_ERROR'}`);
      
      await userService.revertUsage(telegramId);
      
      if (processingId) {
        processingQueue.finishProcessing(processingId);
      }
      
      await db.logUsage({
        telegram_id: telegramId,
        processing_id: processingId || null,
        action: 'video_processing_failed',
        platform: detectPlatform(videoUrl),
        success: false,
        error_message: error.message
      });
    }
  }
});

// Handle file uploads
bot.on('video', async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  await handleFileUpload(msg, 'video');
});

bot.on('document', async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const fileName = msg.document.file_name || '';
  const videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv', '.wmv'];
  
  if (videoExtensions.some(ext => fileName.toLowerCase().endsWith(ext))) {
    await handleFileUpload(msg, 'document');
  }
});

// Handle file upload processing
async function handleFileUpload(msg, fileType) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  let processingId = null;
  
  logger.info('File upload received', { telegramId, fileType, chatId });
  
  try {
    const user = await userService.initUser(telegramId, msg.from);
    
    if (!(await userService.canProcessVideo(telegramId))) {
      const limitMessage = `Daily limit reached!

You've used your 3 free videos today.

Upgrade to Premium for unlimited access!
Contact @Osezblessed to upgrade instantly!`;
      
      return bot.sendMessage(chatId, limitMessage);
    }

    const file = msg[fileType];
    
    const maxSizes = {
      free: 50 * 1024 * 1024,      // 50MB
      premium: 200 * 1024 * 1024,  // 200MB
      pro: 1024 * 1024 * 1024      // 1GB
    };
    
    const maxSize = maxSizes[user.subscription_type] || maxSizes.free;
    
    if (file.file_size > maxSize) {
      const limits = {
        free: '50MB',
        premium: '200MB',  
        pro: '1GB'
      };
      
      return bot.sendMessage(chatId, `File too large! 

Your limit: ${limits[user.subscription_type] || '50MB'}
File size: ${Math.round(file.file_size / 1024 / 1024)}MB

Upgrade for higher limits: /upgrade`);
    }

    if (!processingQueue.canProcess(telegramId, user.subscription_type)) {
      const queueStatus = processingQueue.getStatus();
      const userProcessingCount = queueStatus.userProcessing[telegramId] || 0;
      
      return bot.sendMessage(chatId, `You already have ${userProcessingCount} video(s) processing. Please wait for them to complete.

Your limit: ${processingQueue.maxPerUser[user.subscription_type]} concurrent videos
${user.subscription_type === 'free' ? '\nUpgrade to Premium for higher limits!' : ''}`);
    }
    
    processingId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    processingQueue.startProcessing(processingId, telegramId, user.subscription_type);
    
    const processingMessages = {
      free: 'Processing your video file... This may take 3-7 minutes.',
      premium: 'Premium file processing... 2-4 minutes remaining.',
      pro: 'Pro file processing... 1-3 minutes remaining.'
    };
    
    await bot.sendMessage(chatId, processingMessages[user.subscription_type]);
    
    const videoRecord = await db.createVideo({
      processing_id: processingId,
      telegram_id: telegramId,
      video_url: null,
      platform: 'file_upload',
      subscription_type: user.subscription_type,
      file_name: file.file_name,
      file_size: file.file_size,
      mime_type: file.mime_type
    });
    
    await userService.updateUsage(telegramId);
    
    const n8nPayload = {
     telegram_id: String(telegramId),  // Convert to string
  chat_id: String(chatId),          // Convert to string
      file_id: file.file_id,
      file_name: file.file_name,
      file_size: file.file_size,
      mime_type: file.mime_type,
      user_name: user.first_name,
      subscription_type: user.subscription_type,
      webhook_secret: process.env.N8N_WEBHOOK_SECRET || '7f9d0d2e8a6f4f38a13a2bcf5b6d441b91c9d26e8b72714d2edcf7c4e2a843ke',
      callback_url: `${process.env.RENDER_EXTERNAL_URL || 'https://video-shorts-business-bot.onrender.com'}/webhook/n8n-callback`,
      processing_id: processingId,
      user_limits: {
        max_shorts: user.subscription_type === 'free' ? 2 : user.subscription_type === 'premium' ? 4 : 6,
        max_duration: user.subscription_type === 'free' ? 60 : 90,
        priority: user.subscription_type === 'free' ? 'low' : user.subscription_type === 'premium' ? 'medium' : 'high'
      }
    };

    let retries = 3;
    let lastError;
    
    while (retries > 0) {
      try {
        const response = await axios.post(
          'https://n8n-on-render-wf30.onrender.com/webhook/video-processing',
          n8nPayload,
          {
            timeout: 30000,
            headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.N8N_WEBHOOK_SECRET}`
    }
          }
        );
        
        logger.info('n8n workflow triggered for file upload', { 
          processingId, 
          telegramId,
          fileName: file.file_name,
          fileSize: file.file_size,
          response: response.data 
        });
        break;
        
      } catch (error) {
        lastError = error;
        retries--;
        
        if (retries > 0) {
          logger.warn(`n8n file call failed, retrying (${3-retries}/3)`, { 
            processingId, 
            error: error.message 
          });
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (retries === 0) {
      throw lastError;
    }
    
    await db.logUsage({
      telegram_id: telegramId,
      processing_id: processingId,
      action: 'file_processing_started',
      platform: 'file_upload',
      file_size_bytes: file.file_size,
      success: true
    });
    
  } catch (error) {
    logger.error('File processing error', { telegramId, fileType, error: error.message });
    
    await bot.sendMessage(chatId, `File processing failed: ${error.message}

Please try again or try a smaller file.
If the issue persists, contact @Osezblessed`);
    
    await userService.revertUsage(telegramId);
    
    if (processingId) {
      processingQueue.finishProcessing(processingId);
    }
    
    await db.logUsage({
      telegram_id: telegramId,
      processing_id: processingId || null,
      action: 'file_processing_failed',
      platform: 'file_upload',
      success: false,
      error_message: error.message
    });
  }
}

// ==================== HTTP ENDPOINTS ====================

// Enhanced file upload endpoints
app.post('/upload-processed-video', upload.single('video'), async (req, res) => {
  const correlationId = req.correlationId || `upload_${Date.now()}`;
  
  try {
    logger.info('Received video upload', { 
      correlationId,
      body: req.body,
      file: req.file ? { 
        originalname: req.file.originalname, 
        size: req.file.size, 
        mimetype: req.file.mimetype 
      } : null 
    });
    
    const { processing_id, short_id, subscription_type } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ 
        error: 'No video file uploaded',
        correlationId 
      });
    }
    
    if (!processing_id || !short_id) {
      return res.status(400).json({ 
        error: 'Missing processing_id or short_id',
        correlationId 
      });
    }
    
    const maxFileSize = 200 * 1024 * 1024; // 200MB
    if (file.size > maxFileSize) {
      await fs.unlink(file.path).catch(console.error);
      return res.status(400).json({ 
        error: 'File too large. Maximum size is 200MB.',
        correlationId 
      });
    }
    
    const fileBuffer = await fs.readFile(file.path);
    const contentType = mime.lookup(file.originalname) || 'video/mp4';
    
    const bucket = subscription_type === 'free' ? 'video-files' : 'premium-videos';
    const fileName = `${short_id}_${Date.now()}.mp4`;
    const storagePath = `videos/${processing_id}/${fileName}`;
    
    let uploadResult;
    let retries = 3;
    let lastUploadError;
    
    while (retries > 0) {
      try {
        uploadResult = await db.uploadFile(bucket, storagePath, fileBuffer, contentType);
        break;
      } catch (uploadError) {
        lastUploadError = uploadError;
        retries--;
        if (retries === 0) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (!uploadResult) {
      throw lastUploadError || new Error('Upload failed after retries');
    }
    
    await fs.unlink(file.path);
    
    await db.updateVideo(processing_id, {
      file_path: storagePath,
      file_url: uploadResult.publicUrl,
      file_size_bytes: file.size,
      storage_bucket: bucket,
      status: 'completed'
    });
    
    await db.createShort({
      short_id: short_id,
      processing_id: processing_id,
      title: `Processed Short - ${short_id}`,
      file_url: uploadResult.publicUrl,
      storage_path: storagePath,
      storage_bucket: bucket,
      file_size_bytes: file.size,
      status: 'completed',
      subscription_type: subscription_type || 'free'
    });
    
    logger.info('Video uploaded successfully', { 
      correlationId,
      processingId: processing_id,
      fileUrl: uploadResult.publicUrl,
      fileSize: file.size 
    });
    
    res.json({
      success: true,
      file_url: uploadResult.publicUrl,
      file_size: file.size,
      file_path: storagePath,
      correlationId
    });
    
  } catch (error) {
    logger.error('Video upload error', { 
      correlationId,
      error: error.message 
    });
    
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(console.error);
    }
    
    res.status(500).json({ 
      error: 'Video upload failed', 
      details: error.message,
      correlationId 
    });
  }
});

app.post('/upload-thumbnail', upload.single('thumbnail'), async (req, res) => {
  const correlationId = req.correlationId || `thumb_${Date.now()}`;
  
  try {
    const { processing_id, short_id } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ 
        error: 'No thumbnail uploaded',
        correlationId 
      });
    }
    
    const fileBuffer = await fs.readFile(file.path);
    const contentType = mime.lookup(file.originalname) || 'image/jpeg';
    
    const fileName = `${short_id}_thumb_${Date.now()}.jpg`;
    const storagePath = `thumbnails/${processing_id}/${fileName}`;
    
    const uploadResult = await db.uploadFile('thumbnails', storagePath, fileBuffer, contentType);
    
    await fs.unlink(file.path);
    
    await db.updateVideo(processing_id, {
      thumbnail_path: storagePath,
      thumbnail_url: uploadResult.publicUrl
    });
    
    res.json({
      success: true,
      thumbnail_url: uploadResult.publicUrl,
      thumbnail_path: storagePath,
      correlationId
    });
    
  } catch (error) {
    logger.error('Thumbnail upload error', { 
      correlationId,
      error: error.message 
    });
    
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(console.error);
    }
    
    res.status(500).json({ 
      error: 'Thumbnail upload failed', 
      details: error.message,
      correlationId 
    });
  }
});

// Enhanced webhook callback handling
app.post('/webhook/n8n-callback', async (req, res) => {
  const correlationId = req.correlationId || `n8n_callback_${Date.now()}`;
  
  logger.info('Received n8n callback', { 
    correlationId,
    body: req.body,
    headers: req.headers,
    contentType: req.headers['content-type']
  });
  
  try {
    const callbackData = req.body;
    
    const {
      processing_id,
      telegram_id,
      chat_id,
      status,
      shorts_results,
      total_shorts,
      subscription_type,
      processing_completed_at,
      platform,
      error_message
    } = callbackData;
    
    const requiredFields = { processing_id, telegram_id, chat_id };
    const missingFields = [];
    
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value || value === 'undefined' || value === 'null' || String(value).trim() === '') {
        missingFields.push(field);
      }
    }
    
    if (missingFields.length > 0) {
      const errorDetails = {
        missingFields,
        receivedData: callbackData,
        availableFields: Object.keys(callbackData)
      };
      
      logger.error('Invalid callback data - missing required fields', { correlationId, ...errorDetails });
      return res.status(400).json({ 
        error: `Missing required fields: ${missingFields.join(', ')}`,
        details: errorDetails,
        correlationId
      });
    }
    
    let telegramIdNum, chatIdNum;
    
    try {
      telegramIdNum = parseInt(String(telegram_id).trim());
      chatIdNum = parseInt(String(chat_id).trim());
      
      if (isNaN(telegramIdNum) || isNaN(chatIdNum)) {
        throw new Error('Invalid ID format');
      }
    } catch (parseError) {
      logger.error('Failed to parse IDs', { 
        correlationId,
        telegram_id, 
        chat_id, 
        error: parseError.message 
      });
      return res.status(400).json({ 
        error: 'Invalid telegram_id or chat_id format',
        received: { telegram_id, chat_id },
        correlationId
      });
    }
    
    logger.info('Processing callback', {
      correlationId,
      processingId: processing_id,
      telegramId: telegramIdNum,
      chatId: chatIdNum,
      status
    });
    
    processingQueue.finishProcessing(processing_id);
    
    try {
      await db.updateVideo(processing_id, {
        status: status === 'completed' ? 'completed' : 'failed',
        completed_at: status === 'completed' ? new Date().toISOString() : null,
        error_message: status === 'failed' ? 
          (error_message || 'Processing failed') : null
      });
    } catch (dbError) {
      logger.error('Failed to update video record', {
        correlationId,
        processingId: processing_id,
        error: dbError.message
      });
    }
    
    if (status === 'completed') {
      let results = [];
      try {
        if (typeof shorts_results === 'string') {
          results = JSON.parse(shorts_results);
        } else if (Array.isArray(shorts_results)) {
          results = shorts_results;
        } else if (shorts_results && typeof shorts_results === 'object') {
          results = [shorts_results];
        } else {
          logger.warn('No valid shorts_results provided', { correlationId, shorts_results });
        }
      } catch (parseError) {
        logger.error('Failed to parse shorts_results', { 
          correlationId,
          shorts_results, 
          error: parseError.message 
        });
        results = [];
      }
      
      if (!Array.isArray(results)) {
        results = [results];
      }
      
      const savedShorts = [];
      for (const [index, short] of results.entries()) {
        try {
          const savedShort = await db.createShort({
            processing_id: processing_id,
            short_id: short.short_id || `short_${processing_id}_${index + 1}`,
            title: short.title || `Video Short ${index + 1}`,
            file_url: short.file_url || null,
            thumbnail_url: short.thumbnail_url || null,
            duration: short.duration ? parseInt(short.duration) : null,
            quality: short.quality || '720p',
            file_size_bytes: short.file_size ? 
              parseInt(String(short.file_size).replace(/[^\d]/g, '')) : null,
            watermark: short.watermark || null
          });
          savedShorts.push(savedShort);
        } catch (shortError) {
          logger.error('Failed to save short', { 
            correlationId,
            shortId: short.short_id, 
            index,
            error: shortError.message 
          });
        }
      }
      
      const shortsCount = total_shorts || results.length || 0;
      const quality = results[0]?.quality || '720p';
      
      let message = `Your ${shortsCount} short${shortsCount !== 1 ? 's' : ''} ${shortsCount !== 1 ? 'are' : 'is'} ready!

Processing completed successfully
Quality: ${quality}
Platform: ${platform || 'Unknown'}
Processing time: Just completed

Download links:`;
      
      results.forEach((short, index) => {
        const shortTitle = short.title || `Video Short ${index + 1}`;
        message += `\n\nShort ${index + 1}: ${shortTitle}`;
        
        if (short.file_url && 
            !short.file_url.includes('demo.') && 
            !short.file_url.includes('placeholder')) {
          message += `\n${short.file_url}`;
        } else {
          message += `\n[File will be available shortly]`;
        }
        
        if (short.duration) {
          message += `\nDuration: ${short.duration}s`;
        }
        
        if (short.watermark) {
          message += `\nWatermark: ${short.watermark}`;
        }
      });
      
      if (subscription_type === 'free') {
        message += `\n\nUpgrade to Premium for:\n• HD Quality (1080p)\n• No Watermarks\n• More Shorts per Video\n• Priority Processing\n\nContact @Osezblessed to upgrade!`;
      } else if (subscription_type === 'premium') {
        message += `\n\nPremium features applied:\n• High Quality Processing\n• No Watermarks\n• Priority Queue`;
      } else if (subscription_type === 'pro') {
        message += `\n\nPro features applied:\n• Maximum Quality\n• Advanced Processing\n• Priority Support`;
      }
      
      try {
        await bot.sendMessage(chatIdNum, message);
        logger.info('Success message sent', { correlationId, chatId: chatIdNum, shortsCount });
      } catch (telegramError) {
        logger.error('Failed to send success message', { 
          correlationId,
          chatId: chatIdNum, 
          error: telegramError.message 
        });
      }
      
      await db.logUsage({
        telegram_id: telegramIdNum,
        processing_id: processing_id,
        action: 'video_processing_completed',
        success: true,
        processing_time: processing_completed_at ? 
          Math.floor((new Date(processing_completed_at) - new Date()) / 1000) : null,
        shorts_generated: results.length,
        platform: platform || 'Unknown'
      });
      
    } else if (status === 'error' || status === 'failed') {
      const errorMsg = error_message || 'Unknown error occurred during processing';
      
      const errorMessage = `Processing Failed

Error: ${errorMsg}

What you can do:
• Check if the video URL is accessible
• Try a shorter video (under 10 minutes)
• Wait a few minutes and try again
• Make sure the video is public

Still having issues? Contact @Osezblessed

Reference ID: ${processing_id}`;

      try {
        await bot.sendMessage(chatIdNum, errorMessage);
        logger.info('Error message sent', { correlationId, chatId: chatIdNum });
      } catch (telegramError) {
        logger.error('Failed to send error message', { 
          correlationId,
          chatId: chatIdNum, 
          error: telegramError.message 
        });
      }
      
      try {
        await userService.revertUsage(telegramIdNum);
        logger.info('Usage reverted for failed processing', { correlationId, telegramId: telegramIdNum });
      } catch (revertError) {
        logger.error('Failed to revert usage', { 
          correlationId,
          telegramId: telegramIdNum, 
          error: revertError.message 
        });
      }
      
      await db.logUsage({
        telegram_id: telegramIdNum,
        processing_id: processing_id,
        action: 'video_processing_failed',
        success: false,
        error_message: errorMsg,
        platform: platform || 'Unknown'
      });
    }
    
    res.json({ 
      status: 'success', 
      message: 'Callback processed successfully',
      processing_id,
      telegram_id: telegramIdNum,
      processed_status: status,
      correlationId
    });
    
  } catch (error) {
    logger.error('Critical error processing callback', { 
      correlationId,
      error: error.message, 
      stack: error.stack,
      body: req.body
    });
    
    await sendAdminAlert(`Critical callback processing error: ${error.message}`, error);
    
    res.status(500).json({ 
      error: 'Failed to process callback', 
      details: error.message,
      correlationId
    });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const correlationId = req.correlationId || `health_${Date.now()}`;
  
  try {
    const healthStatus = {
      timestamp: new Date().toISOString(),
      status: 'healthy',
      services: {},
      database: {},
      system: {
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        version: process.version,
        platform: process.platform
      },
      processing: {
        queue_status: processingQueue.getStatus()
      },
      correlationId
    };

    try {
      const dbStart = Date.now();
      const { data, error } = await Promise.race([
        supabase.from('users').select('count', { count: 'exact', head: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Database timeout')), 5000))
      ]);
      
      healthStatus.database.status = error ? 'error' : 'connected';
      healthStatus.database.response_time = Date.now() - dbStart;
      healthStatus.database.error = error?.message;
      
    } catch (dbError) {
      healthStatus.database.status = 'error';
      healthStatus.database.error = dbError.message;
    }

    try {
      const n8nStart = Date.now();
      const n8nResponse = await Promise.race([
        axios.get(`${process.env.N8N_URL || 'https://n8n-on-render-wf30.onrender.com'}/health`, { timeout: 5000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('n8n timeout')), 5000))
      ]);
      
      healthStatus.services.n8n = {
        status: 'connected',
        response_code: n8nResponse.status,
        response_time: Date.now() - n8nStart
      };
    } catch (n8nError) {
      healthStatus.services.n8n = {
        status: 'error',
        error: n8nError.message
      };
    }

    try {
      const botStart = Date.now();
      const botInfo = await bot.getMe();
      healthStatus.services.telegram = {
        status: 'connected',
        bot_username: botInfo.username,
        response_time: Date.now() - botStart
      };
    } catch (botError) {
      healthStatus.services.telegram = {
        status: 'error',
        error: botError.message
      };
    }

    const hasErrors = healthStatus.database.status === 'error' || 
                     healthStatus.services.n8n?.status === 'error' ||
                     healthStatus.services.telegram?.status === 'error';
    
    healthStatus.status = hasErrors ? 'degraded' : 'healthy';

    res.status(hasErrors ? 503 : 200).json(healthStatus);
  } catch (error) {
    logger.error('Health check error', { correlationId, error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString(),
      correlationId
    });
  }
});

// Dashboard endpoint
app.get('/dashboard', async (req, res) => {
  try {
    const stats = await db.getStats();
    const queueStatus = processingQueue.getStatus();
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>VideoShortsBot Dashboard</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stat { font-size: 2em; font-weight: bold; color: #007bff; margin-bottom: 10px; }
        .label { color: #666; font-size: 0.9em; }
        .status.healthy { color: #28a745; }
        .status.error { color: #dc3545; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>VideoShortsBot Dashboard</h1>
          <p>Last updated: ${new Date().toLocaleTimeString()}</p>
        </div>
        
        <div class="grid">
          <div class="card">
            <div class="stat">${stats.users.total}</div>
            <div class="label">Total Users</div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.videos.total}</div>
            <div class="label">Videos Processed</div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.videos.completed}</div>
            <div class="label">Successful</div>
          </div>
          
          <div class="card">
            <div class="stat">${queueStatus.totalActive}</div>
            <div class="label">Processing Queue</div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.users.premium + stats.users.pro}</div>
            <div class="label">Paid Users</div>
          </div>
          
          <div class="card">
            <div class="stat">${Math.floor(process.uptime() / 3600)}h</div>
            <div class="label">Uptime</div>
          </div>
        </div>
      </div>
      
      <script>
        setTimeout(() => window.location.reload(), 60000);
      </script>
    </body>
    </html>`;
    
    res.send(html);
  } catch (error) {
    res.status(500).send('Dashboard error: ' + error.message);
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'VideoShortsBot Business API',
    status: 'running',
    version: '2.0.0',
    endpoints: {
      dashboard: '/dashboard',
      health: '/health',
      webhook: '/webhook/n8n-callback'
    },
    correlationId: req.correlationId
  });
});

// Error handlers
app.use((req, res) => {
  logger.warn('Route not found', { 
    correlationId: req.correlationId,
    method: req.method, 
    path: req.path, 
    ip: req.ip 
  });
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.path,
    correlationId: req.correlationId
  });
});

app.use((error, req, res, next) => {
  logger.error('Unhandled error', { 
    correlationId: req.correlationId,
    error: error.message, 
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    correlationId: req.correlationId
  });
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown...');
  
  server.close(async () => {
    try {
      dailyResetJob.stop();
      await sendAdminAlert('Bot server shutting down gracefully');
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.kill(process.pid, 'SIGTERM');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  sendAdminAlert('Uncaught exception in bot server', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
  sendAdminAlert('Unhandled promise rejection in bot server', new Error(reason));
});

// Start server
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  logger.info('VideoShortsBot server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    dashboard_url: `https://video-shorts-business-bot.onrender.com/dashboard`,
    database: 'Supabase',
    node_version: process.version
  });
});

module.exports = { app, bot, server, userService, processingQueue };