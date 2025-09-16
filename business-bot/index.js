const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const FormData = require('form-data');
const cron = require('cron');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');
const validator = require('./utils/validator');
const rateLimiter = require('./middleware/rateLimiter').middleware;

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const PORT = process.env.PORT || 10000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(rateLimiter);

// Multer for file uploads
const upload = multer({
  dest: './temp/',
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, AVI, and WebM are allowed.'));
    }
  }
});

// Request logging
app.use((req, res, next) => {
  req.correlationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  logger.info(`${req.method} ${req.path}`, { correlationId: req.correlationId, ip: req.ip });
  next();
});

// Video processing queue
class VideoProcessingQueue {
  constructor() {
    this.userProcessing = new Map();
    this.processing = new Map();
    this.maxPerUser = { free: 1, premium: 3, pro: 5 };
    this.globalProcessing = { free: 0, premium: 0, pro: 0 };
    this.maxGlobal = { free: 10, premium: 20, pro: 50 };
  }

  canProcess(telegramId, subscriptionType) {
    const userCount = this.userProcessing.get(telegramId) || 0;
    if (userCount >= this.maxPerUser[subscriptionType]) {
      logger.warn('User processing limit reached', { telegramId, userCount });
      return false;
    }
    if (this.globalProcessing[subscriptionType] >= this.maxGlobal[subscriptionType]) {
      logger.warn('Global processing limit reached', { subscriptionType });
      return false;
    }
    return true;
  }

  startProcessing(processingId, telegramId, subscriptionType) {
    const userCount = this.userProcessing.get(telegramId) || 0;
    this.userProcessing.set(telegramId, userCount + 1);
    this.globalProcessing[subscriptionType]++;
    this.processing.set(processingId, { telegramId, subscriptionType, startTime: Date.now() });
    logger.info('Processing started', { processingId, telegramId, subscriptionType });
  }

  finishProcessing(processingId) {
    const processInfo = this.processing.get(processingId);
    if (processInfo) {
      const { telegramId, subscriptionType } = processInfo;
      const userCount = this.userProcessing.get(telegramId) || 0;
      if (userCount > 0) {
        this.userProcessing.set(telegramId, userCount - 1);
        if (userCount - 1 === 0) this.userProcessing.delete(telegramId);
      }
      this.globalProcessing[subscriptionType]--;
      this.processing.delete(processingId);
      logger.info('Processing finished', { processingId, telegramId });
    }
  }

  cleanupStaleProcessing() {
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    const staleEntries = [];
    for (const [processingId, processInfo] of this.processing.entries()) {
      if (processInfo.startTime < thirtyMinutesAgo) {
        staleEntries.push(processingId);
        this.finishProcessing(processingId);
      }
    }
    return staleEntries.length;
  }
}

const processingQueue = new VideoProcessingQueue();
setInterval(() => {
  const cleaned = processingQueue.cleanupStaleProcessing();
  if (cleaned > 0) logger.info(`Cleaned up ${cleaned} stale processing entries`);
}, 5 * 60 * 1000);

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

    let user = await getUser(telegramId);
    if (!user) {
      user = await createUser({ telegram_id: telegramId, username: userInfo.username, first_name: userInfo.first_name });
      logger.info('New user created', { telegramId });
    }
    this.cache.set(cacheKey, { user, timestamp: Date.now() });
    return user;
  }

  async canProcessVideo(telegramId) {
    const user = await getUser(telegramId);
    if (!user) return false;
    if (['premium', 'pro'].includes(user.subscription_type)) return true;
    return user.daily_usage < 3;
  }

  async updateUsage(telegramId) {
    this.cache.delete(`user_${telegramId}`);
    return await incrementUsage(telegramId);
  }

  async revertUsage(telegramId) {
    this.cache.delete(`user_${telegramId}`);
    return await decrementUsage(telegramId);
  }
}

const userService = new UserService();

// Database helpers
async function getUser(telegramId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  if (error) {
    logger.error('Error getting user', { telegramId, error: error.message });
    return null;
  }
  return data;
}

async function createUser(userData) {
  const { telegram_id, username, first_name } = userData;
  const { data, error } = await supabase
    .from('users')
    .upsert({
      telegram_id,
      username,
      first_name,
      referral_code: `REF${telegram_id}`,
      subscription_type: 'free',
      daily_usage: 0,
      total_usage: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function incrementUsage(telegramId) {
  const user = await getUser(telegramId);
  if (!user) throw new Error('User not found');
  const { data, error } = await supabase
    .from('users')
    .update({
      daily_usage: user.daily_usage + 1,
      total_usage: user.total_usage + 1,
      updated_at: new Date().toISOString()
    })
    .eq('telegram_id', telegramId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function decrementUsage(telegramId) {
  const user = await getUser(telegramId);
  if (!user) throw new Error('User not found');
  const { data, error } = await supabase
    .from('users')
    .update({
      daily_usage: Math.max(user.daily_usage - 1, 0),
      total_usage: Math.max(user.total_usage - 1, 0),
      updated_at: new Date().toISOString()
    })
    .eq('telegram_id', telegramId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function resetDailyUsage() {
  const { data, error } = await supabase
    .from('users')
    .update({ daily_usage: 0, updated_at: new Date().toISOString() })
    .neq('daily_usage', 0)
    .select();
  if (error) throw error;
  logger.info(`Reset daily usage for ${data?.length || 0} users`);
}

// Daily usage reset
const dailyResetJob = new cron.CronJob('0 0 * * *', async () => {
  logger.info('Starting daily usage reset...');
  try {
    await resetDailyUsage();
    logger.info('Daily usage reset completed');
  } catch (error) {
    logger.error('Daily reset failed', { error: error.message });
    await sendAdminAlert('Daily usage reset failed', error);
  }
}, null, true, 'UTC');

// Admin alert
async function sendAdminAlert(message, error = null) {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (adminChatId) {
    const alertMessage = `🚨 ADMIN ALERT\n\n${message}\n\nTime: ${new Date().toISOString()}${error ? `\n\nError: ${error.message}` : ''}`;
    await bot.sendMessage(adminChatId, alertMessage);
  }
}

// Telegram bot handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  await userService.initUser(telegramId, msg.from);
  await bot.sendMessage(chatId, 'Welcome! Send a video file (MP4, MOV, AVI, or WebM, up to 200MB) to create short clips.');
});

bot.on('video', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const fileId = msg.video.file_id;
  const processingId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    // Check user eligibility
    const user = await userService.initUser(telegramId, msg.from);
    if (!await userService.canProcessVideo(telegramId)) {
      await bot.sendMessage(chatId, 'You have reached your daily processing limit (3 videos for free users). Try again tomorrow or upgrade to premium.');
      return;
    }

    if (!processingQueue.canProcess(telegramId, user.subscription_type)) {
      await bot.sendMessage(chatId, 'Processing queue is full. Please try again later.');
      return;
    }

    // Get file
    const file = await bot.getFile(fileId);
    if (file.file_size > 200 * 1024 * 1024) {
      await bot.sendMessage(chatId, 'Video file is too large. Maximum size is 200MB.');
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const tempPath = `./temp/${processingId}_${path.basename(file.file_path)}`;
    await fs.mkdir('./temp', { recursive: true });
    
    // Download video
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    await fs.writeFile(tempPath, response.data);

    // Validate file
    const validation = validator.validateFileUpload({
      originalname: path.basename(file.file_path),
      size: file.file_size,
      mimetype: msg.video.mime_type,
      path: tempPath
    });
    if (!validation.valid) {
      await fs.unlink(tempPath).catch(() => {});
      await bot.sendMessage(chatId, `Invalid file: ${validation.errors.join(', ')}`);
      return;
    }

    // Start processing
    processingQueue.startProcessing(processingId, telegramId, user.subscription_type);
    await userService.updateUsage(telegramId);

    // Send to video processor
    const formData = new FormData();
    formData.append('video', fs.createReadStream(tempPath));
    formData.append('processing_id', processingId);
    formData.append('telegram_id', telegramId);
    formData.append('chat_id', chatId);
    formData.append('subscription_type', user.subscription_type);
    formData.append('callback_url', `${process.env.RENDER_EXTERNAL_URL}/webhook/n8n-callback`);

    const processorResponse = await axios.post(
      'https://video-processing-service.onrender.com/upload-and-process',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${process.env.N8N_WEBHOOK_SECRET}`
        },
        timeout: 30000
      }
    );

    await bot.sendMessage(chatId, `Video accepted for processing (ID: ${processingId}). You'll be notified when it's done.`);
    await fs.unlink(tempPath).catch(() => {});
  } catch (error) {
    logger.error('Video processing error', { telegramId, processingId, error: error.message });
    await userService.revertUsage(telegramId);
    processingQueue.finishProcessing(processingId);
    await bot.sendMessage(chatId, `Error processing video: ${error.message}`);
    await fs.unlink(tempPath).catch(() => {});
  }
});

// Webhook callback
app.post('/webhook/n8n-callback', async (req, res) => {
  const { processing_id, telegram_id, chat_id, status, shorts_results, thumbnail_url, error } = req.body;
  
  try {
    if (status === 'completed') {
      const message = `Video processing completed (ID: ${processing_id}). Generated ${shorts_results.length} shorts.\nThumbnail: ${thumbnail_url}`;
      await bot.sendMessage(chat_id, message);
      for (const short of shorts_results) {
        await bot.sendVideo(chat_id, short.url, { caption: `Short ${short.index}` });
      }
      await bot.sendPhoto(chat_id, thumbnail_url, { caption: 'Video thumbnail' });
    } else if (status === 'error') {
      await userService.revertUsage(telegram_id);
      await bot.sendMessage(chat_id, `Processing failed (ID: ${processing_id}): ${error.message}`);
    }
    processingQueue.finishProcessing(processing_id);
    res.status(200).json({ status: 'received' });
  } catch (error) {
    logger.error('Webhook callback error', { processing_id, error: error.message });
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Business bot running on port ${PORT}`);
});
dailyResetJob.start();