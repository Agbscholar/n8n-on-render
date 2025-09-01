const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const FormData = require('form-data');
const mime = require('mime-types');
const cron = require('cron');

// Import utilities
const db = require('./utils/supabase');
const logger = require('./utils/logger');
const rateLimiter = require('./middleware/rateLimiter');
const validator = require('./utils/validator');

// Initialize Express app and Telegram bot
const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
  request: {
    timeout: 30000,
    retries: 3
  }
});

// Middleware setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
setInterval(() => keepAlive.pingAll(), 14 * 60 * 1000);
setTimeout(() => keepAlive.pingAll(), 5000);

// Processing queue
class VideoProcessingQueue {
  constructor() {
    this.userProcessing = new Map();
    this.processing = new Map();
    this.maxPerUser = { free: 1, premium: 3, pro: 5 };
    this.maxGlobal = { free: 10, premium: 20, pro: 50 };
    this.globalProcessing = { free: 0, premium: 0, pro: 0 };
  }

  canProcess(telegramId, subscriptionType) {
    const userCount = this.userProcessing.get(telegramId) || 0;
    if (userCount >= this.maxPerUser[subscriptionType]) {
      return false;
    }

    if (this.globalProcessing[subscriptionType] >= this.maxGlobal[subscriptionType]) {
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
    
    logger.info('Processing started', { processingId, telegramId, subscriptionType });
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
      
      logger.info('Processing finished', { processingId, telegramId, subscriptionType });
    }
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
}

const processingQueue = new VideoProcessingQueue();

// User service
class UserService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000;
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
      const alertMessage = `Admin Alert: ${message}\n\nTime: ${new Date().toISOString()}${error ? `\n\nError: ${error.message}` : ''}`;
      await bot.sendMessage(adminChatId, alertMessage);
    }
    logger.error('Admin alert sent', { message, error: error?.message });
  } catch (alertError) {
    logger.error('Failed to send admin alert', { error: alertError.message });
  }
}

// Fixed rate limiting wrapper function
async function checkRateLimit(msg) {
  return await rateLimiter.checkTelegramRateLimit(msg, bot, async (telegramId) => {
    return await db.getUser(telegramId);
  });
}

// Bot commands with fixed rate limiting
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const canProceed = await checkRateLimit(msg);
  if (!canProceed) return;
  
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  try {
    const user = await userService.initUser(telegramId, msg.from);
    
    const subscriptionStatus = user.subscription_expires_at && new Date() < new Date(user.subscription_expires_at) 
      ? `Active until ${new Date(user.subscription_expires_at).toLocaleDateString()}` 
      : 'Free Plan';
    
    const welcomeMessage = `Welcome to VideoShortsBot!

Transform long videos into viral shorts instantly!

YOUR PLAN: ${user.subscription_type.toUpperCase()}
Status: ${subscriptionStatus}

Total Processed: ${user.videos_processed} videos
Shorts Generated: ${user.shorts_generated}

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

Ready? Send me any video URL!

Commands:
/upgrade - View premium plans
/stats - Your statistics  
/help - Need assistance?`;
    
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

bot.onText(/\/stats/, async (msg) => {
  const canProceed = await checkRateLimit(msg);
  if (!canProceed) return;
  
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  
  try {
    const user = await db.getUser(telegramId);
    
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the bot first with /start');
    }
    
    const subscriptionStatus = user.subscription_expires_at && new Date() < new Date(user.subscription_expires_at)
      ? `Active until ${new Date(user.subscription_expires_at).toLocaleDateString()}`
      : user.subscription_type === 'free' ? 'Free Plan' : 'Expired';
    
    // Get today's video count
    const today = new Date().toISOString().split('T')[0];
    const { data: todayVideos } = await db.supabase
      .from('video_processing')
      .select('id')
      .eq('telegram_id', telegramId)
      .gte('created_at', `${today}T00:00:00Z`);
    
    const dailyUsage = todayVideos?.length || 0;
    
    const statsMessage = `YOUR STATISTICS

Account: ${user.first_name}
Plan: ${user.subscription_type.toUpperCase()}
Status: ${subscriptionStatus}

Usage Today: ${dailyUsage}/${user.subscription_type === 'free' ? '3' : 'unlimited'}
Total Processed: ${user.videos_processed} videos
Shorts Generated: ${user.shorts_generated}
Member Since: ${new Date(user.created_at).toLocaleDateString()}

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

bot.onText(/\/upgrade/, async (msg) => {
  const canProceed = await checkRateLimit(msg);
  if (!canProceed) return;
  
  const upgradeMessage = `UPGRADE YOUR EXPERIENCE

NIGERIAN PRICING:

PREMIUM - ₦1,200/month (~$2.99):
• Unlimited videos
• Custom lengths (15s-90s)
• All platforms + Instagram
• Priority processing
• No watermarks

PRO - ₦4,000/month (~$9.99):
• Everything in Premium
• API access
• White-label rights
• Custom branding
• Reseller dashboard

Payment Methods:
• Bank Transfer • Debit Cards
• USSD • Mobile Money

Contact @Osezblessed to upgrade!`;
  
  await bot.sendMessage(msg.chat.id, upgradeMessage);
});

// Video URL processing with fixed database calls
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
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
      
      // Check platform restrictions
      if (user.subscription_type === 'free') {
        const platform = detectPlatform(videoUrl);
        if (['Instagram', 'Twitter'].includes(platform)) {
          return bot.sendMessage(chatId, `${platform} processing requires Premium subscription. Contact @Osezblessed to upgrade!`);
        }
      }

      if (!processingQueue.canProcess(telegramId, user.subscription_type)) {
        return bot.sendMessage(chatId, 'Processing queue is full. Please try again in a few minutes.');
      }
      
      processingId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      processingQueue.startProcessing(processingId, telegramId, user.subscription_type);
      
      const processingMessages = {
        free: 'Processing your video... This may take 2-5 minutes.',
        premium: 'Premium processing started... 1-2 minutes remaining.',
        pro: 'Pro processing initiated... 30-60 seconds remaining.'
      };
      
      await bot.sendMessage(chatId, processingMessages[user.subscription_type]);
      
      // Get user UUID for foreign key constraint
      const userRecord = await db.getUser(telegramId);
      
      const videoRecord = await db.createVideo({
        processing_id: processingId,
        user_id: userRecord.id, // Use UUID from users table
        telegram_id: telegramId,
        video_url: videoUrl,
        platform: detectPlatform(videoUrl),
        subscription_type: user.subscription_type
      });
      
      await userService.updateUsage(telegramId);
      
      // Trigger n8n workflow
      const n8nPayload = {
        telegram_id: telegramId,
        chat_id: chatId,
        video_url: videoUrl,
        user_name: user.first_name,
        subscription_type: user.subscription_type,
        webhook_secret: process.env.N8N_WEBHOOK_SECRET,
        business_bot_url: process.env.RENDER_EXTERNAL_URL,
        processing_id: processingId,
        user_limits: {
          max_shorts: user.subscription_type === 'free' ? 2 : user.subscription_type === 'premium' ? 4 : 6,
          max_duration: user.subscription_type === 'free' ? 60 : 90,
          priority: user.subscription_type === 'free' ? 'low' : user.subscription_type === 'premium' ? 'medium' : 'high'
        }
      };

      const response = await axios.post(
        'https://n8n-on-render-wf30.onrender.com/webhook/video-processing',
        n8nPayload,
        {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        }
      );
      
      logger.info('n8n workflow triggered successfully', { 
        processingId, 
        telegramId, 
        response: response.data 
      });
      
      await db.logUsage({
        telegram_id: telegramId,
        video_id: videoRecord.id,
        processing_id: processingId,
        action: 'video_processing_started',
        platform: detectPlatform(videoUrl),
        success: true
      });
      
    } catch (error) {
      logger.error('Video processing error', { telegramId, videoUrl, error: error.message });
      
      await bot.sendMessage(chatId, `Processing failed: ${error.message}

Please try again in a few minutes.
If the issue persists, contact @Osezblessed`);
      
      await userService.revertUsage(telegramId);
      
      if (processingId) {
        processingQueue.finishProcessing(processingId);
      }
      
      await db.logUsage({
        telegram_id: telegramId,
        processing_id: processingId || null,
        action: 'video_processing_failed',
        success: false,
        error_message: error.message
      });
    }
  }
});

// Multer configuration
const upload = multer({
  dest: './temp/',
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mov|avi|webm|jpg|jpeg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video and image files are allowed.'));
    }
  }
});

// Fixed upload endpoints
app.post('/upload-processed-video', upload.single('video'), async (req, res) => {
  try {
    const { processing_id, short_id } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }
    
    if (!processing_id || !short_id) {
      return res.status(400).json({ error: 'Missing processing_id or short_id' });
    }
    
    const fileBuffer = await fs.readFile(file.path);
    const contentType = mime.lookup(file.originalname) || 'video/mp4';
    
    const fileName = `${short_id}_${Date.now()}.mp4`;
    const storagePath = `videos/${processing_id}/${fileName}`;
    
    const uploadResult = await db.uploadFile('video-files', storagePath, fileBuffer, contentType);
    
    await fs.unlink(file.path);
    
    await db.updateVideo(processing_id, {
      file_path: storagePath,
      file_url: uploadResult.publicUrl,
      file_size: file.size,
      status: 'completed'
    });
    
    res.json({
      success: true,
      file_url: uploadResult.publicUrl,
      file_size: file.size,
      file_path: storagePath
    });
    
  } catch (error) {
    logger.error('Video upload error', { error: error.message });
    
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(console.error);
    }
    
    res.status(500).json({ 
      error: 'Video upload failed', 
      details: error.message 
    });
  }
});

// Fixed webhook callback
app.post('/webhook/n8n-callback', async (req, res) => {
  try {
    const {
      processing_id,
      telegram_id,
      chat_id,
      status,
      shorts_results,
      total_shorts,
      subscription_type,
      platform
    } = req.body;
    
    if (!processing_id || !telegram_id || !chat_id) {
      return res.status(400).json({ 
        error: 'Missing required fields: processing_id, telegram_id, chat_id'
      });
    }
    
    const telegramIdNum = parseInt(String(telegram_id).trim());
    const chatIdNum = parseInt(String(chat_id).trim());
    
    processingQueue.finishProcessing(processing_id);
    
    await db.updateVideo(processing_id, {
      status: status === 'completed' ? 'completed' : 'failed',
      completed_at: status === 'completed' ? new Date().toISOString() : null,
      error_message: status === 'failed' ? req.body.error_message : null
    });
    
    if (status === 'completed') {
      let results = [];
      if (typeof shorts_results === 'string') {
        results = JSON.parse(shorts_results);
      } else if (Array.isArray(shorts_results)) {
        results = shorts_results;
      }
      
      // Get video record for foreign key
      const videoRecord = await db.getVideo(processing_id);
      const userRecord = await db.getUser(telegramIdNum);
      
      // Save shorts to database
      for (const [index, short] of results.entries()) {
        try {
          await db.createShort({
            short_id: short.short_id || `short_${processing_id}_${index + 1}`,
            video_id: videoRecord.id,
            user_id: userRecord.id,
            title: short.title || `Video Short ${index + 1}`,
            file_url: short.file_url,
            thumbnail_url: short.thumbnail_url,
            duration: short.duration ? parseInt(short.duration) : null,
            quality: short.quality || '720p',
            file_size: short.file_size,
            features_applied: short.features_applied || []
          });
        } catch (shortError) {
          logger.error('Failed to save short', { shortError: shortError.message });
        }
      }
      
      let message = `Your ${results.length} short${results.length !== 1 ? 's are' : ' is'} ready!

Processing completed successfully
Quality: ${results[0]?.quality || '720p'}
Platform: ${platform || 'Unknown'}

Download links:`;
      
      results.forEach((short, index) => {
        message += `\n\nShort ${index + 1}: ${short.title || `Video Short ${index + 1}`}`;
        if (short.file_url) {
          message += `\n${short.file_url}`;
        }
      });
      
      await bot.sendMessage(chatIdNum, message);
      
    } else {
      const errorMsg = `Processing Failed

Error: ${req.body.error_message || 'Unknown error occurred'}

What you can do:
• Check if the video URL is accessible
• Try a shorter video (under 10 minutes)
• Wait a few minutes and try again

Contact @Osezblessed for support`;

      await bot.sendMessage(chatIdNum, errorMsg);
      await userService.revertUsage(telegramIdNum);
    }
    
    res.json({ status: 'success', processing_id });
    
  } catch (error) {
    logger.error('Callback error', { error: error.message });
    res.status(500).json({ error: 'Failed to process callback' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const healthStatus = {
      timestamp: new Date().toISOString(),
      status: 'healthy',
      database: { status: 'unknown' },
      system: {
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        version: process.version
      }
    };

    // Test database
    try {
      await db.testConnection();
      healthStatus.database.status = 'connected';
    } catch (dbError) {
      healthStatus.database.status = 'error';
      healthStatus.database.error = dbError.message;
    }

    res.json(healthStatus);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Basic routes
app.get('/metrics', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'VideoShortsBot Business API',
    status: 'running',
    version: '2.0.0'
  });
});

// Error handling
app.use((error, req, res, next) => {
  logger.error('Unhandled error', { 
    error: error.message, 
    path: req.path
  });

  res.status(500).json({
    error: 'Internal server error',
    correlation_id: req.correlationId
  });
});

// Start server
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  logger.info('VideoShortsBot server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = { app, bot, server, userService, processingQueue };