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

// Enhanced middleware setup
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Enhanced request logging with correlation IDs
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

// Enhanced keep-alive with circuit breaker pattern
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
      
      logger.info(`✅ ${service.name} is alive: ${response.status}`);
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
setTimeout(() => keepAlive.pingAll(), 5000); // Initial ping after 5 seconds

// Enhanced daily usage reset with retry mechanism
const dailyResetJob = new cron.CronJob('0 0 * * *', async () => {
  logger.info('Starting daily usage reset...');
  let retries = 3;
  
  while (retries > 0) {
    try {
      await resetDailyUsage();
      logger.info('Daily usage reset completed successfully');
      break;
    } catch (error) {
      retries--;
      logger.error(`Daily reset failed (${3 - retries}/3)`, { error: error.message });
      
      if (retries === 0) {
        // Send alert to admin
        await sendAdminAlert('Daily usage reset failed after 3 attempts', error);
      } else {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
      }
    }
  }
}, null, true, 'UTC');

// Enhanced multer configuration with better error handling
const upload = multer({
  dest: './temp/',
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
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

// Enhanced helper functions with caching
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
      let user = await getUser(telegramId);
      if (!user) {
        user = await createUser({
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
      return await canUseService(telegramId);
    } catch (error) {
      logger.error('Failed to check video processing eligibility', { telegramId, error: error.message });
      return false;
    }
  }

  async updateUsage(telegramId) {
    this.clearCache(telegramId);
    return await incrementUsage(telegramId);
  }

  async revertUsage(telegramId) {
    this.clearCache(telegramId);
    return await decrementUsage(telegramId);
  }
}

const userService = new UserService();

// Enhanced platform detection with validation
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

// Enhanced admin alert system
async function sendAdminAlert(message, error = null) {
  try {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (adminChatId) {
      const alertMessage = `🚨 ADMIN ALERT\n\n${message}\n\nTime: ${new Date().toISOString()}${error ? `\n\nError: ${error.message}` : ''}`;
      await bot.sendMessage(adminChatId, alertMessage);
    }
    logger.error('Admin alert sent', { message, error: error?.message });
  } catch (alertError) {
    logger.error('Failed to send admin alert', { error: alertError.message });
  }
}

// FIXED: Enhanced video processing queue with per-user limits
class VideoProcessingQueue {
  constructor() {
    this.userProcessing = new Map(); // Track per-user processing count
    this.processing = new Map(); // Track processing ID to user mapping
    this.maxPerUser = {
      free: 1,     // 1 concurrent video per free user
      premium: 3,  // 3 concurrent videos per premium user
      pro: 5       // 5 concurrent videos per pro user
    };
    this.maxGlobal = {
      free: 10,    // Global limit for free users
      premium: 20, // Global limit for premium users
      pro: 50      // Global limit for pro users
    };
    this.globalProcessing = {
      free: 0,
      premium: 0,
      pro: 0
    };
  }

  canProcess(telegramId, subscriptionType) {
    // Check per-user limit
    const userCount = this.userProcessing.get(telegramId) || 0;
    if (userCount >= this.maxPerUser[subscriptionType]) {
      logger.warn('User processing limit reached', { telegramId, userCount, limit: this.maxPerUser[subscriptionType] });
      return false;
    }

    // Check global limit for subscription type
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
    // Increment user count
    const userCount = this.userProcessing.get(telegramId) || 0;
    this.userProcessing.set(telegramId, userCount + 1);
    
    // Increment global count
    this.globalProcessing[subscriptionType]++;
    
    // Store processing info
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
      
      // Decrement user count
      const userCount = this.userProcessing.get(telegramId) || 0;
      if (userCount > 0) {
        this.userProcessing.set(telegramId, userCount - 1);
        if (userCount - 1 === 0) {
          this.userProcessing.delete(telegramId);
        }
      }
      
      // Decrement global count
      if (this.globalProcessing[subscriptionType] > 0) {
        this.globalProcessing[subscriptionType]--;
      }
      
      // Remove processing info
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
    } else {
      logger.warn('Attempted to finish unknown processing', { processingId });
    }
  }

  // Clean up stale processing entries (older than 30 minutes)
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

// Database helper functions
async function getUser(telegramId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error getting user', { telegramId, error: error.message });
    return null;
  }
}

async function createUser(userData) {
  try {
    const { telegram_id, username, first_name } = userData;
    const referralCode = `REF${telegram_id}`;
    
    const { data, error } = await supabase
      .from('users')
      .upsert({
        telegram_id,
        username,
        first_name,
        referral_code: referralCode,
        subscription_type: 'free',
        daily_usage: 0,
        total_usage: 0,
        referred_users: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error creating user', { error: error.message });
    throw error;
  }
}

async function canUseService(telegramId) {
  try {
    const user = await getUser(telegramId);
    if (!user) return false;
    
    // Premium/Pro users have unlimited access if subscription is valid
    if (user.subscription_type === 'premium' || user.subscription_type === 'pro') {
      if (user.subscription_expires && new Date() < new Date(user.subscription_expires)) {
        return true;
      } else if (user.subscription_expires && new Date() >= new Date(user.subscription_expires)) {
        // Subscription expired, downgrade to free
        await updateUser(telegramId, {
          subscription_type: 'free',
          subscription_expires: null
        });
      }
    }
    
    // Free users have daily limits
    return user.daily_usage < 3;
  } catch (error) {
    logger.error('Error checking service usage', { telegramId, error: error.message });
    return false;
  }
}

async function incrementUsage(telegramId) {
  try {
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
  } catch (error) {
    logger.error('Error incrementing usage', { telegramId, error: error.message });
    throw error;
  }
}

async function decrementUsage(telegramId) {
  try {
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
  } catch (error) {
    logger.error('Error decrementing usage', { telegramId, error: error.message });
    throw error;
  }
}

async function resetDailyUsage() {
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ 
        daily_usage: 0, 
        updated_at: new Date().toISOString() 
      })
      .neq('daily_usage', 0)
      .select();

    if (error) throw error;
    logger.info(`Reset daily usage for ${data?.length || 0} users`);
    return data;
  } catch (error) {
    logger.error('Error resetting daily usage', { error: error.message });
    throw error;
  }
}

async function updateUser(telegramId, updates) {
  try {
    const { data, error } = await supabase
      .from('users')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('telegram_id', telegramId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error updating user', { telegramId, error: error.message });
    throw error;
  }
}

async function createVideo(videoData) {
  try {
    const { data, error } = await supabase
      .from('video_processing')
      .insert({
        processing_id: videoData.processing_id,
        telegram_id: videoData.telegram_id,
        original_url: videoData.video_url,
        platform: videoData.platform,
        status: 'processing',
        subscription_type: videoData.subscription_type || 'free',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error creating video record', { error: error.message });
    throw error;
  }
}

async function updateVideo(processingId, updates) {
  try {
    const { data, error } = await supabase
      .from('video_processing')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('processing_id', processingId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error updating video', { processingId, error: error.message });
    throw error;
  }
}

async function getVideo(processingId) {
  try {
    const { data, error } = await supabase
      .from('video_processing')
      .select('*, short_videos(*)')
      .eq('processing_id', processingId)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error getting video', { processingId, error: error.message });
    return null;
  }
}

async function logUsage(logData) {
  try {
    const { data, error } = await supabase
      .from('usage_logs')
      .insert({
        telegram_id: logData.telegram_id,
        video_id: logData.video_id || null,
        processing_id: logData.processing_id || null,
        action: logData.action,
        platform: logData.platform || null,
        processing_time: logData.processing_time || null,
        success: logData.success !== false,
        error_message: logData.error_message || null,
        shorts_generated: logData.shorts_generated || 0,
        total_shorts: logData.total_shorts || 0,
        file_size_bytes: logData.file_size_bytes || null,
        created_at: new Date().toISOString()
      });

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error logging usage', { error: error.message });
    return null;
  }
}

async function uploadFile(bucket, filePath, fileBuffer, contentType) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, fileBuffer, {
        contentType,
        upsert: true,
        cacheControl: '3600'
      });

    if (error) throw error;
    
    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from(bucket)
      .getPublicUrl(filePath);

    return {
      path: data.path,
      fullPath: data.fullPath,
      publicUrl
    };
  } catch (error) {
    logger.error('Error uploading file', { bucket, error: error.message });
    throw error;
  }
}

async function deleteFile(bucket, filePath) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .remove([filePath]);

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error deleting file', { bucket, filePath, error: error.message });
    throw error;
  }
}

async function createShort(shortData) {
  try {
    const { data, error } = await supabase
      .from('short_videos')
      .insert({
        ...shortData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error creating short', { error: error.message });
    throw error;
  }
}

async function updateShort(shortId, updates) {
  try {
    const { data, error } = await supabase
      .from('short_videos')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('short_id', shortId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Error updating short', { shortId, error: error.message });
    throw error;
  }
}

async function getStats() {
  try {
    // Get user counts by subscription type
    const { data: userStats, error: userError } = await supabase
      .from('users')
      .select('subscription_type');

    if (userError) throw userError;

    // Get total videos processed
    const { data: videoStats, error: videoError } = await supabase
      .from('video_processing')
      .select('status');

    if (videoError) throw videoError;

    // Get storage usage
    const storageUsage = await getStorageUsage();

    const stats = {
      users: {
        total: userStats.length,
        free: userStats.filter(u => u.subscription_type === 'free').length,
        premium: userStats.filter(u => u.subscription_type === 'premium').length,
        pro: userStats.filter(u => u.subscription_type === 'pro').length
      },
      videos: {
        total: videoStats.length,
        completed: videoStats.filter(v => v.status === 'completed').length,
        processing: videoStats.filter(v => v.status === 'processing').length,
        failed: videoStats.filter(v => v.status === 'failed').length
      },
      storage: storageUsage
    };

    return stats;
  } catch (error) {
    logger.error('Error getting stats', { error: error.message });
    throw error;
  }
}

async function getStorageUsage() {
  try {
    const buckets = ['video-files', 'processed-shorts', 'thumbnails'];
    let totalSize = 0;
    let fileCount = 0;
    
    for (const bucket of buckets) {
      try {
        const { data, error } = await supabase.storage
          .from(bucket)
          .list();
        
        if (!error && data) {
          fileCount += data.length;
          // Calculate size (this is approximate as we'd need to get each file's metadata)
          totalSize += data.length * 5 * 1024 * 1024; // Estimate 5MB per file
        }
      } catch (bucketError) {
        logger.error(`Error listing bucket ${bucket}:`, bucketError);
      }
    }
    
    return {
      total_size_bytes: totalSize,
      total_size_mb: (totalSize / 1024 / 1024).toFixed(2),
      total_size_gb: (totalSize / 1024 / 1024 / 1024).toFixed(2),
      file_count: fileCount
    };
  } catch (error) {
    logger.error('Error getting storage usage', { error: error.message });
    return {
      total_size_bytes: 0,
      total_size_mb: 0,
      total_size_gb: 0,
      file_count: 0
    };
  }
}

async function cleanupOldFiles(daysOld = 7, dryRun = true) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const { data: oldVideos, error } = await supabase
      .from('video_processing')
      .select('file_path, thumbnail_path, storage_bucket')
      .lt('created_at', cutoffDate.toISOString())
      .eq('status', 'completed');

    if (error) throw error;

    let deletedCount = 0;
    
    // Delete files from storage if not dry run
    if (!dryRun) {
      for (const video of oldVideos) {
        if (video.file_path && video.storage_bucket) {
          await deleteFile(video.storage_bucket, video.file_path).catch(console.error);
          deletedCount++;
        }
        if (video.thumbnail_path) {
          await deleteFile('thumbnails', video.thumbnail_path).catch(console.error);
          deletedCount++;
        }
      }
    }

    logger.info(`Would clean up ${oldVideos.length} old video files (dry run: ${dryRun})`);
    return {
      dry_run: dryRun,
      files_found: oldVideos.length,
      files_deleted: dryRun ? 0 : deletedCount
    };
  } catch (error) {
    logger.error('Error cleaning up old files:', error);
    throw error;
  }
}

// Enhanced bot commands with better error handling and rate limiting
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  // Apply rate limiting
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  try {
    const user = await userService.initUser(telegramId, msg.from);
    const referralCode = match && match[1] ? match[1] : null;
    
    // Enhanced referral handling
    if (referralCode && referralCode.startsWith('REF') && referralCode !== user.referral_code) {
      const referrerId = referralCode.replace('REF', '');
      if (referrerId !== telegramId.toString()) {
        try {
          // Process referral logic here
          logger.info('Referral processed', { referrerId, newUserId: telegramId });
        } catch (err) {
          logger.warn('Referral processing failed', { referrerId, error: err.message });
        }
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
    
    await bot.sendMessage(chatId, welcomeMessage);
    
    await logUsage({
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
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  
  try {
    const user = await getUser(telegramId);
    
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the bot first with /start');
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
    
    await bot.sendMessage(chatId, statsMessage);
    
  } catch (error) {
    logger.error('Stats command error', { telegramId, error: error.message });
    await bot.sendMessage(chatId, 'Unable to fetch your statistics right now. Please try again later.');
  }
});

bot.onText(/\/upgrade/, async (msg) => {
  const canProceed = await rateLimiter(msg);
  if (!canProceed) return;
  
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

Contact @Osezblessed to upgrade!`;
  
  const keyboard = {
    inline_keyboard: [
      [{text: '💎 Upgrade to Premium', url: 'https://t.me/Osezblessed'}],
      [{text: '🚀 Upgrade to Pro', url: 'https://t.me/Osezblessed'}],
      [{text: '🤝 Referral Program', callback_data: 'referral_info'}]
    ]
  };
  
  bot.sendMessage(msg.chat.id, upgradeMessage, {reply_markup: keyboard});
});

// Enhanced video URL processing with proper queue management
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
      // Input validation
      if (!validator.isValidUrl(videoUrl)) {
        return bot.sendMessage(chatId, '❌ Invalid URL format. Please send a valid video URL.');
      }

      const user = await userService.initUser(telegramId, msg.from);
      
      if (!(await userService.canProcessVideo(telegramId))) {
        const limitMessage = `🚫 Daily limit reached!

You've used your 3 free videos today.

💎 Upgrade to Premium for unlimited access!
Contact @Osezblessed to upgrade instantly!`;
        
        return bot.sendMessage(chatId, limitMessage);
      }
      
      // Check platform restrictions
      if (user.subscription_type === 'free') {
        const platform = detectPlatform(videoUrl);
        if (['Instagram', 'Twitter'].includes(platform)) {
          return bot.sendMessage(chatId, `🔒 ${platform} processing requires Premium subscription. Contact @Osezblessed to upgrade!`);
        }
      }

      // FIXED: Check processing queue with proper parameters
      if (!processingQueue.canProcess(telegramId, user.subscription_type)) {
        const queueStatus = processingQueue.getStatus();
        const userProcessingCount = queueStatus.userProcessing[telegramId] || 0;
        
        let queueMessage = '';
        if (userProcessingCount >= processingQueue.maxPerUser[user.subscription_type]) {
          queueMessage = `⏳ You already have ${userProcessingCount} video(s) processing. Please wait for them to complete.

Your limit: ${processingQueue.maxPerUser[user.subscription_type]} concurrent videos
${user.subscription_type === 'free' ? '\n💎 Upgrade to Premium for higher limits!' : ''}`;
        } else {
          queueMessage = `⏳ Processing queue is full for ${user.subscription_type} users. Please try again in a few minutes.

Current global load: ${queueStatus.globalProcessing[user.subscription_type]}/${processingQueue.maxGlobal[user.subscription_type]}`;
        }
        
        return bot.sendMessage(chatId, queueMessage);
      }
      
      processingId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // FIXED: Start processing with proper parameters
      processingQueue.startProcessing(processingId, telegramId, user.subscription_type);
      
      const processingMessages = {
        free: '🎬 Processing your video... This may take 2-5 minutes.',
        premium: '🎬 ⚡ Premium processing started... 1-2 minutes remaining.',
        pro: '🎬 🚀 Pro processing initiated... 30-60 seconds remaining.'
      };
      
      await bot.sendMessage(chatId, processingMessages[user.subscription_type]);
      
      const videoRecord = await createVideo({
        processing_id: processingId,
        telegram_id: telegramId,
        video_url: videoUrl,
        platform: detectPlatform(videoUrl)
      });
      
      await userService.updateUsage(telegramId);
      
      // Enhanced n8n workflow call with retry mechanism
      const n8nPayload = {
        telegram_id: telegramId,
        chat_id: chatId,
        video_url: videoUrl,
        user_name: user.first_name,
        subscription_type: user.subscription_type,
        webhook_secret: process.env.N8N_WEBHOOK_SECRET || '7f9d0d2e8a6f4f38a13a2bcf5b6d441b91c9d26e8b72714d2edcf7c4e2a843ke',
        business_bot_url: process.env.RENDER_EXTERNAL_URL || 'https://video-shorts-business-bot.onrender.com',
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
              headers: { 'Content-Type': 'application/json' }
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
      
      await logUsage({
        telegram_id: telegramId,
        video_id: videoRecord.id,
        processing_id: processingId,
        action: 'video_processing_started',
        platform: detectPlatform(videoUrl),
        success: true
      });
      
    } catch (error) {
      logger.error('Video processing error', { telegramId, videoUrl, error: error.message });
      
      await bot.sendMessage(chatId, `❌ Processing failed: ${error.response?.data?.message || error.message}

🔄 Please try again in a few minutes.
📞 If the issue persists, contact @Osezblessed

Error code: ${error.response?.status || 'NETWORK_ERROR'}`);
      
      await userService.revertUsage(telegramId);
      
      // FIXED: Only finish processing if processingId was created
      if (processingId) {
        processingQueue.finishProcessing(processingId);
      }
      
      await logUsage({
        telegram_id: telegramId,
        processing_id: processingId || null,
        action: 'video_processing_failed',
        platform: detectPlatform(videoUrl).catch(() => 'Unknown'),
        success: false,
        error_message: error.message
      });
    }
  }
});

// Enhanced file upload endpoints with better error handling
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
    
    // Enhanced file validation
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
    
    // Determine bucket based on subscription type
    const bucket = subscription_type === 'free' ? 'free-videos' : 'premium-videos';
    const fileName = `${short_id}_${Date.now()}.mp4`;
    const storagePath = `videos/${processing_id}/${fileName}`;
    
    // Upload with retry mechanism
    let uploadResult;
    let retries = 3;
    let lastUploadError;
    
    while (retries > 0) {
      try {
        uploadResult = await uploadFile(bucket, storagePath, fileBuffer, contentType);
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
    
    // Update database record
    await updateVideo(processing_id, {
      file_path: storagePath,
      file_url: uploadResult.publicUrl,
      file_size_bytes: file.size,
      storage_bucket: bucket,
      status: 'completed'
    });
    
    // Create short video record
    await createShort({
      short_id: short_id,
      video_processing_id: processing_id, // This would need to be the actual ID
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
    
    const uploadResult = await uploadFile('thumbnails', storagePath, fileBuffer, contentType);
    
    await fs.unlink(file.path);
    
    await updateVideo(processing_id, {
      thumbnail_path: storagePath,
      thumbnail_url: uploadResult.publicUrl
    });
    
    // Update short video record with thumbnail
    await updateShort(short_id, {
      thumbnail_url: uploadResult.publicUrl,
      thumbnail_path: storagePath
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

// Add download endpoint
app.get('/download/:processing_id/:short_id', async (req, res) => {
  const correlationId = req.correlationId || `download_${Date.now()}`;
  
  try {
    const { processing_id, short_id } = req.params;
    
    // Verify user has access to this resource
    const videoRecord = await getVideo(processing_id);
    if (!videoRecord) {
      return res.status(404).json({ 
        error: 'Video not found',
        correlationId 
      });
    }
    
    // In a real implementation, you would verify the user's identity
    // For example, check if the user's telegram_id matches the video record
    
    // Get signed URL for download (expires in 1 hour)
    const { data: { signedUrl }, error } = await supabase.storage
      .from(videoRecord.storage_bucket)
      .createSignedUrl(videoRecord.storage_path, 3600);
    
    if (error) {
      throw error;
    }
    
    logger.info('Download URL generated', {
      correlationId,
      processingId: processing_id,
      shortId: short_id
    });
    
    res.json({ 
      download_url: signedUrl,
      correlationId 
    });
    
  } catch (error) {
    logger.error('Download error', { 
      correlationId,
      error: error.message 
    });
    res.status(500).json({ 
      error: 'Download failed',
      details: error.message,
      correlationId 
    });
  }
});

// Add file cleanup endpoint for maintenance
app.post('/admin/cleanup-files', async (req, res) => {
  const correlationId = req.correlationId || `cleanup_${Date.now()}`;
  
  try {
    const { days = 7, dry_run = true } = req.body;
    
    if (!req.headers.authorization || req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        correlationId 
      });
    }
    
    const result = await cleanupOldFiles(days, dry_run);
    
    logger.info('File cleanup completed', {
      correlationId,
      days,
      dry_run,
      result
    });
    
    res.json({
      message: dry_run ? 
        `Would delete ${result.files_found} files older than ${days} days` :
        `Cleaned up ${result.files_deleted} files older than ${days} days`,
      ...result,
      correlationId
    });
    
  } catch (error) {
    logger.error('Cleanup failed', { 
      correlationId,
      error: error.message 
    });
    res.status(500).json({
      error: 'Cleanup failed',
      message: error.message,
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
    
    // ENHANCED: Extract and validate required fields with better error handling
    const {
      processing_id,
      telegram_id,
      chat_id,
      status,
      shorts_results,
      total_shorts,
      subscription_type,
      processing_completed_at,
      video_info,
      platform
    } = callbackData;
    
    // CORRECTED: Better validation with specific error messages
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
        availableFields: Object.keys(callbackData),
        debug_info: callbackData.debug_info || 'Not provided'
      };
      
      logger.error('Invalid callback data - missing required fields', { correlationId, ...errorDetails });
      return res.status(400).json({ 
        error: `Missing required fields: ${missingFields.join(', ')}`,
        details: errorDetails,
        correlationId
      });
    }
    
    // FIXED: Robust ID conversion with validation
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
    
    // FIXED: Finish processing queue properly (ensure this matches the processing_id)
    processingQueue.finishProcessing(processing_id);
    
    // ENHANCED: Update video record with better error handling
    let videoRecord;
    try {
      videoRecord = await updateVideo(processing_id, {
        status: status === 'completed' ? 'completed' : 'failed',
        completed_at: status === 'completed' ? new Date().toISOString() : null,
        error_message: status === 'failed' ? 
          (callbackData.error_message || 'Processing failed') : null
      });
    } catch (dbError) {
      logger.error('Failed to update video record', {
        correlationId,
        processingId: processing_id,
        error: dbError.message
      });
      // Continue processing even if DB update fails
    }
    
    if (status === 'completed') {
      // CORRECTED: Handle shorts_results parsing more robustly
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
      
      // ENHANCED: Save shorts to database with transaction-like behavior
      const savedShorts = [];
      for (const [index, short] of results.entries()) {
        try {
          if (videoRecord?.id) {
            const savedShort = await createShort({
              video_id: videoRecord.id,
              short_id: short.short_id || `short_${processing_id}_${index + 1}`,
              title: short.title || `Video Short ${index + 1}`,
              file_url: short.file_url || null,
              thumbnail_url: short.thumbnail_url || null,
              duration: short.duration ? parseInt(short.duration) : null,
              quality: short.quality || '720p',
              file_size_bytes: short.file_size ? 
                parseInt(String(short.file_size).replace(/[^\d]/g, '')) : null,
              features_applied: short.features_applied || [],
              watermark: short.watermark || null
            });
            savedShorts.push(savedShort);
          }
        } catch (shortError) {
          logger.error('Failed to save short', { 
            correlationId,
            shortId: short.short_id, 
            index,
            error: shortError.message 
          });
        }
      }
      
      // CORRECTED: Build success message with proper validation
      const shortsCount = total_shorts || results.length || 0;
      const quality = results[0]?.quality || '720p';
      
      let message = `✅ Your ${shortsCount} short${shortsCount !== 1 ? 's' : ''} ${shortsCount !== 1 ? 'are' : 'is'} ready!

🎬 Processing completed successfully
📱 Quality: ${quality}
🎯 Platform: ${platform || 'Unknown'}
⏱️ Processing time: Just completed

📥 Download links:`;
      
      // Add individual short details
      results.forEach((short, index) => {
        const shortTitle = short.title || `Video Short ${index + 1}`;
        message += `\n\n🎥 Short ${index + 1}: ${shortTitle}`;
        
        if (short.file_url && 
            !short.file_url.includes('demo.videoshortsbot.com') && 
            !short.file_url.includes('placeholder')) {
          message += `\n📎 ${short.file_url}`;
        } else {
          message += `\n📎 [File will be available shortly]`;
        }
        
        if (short.duration) {
          message += `\n⏱️ Duration: ${short.duration}s`;
        }
        
        if (short.watermark) {
          message += `\n💧 Watermark: ${short.watermark}`;
        }
      });
      
      // Add subscription-specific messaging
      if (subscription_type === 'free') {
        message += `\n\n🚀 Upgrade to Premium for:\n• HD Quality (1080p)\n• No Watermarks\n• More Shorts per Video\n• Priority Processing\n\nContact @Osezblessed to upgrade!`;
      } else if (subscription_type === 'premium') {
        message += `\n\n💎 Premium features applied:\n• High Quality Processing\n• No Watermarks\n• Priority Queue`;
      } else if (subscription_type === 'pro') {
        message += `\n\n🚀 Pro features applied:\n• Maximum Quality\n• Advanced Processing\n• Priority Support`;
      }
      
      // FIXED: Send message with proper error handling
      try {
        await bot.sendMessage(chatIdNum, message);
        logger.info('Success message sent', { correlationId, chatId: chatIdNum, shortsCount });
      } catch (telegramError) {
        logger.error('Failed to send success message', { 
          correlationId,
          chatId: chatIdNum, 
          error: telegramError.message 
        });
        // Don't fail the entire callback if message sending fails
      }
      
      // ENHANCED: Log successful completion with metrics
      try {
        await logUsage({
          telegram_id: telegramIdNum,
          video_id: videoRecord?.id || null,
          processing_id: processing_id,
          action: 'video_processing_completed',
          success: true,
          processing_time: processing_completed_at ? 
            Math.floor((new Date(processing_completed_at) - new Date(videoRecord?.created_at || new Date())) / 1000) : null,
          shorts_generated: results.length,
          platform: platform || 'Unknown'
        });
      } catch (logError) {
        logger.warn('Failed to log completion', { correlationId, error: logError.message });
      }
      
    } else if (status === 'error' || status === 'failed') {
      // CORRECTED: Handle error cases properly
      const errorMessage = callbackData.error_message || 
                          callbackData.message || 
                          'Unknown error occurred during processing';
      
      const errorMsg = `❌ Processing Failed

🔍 Error: ${errorMessage}

🔄 What you can do:
• Check if the video URL is accessible
• Try a shorter video (under 10 minutes)
• Wait a few minutes and try again
• Make sure the video is public

📞 Still having issues? Contact @Osezblessed

📝 Reference ID: ${processing_id}`;

      try {
        await bot.sendMessage(chatIdNum, errorMsg);
        logger.info('Error message sent', { correlationId, chatId: chatIdNum });
      } catch (telegramError) {
        logger.error('Failed to send error message', { 
          correlationId,
          chatId: chatIdNum, 
          error: telegramError.message 
        });
      }
      
      // CORRECTED: Revert usage for failed processing
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
      
      // Log failed completion
      try {
        await logUsage({
          telegram_id: telegramIdNum,
          video_id: videoRecord?.id || null,
          processing_id: processing_id,
          action: 'video_processing_failed',
          success: false,
          error_message: errorMessage,
          platform: platform || 'Unknown'
        });
      } catch (logError) {
        logger.warn('Failed to log error', { correlationId, error: logError.message });
      }
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
    
    // Send admin alert for critical callback errors
    await sendAdminAlert(`Critical callback processing error: ${error.message}`, error);
    
    res.status(500).json({ 
      error: 'Failed to process callback', 
      details: error.message,
      correlationId
    });
  }
});

// Enhanced health check with comprehensive system status
app.get('/health', async (req, res) => {
  const correlationId = req.correlationId || `health_${Date.now()}`;
  
  try {
    const healthStatus = {
      timestamp: new Date().toISOString(),
      status: 'healthy',
      services: {},
      database: {},
      storage: {},
      system: {
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        version: process.version,
        platform: process.platform
      },
      processing: {
        queue_status: processingQueue.getStatus(),
        max_concurrent_per_user: processingQueue.maxPerUser,
        max_global: processingQueue.maxGlobal
      },
      correlationId
    };

    // Test database connection with timeout
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

    // Test storage connection
    try {
      const storageStart = Date.now();
      const { data: buckets, error } = await Promise.race([
        supabase.storage.listBuckets(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Storage timeout')), 5000))
      ]);
      
      healthStatus.storage.status = error ? 'error' : 'connected';
      healthStatus.storage.response_time = Date.now() - storageStart;
      healthStatus.storage.buckets = buckets?.map(b => b.name) || [];
      healthStatus.storage.error = error?.message;
      
    } catch (storageError) {
      healthStatus.storage.status = 'error';
      healthStatus.storage.error = storageError.message;
    }

    // Test n8n connectivity
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

    // Test Telegram Bot API
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

    // Overall status determination
    const hasErrors = healthStatus.database.status === 'error' || 
                     healthStatus.storage.status === 'error' ||
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

// Enhanced metrics endpoint
app.get('/metrics', async (req, res) => {
  const correlationId = req.correlationId || `metrics_${Date.now()}`;
  
  try {
    const stats = await getStats();
    const queueStatus = processingQueue.getStatus();
    
    const metrics = {
      timestamp: new Date().toISOString(),
      users: {
        total: stats.users.total,
        active_today: stats.users.active_today || 0,
        free: stats.users.free,
        premium: stats.users.premium,
        pro: stats.users.pro,
        conversion_rate: stats.users.total > 0 ? 
          (((stats.users.premium + stats.users.pro) / stats.users.total) * 100).toFixed(2) : 0
      },
      videos: {
        total_processed: stats.videos.total,
        completed: stats.videos.completed,
        processing: stats.videos.processing,
        failed: stats.videos.failed,
        success_rate: stats.videos.total > 0 ? 
          ((stats.videos.completed / stats.videos.total) * 100).toFixed(2) : 0,
        avg_processing_time: stats.videos.avg_processing_time || 0
      },
      revenue: {
        monthly_mrr: ((stats.users.premium * 2.99) + (stats.users.pro * 9.99)).toFixed(2),
        arpu: stats.users.total > 0 ? 
          (((stats.users.premium * 2.99) + (stats.users.pro * 9.99)) / stats.users.total).toFixed(2) : 0,
        ltv_estimate: ((stats.users.premium * 2.99 * 12) + (stats.users.pro * 9.99 * 12)).toFixed(2)
      },
      system: {
        uptime_seconds: Math.floor(process.uptime()),
        memory_usage: process.memoryUsage(),
        node_version: process.version,
        platform: process.platform,
        processing_queue: queueStatus
      },
      performance: {
        response_times: {
          database: 0, // This would be populated from monitoring
          storage: 0,
          n8n: 0
        },
        error_rates: {
          last_hour: 0, // This would be calculated from logs
          last_24h: 0
        }
      },
      correlationId
    };

    res.json(metrics);
  } catch (error) {
    logger.error('Metrics error', { correlationId, error: error.message });
    res.status(500).json({
      error: 'Failed to get metrics',
      message: error.message,
      correlationId
    });
  }
});

// Enhanced storage usage endpoint
app.get('/storage-usage', async (req, res) => {
  const correlationId = req.correlationId || `storage_${Date.now()}`;
  
  try {
    const [videoFiles, thumbnailFiles] = await Promise.all([
      supabase.storage.from('video-files').list('', { limit: 1000 }),
      supabase.storage.from('thumbnails').list('', { limit: 1000 })
    ]);

    if (videoFiles.error || thumbnailFiles.error) {
      throw new Error(videoFiles.error?.message || thumbnailFiles.error?.message);
    }

    const videoSize = videoFiles.data.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
    const thumbnailSize = thumbnailFiles.data.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
    const totalSize = videoSize + thumbnailSize;

    const usage = {
      video_files: {
        count: videoFiles.data.length,
        total_size_bytes: videoSize,
        total_size_mb: (videoSize / 1024 / 1024).toFixed(2),
        total_size_gb: (videoSize / 1024 / 1024 / 1024).toFixed(2)
      },
      thumbnails: {
        count: thumbnailFiles.data.length,
        total_size_bytes: thumbnailSize,
        total_size_mb: (thumbnailSize / 1024 / 1024).toFixed(2)
      },
      total: {
        files: videoFiles.data.length + thumbnailFiles.data.length,
        size_bytes: totalSize,
        size_mb: (totalSize / 1024 / 1024).toFixed(2),
        size_gb: (totalSize / 1024 / 1024 / 1024).toFixed(2)
      },
      recommendations: {
        cleanup_needed: (totalSize / 1024 / 1024 / 1024) > 0.5, // 500MB threshold
        storage_health: (totalSize / 1024 / 1024 / 1024) < 1 ? 'good' : 
                       (totalSize / 1024 / 1024 / 1024) < 2 ? 'warning' : 'critical',
        message: (totalSize / 1024 / 1024 / 1024) > 0.5 ? 
          'Consider running cleanup for files older than 7 days' : 'Storage usage is healthy'
      },
      limits: {
        supabase_free_limit_gb: 1,
        current_usage_percent: ((totalSize / 1024 / 1024 / 1024) / 1 * 100).toFixed(2)
      },
      correlationId
    };

    res.json(usage);
  } catch (error) {
    logger.error('Storage usage error', { correlationId, error: error.message });
    res.status(500).json({
      error: 'Failed to get storage usage',
      message: error.message,
      correlationId
    });
  }
});

// Enhanced admin endpoints
app.post('/admin/cleanup-old-files', async (req, res) => {
  const correlationId = req.correlationId || `cleanup_${Date.now()}`;
  
  try {
    const { days = 7, dry_run = false } = req.body;
    
    if (!req.headers.authorization || req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        correlationId 
      });
    }
    
    if (!dry_run) {
      logger.info('Starting file cleanup', { correlationId, days });
    }
    
    const deletedCount = await cleanupOldFiles(days, dry_run);
    
    const response = {
      message: dry_run ? 
        `Would delete ${deletedCount.files_found} files older than ${days} days` :
        `Cleaned up ${deletedCount.files_deleted} files older than ${days} days`,
      deleted_count: deletedCount.files_deleted,
      dry_run,
      timestamp: new Date().toISOString(),
      correlationId
    };
    
    if (!dry_run) {
      logger.info('File cleanup completed', { correlationId, ...response });
    }
    
    res.json(response);
  } catch (error) {
    logger.error('Cleanup failed', { correlationId, error: error.message });
    res.status(500).json({
      error: 'Cleanup failed',
      message: error.message,
      correlationId
    });
  }
});

// Enhanced queue status endpoint for debugging
app.get('/queue-status', async (req, res) => {
  const correlationId = req.correlationId || `queue_${Date.now()}`;
  
  try {
    const queueStatus = processingQueue.getStatus();
    const cleanedStale = processingQueue.cleanupStaleProcessing();
    
    res.json({
      queue_status: queueStatus,
      cleaned_stale_entries: cleanedStale,
      limits: {
        per_user: processingQueue.maxPerUser,
        global: processingQueue.maxGlobal
      },
      timestamp: new Date().toISOString(),
      correlationId
    });
  } catch (error) {
    logger.error('Queue status error', { correlationId, error: error.message });
    res.status(500).json({
      error: 'Failed to get queue status',
      message: error.message,
      correlationId
    });
  }
});

// Enhanced dashboard with real-time data
app.get('/dashboard', async (req, res) => {
  const correlationId = req.correlationId || `dashboard_${Date.now()}`;
  
  try {
    const [stats, storageUsage] = await Promise.all([
      getStats(),
      getStorageUsage()
    ]);
    
    const queueStatus = processingQueue.getStatus();
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>VideoShortsBot Dashboard</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          margin: 0; padding: 20px; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
          background: white; 
          padding: 30px; 
          border-radius: 15px; 
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
          margin-bottom: 30px;
          text-align: center;
        }
        .header h1 { 
          margin: 0; 
          color: #333; 
          font-size: 2.5em; 
          font-weight: 700;
        }
        .subtitle { color: #666; margin-top: 10px; font-size: 1.1em; }
        .grid { 
          display: grid; 
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
          gap: 20px; 
          margin-bottom: 30px;
        }
        .card { 
          background: white; 
          padding: 25px; 
          border-radius: 15px; 
          box-shadow: 0 8px 25px rgba(0,0,0,0.15);
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        .card:hover { 
          transform: translateY(-5px); 
          box-shadow: 0 15px 40px rgba(0,0,0,0.2);
        }
        .stat { 
          font-size: 2.5em; 
          font-weight: bold; 
          margin-bottom: 10px;
          background: linear-gradient(45deg, #667eea, #764ba2);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .label { color: #666; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }
        .status { 
          display: inline-block; 
          padding: 5px 10px; 
          border-radius: 20px; 
          font-size: 0.8em; 
          font-weight: bold;
          margin-top: 10px;
        }
        .status.healthy { background: #e8f5e8; color: #2e7d2e; }
        .status.warning { background: #fff3cd; color: #856404; }
        .status.error { background: #f8d7da; color: #721c24; }
        .progress-bar {
          width: 100%;
          height: 8px;
          background: #e0e0e0;
          border-radius: 4px;
          margin-top: 10px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #667eea, #764ba2);
          border-radius: 4px;
          transition: width 0.3s ease;
        }
        .system-info {
          background: white;
          padding: 25px;
          border-radius: 15px;
          box-shadow: 0 8px 25px rgba(0,0,0,0.15);
          margin-top: 20px;
        }
        .queue-info {
          background: white;
          padding: 25px;
          border-radius: 15px;
          box-shadow: 0 8px 25px rgba(0,0,0,0.15);
          margin-top: 20px;
        }
        .refresh-btn {
          position: fixed;
          bottom: 30px;
          right: 30px;
          background: #667eea;
          color: white;
          border: none;
          padding: 15px;
          border-radius: 50%;
          font-size: 1.2em;
          cursor: pointer;
          box-shadow: 0 4px 15px rgba(0,0,0,0.2);
          transition: all 0.3s ease;
        }
        .refresh-btn:hover {
          background: #5a67d8;
          transform: scale(1.1);
        }
        @media (max-width: 768px) {
          .grid { grid-template-columns: 1fr; }
          .header h1 { font-size: 2em; }
        }
      </style>
      <script>
        function refreshDashboard() {
          window.location.reload();
        }
        
        // Auto-refresh every 5 minutes
        setInterval(refreshDashboard, 300000);
        
        // Update timestamp every second
        setInterval(() => {
          const now = new Date();
          document.getElementById('last-updated').textContent = 
            'Last updated: ' + now.toLocaleTimeString();
        }, 1000);
      </script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📊 VideoShortsBot Analytics</h1>
          <div class="subtitle" id="last-updated">
            Last updated: ${new Date().toLocaleTimeString()}
          </div>
        </div>
        
        <div class="grid">
          <div class="card">
            <div class="stat">${stats.users.total}</div>
            <div class="label">Total Users</div>
            <div class="status healthy">Growing</div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.users.premium}</div>
            <div class="label">Premium Users</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${stats.users.total > 0 ? (stats.users.premium / stats.users.total * 100) : 0}%"></div>
            </div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.users.pro}</div>
            <div class="label">Pro Users</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${stats.users.total > 0 ? (stats.users.pro / stats.users.total * 100) : 0}%"></div>
            </div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.videos.total}</div>
            <div class="label">Videos Processed</div>
            <div class="status healthy">All-time</div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.videos.completed}</div>
            <div class="label">Successful</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${stats.videos.total > 0 ? (stats.videos.completed / stats.videos.total * 100) : 0}%"></div>
            </div>
          </div>
          
          <div class="card">
            <div class="stat">${((stats.users.premium * 2.99) + (stats.users.pro * 9.99)).toFixed(0)}</div>
            <div class="label">Monthly Revenue</div>
            <div class="status ${((stats.users.premium * 2.99) + (stats.users.pro * 9.99)) > 100 ? 'healthy' : 'warning'}">MRR</div>
          </div>
          
          <div class="card">
            <div class="stat">${stats.users.total > 0 ? (((stats.users.premium + stats.users.pro) / stats.users.total) * 100).toFixed(1) : 0}%</div>
            <div class="label">Conversion Rate</div>
            <div class="status ${stats.users.total > 0 && (((stats.users.premium + stats.users.pro) / stats.users.total) * 100) > 5 ? 'healthy' : 'warning'}">Growth</div>
          </div>
          
          <div class="card">
            <div class="stat">${storageUsage ? storageUsage.total_size_gb : '0'} GB</div>
            <div class="label">Storage Used</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${storageUsage ? (storageUsage.total_size_gb / 1 * 100) : 0}%"></div>
            </div>
            <div class="status ${storageUsage && storageUsage.total_size_gb > 0.8 ? 'warning' : 'healthy'}">
              ${storageUsage && storageUsage.total_size_gb > 0.8 ? 'High usage' : 'Normal'}
            </div>
          </div>
          
          <div class="card">
            <div class="stat">${queueStatus.totalActive}</div>
            <div class="label">Processing Queue</div>
            <div class="status ${queueStatus.totalActive > 20 ? 'warning' : 'healthy'}">
              ${queueStatus.totalActive > 20 ? 'High load' : 'Normal'}
            </div>
          </div>
        </div>
        
        <div class="queue-info">
          <h3 style="margin-top: 0; color: #333;">🔄 Processing Queue Status</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
            <div>
              <strong>Free Users:</strong> ${queueStatus.globalProcessing.free}/10<br>
              <span class="status ${queueStatus.globalProcessing.free > 8 ? 'warning' : 'healthy'}">
                ${queueStatus.globalProcessing.free > 8 ? 'High load' : 'Normal'}
              </span>
            </div>
            <div>
              <strong>Premium Users:</strong> ${queueStatus.globalProcessing.premium}/20<br>
              <span class="status ${queueStatus.globalProcessing.premium > 15 ? 'warning' : 'healthy'}">
                ${queueStatus.globalProcessing.premium > 15 ? 'High load' : 'Normal'}
              </span>
            </div>
            <div>
              <strong>Pro Users:</strong> ${queueStatus.globalProcessing.pro}/50<br>
              <span class="status ${queueStatus.globalProcessing.pro > 40 ? 'warning' : 'healthy'}">
                ${queueStatus.globalProcessing.pro > 40 ? 'High load' : 'Normal'}
              </span>
            </div>
            <div>
              <strong>Active Processes:</strong> ${queueStatus.totalActive}<br>
              <span class="status healthy">Real-time</span>
            </div>
          </div>
        </div>
        
        <div class="system-info">
          <h3 style="margin-top: 0; color: #333;">🔧 System Status</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
            <div>
              <strong>Database:</strong> Connected to Supabase<br>
              <span class="status healthy">Healthy</span>
            </div>
            <div>
              <strong>Storage:</strong> Supabase Storage<br>
              <span class="status healthy">Active</span>
            </div>
            <div>
              <strong>Processing:</strong> n8n Workflows<br>
              <span class="status healthy">Running</span>
            </div>
            <div>
              <strong>Uptime:</strong> ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m<br>
              <span class="status healthy">Stable</span>
            </div>
          </div>
        </div>
      </div>
      
      <button class="refresh-btn" onclick="refreshDashboard()" title="Refresh Dashboard">
        🔄
      </button>
    </body>
    </html>
    `;
    
    res.send(html);
  } catch (error) {
    logger.error('Dashboard error', { correlationId, error: error.message });
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 50px; text-align: center;">
          <h1 style="color: #e74c3c;">Dashboard Error</h1>
          <p>Unable to load dashboard: ${error.message}</p>
          <button onclick="window.location.reload()" style="padding: 10px 20px; font-size: 16px;">
            Try Again
          </button>
        </body>
      </html>
    `);
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'VideoShortsBot Business API',
    status: 'running',
    version: '2.0.0',
    endpoints: {
      dashboard: '/dashboard',
      health: '/health',
      metrics: '/metrics',
      queue_status: '/queue-status'
    },
    correlationId: req.correlationId
  });
});

// Enhanced 404 handler
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
    available_endpoints: [
      'GET /health',
      'GET /metrics',
      'GET /dashboard',
      'GET /storage-usage',
      'GET /queue-status',
      'POST /webhook/n8n-callback',
      'POST /upload-processed-video',
      'POST /upload-thumbnail'
    ],
    correlationId: req.correlationId
  });
});

// Enhanced error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error', { 
    correlationId: req.correlationId,
    error: error.message, 
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  // Send alert for critical errors
  if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
    sendAdminAlert('Critical system error detected', error);
  }

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    correlationId: req.correlationId
  });
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown...');
  
  // Stop accepting new connections
  server.close(async () => {
    try {
      // Stop cron jobs
      dailyResetJob.stop();
      
      // Send final admin alert
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

// Handle uncaught exceptions
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
  logger.info('🤖 VideoShortsBot server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    dashboard_url: `https://video-shorts-business-bot.onrender.com/dashboard`,
    database: 'Supabase',
    storage: 'Supabase Storage',
    node_version: process.version
  });
});

module.exports = { app, bot, server, userService, processingQueue };