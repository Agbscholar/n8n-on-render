const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

class SupabaseService {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        db: {
          schema: 'public'
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
    
    this.serviceClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        db: {
          schema: 'public'
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // Connection pool settings
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  async withRetry(operation, context = '') {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        logger.warn(`Database operation failed (attempt ${attempt}/${this.maxRetries})`, {
          context,
          error: error.message,
          attempt
        });
        
        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
        }
      }
    }
    
    throw lastError;
  }

  // User operations
  async getUser(telegramId) {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        throw error;
      }
      
      return data;
    }, `getUser(${telegramId})`);
  }

  async createUser(userData) {
    return this.withRetry(async () => {
      const userRecord = {
        telegram_id: userData.telegram_id,
        username: userData.username || null,
        first_name: userData.first_name || null,
        last_name: userData.last_name || null,
        subscription_type: 'free',
        daily_usage: 0,
        total_usage: 0,
        referral_code: `REF${userData.telegram_id}`,
        referred_users: 0,
        subscription_expires: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await this.supabase
        .from('users')
        .insert([userRecord])
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `createUser(${userData.telegram_id})`);
  }

  async updateUser(telegramId, updateData) {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('users')
        .update({
          ...updateData,
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `updateUser(${telegramId})`);
  }

  // Video operations
  async createVideo(videoData) {
    return this.withRetry(async () => {
      // Get user UUID from telegram_id
      const user = await this.getUser(videoData.telegram_id);
      if (!user) {
        throw new Error('User not found');
      }

      const videoRecord = {
        processing_id: videoData.processing_id,
        user_id: user.id,
        telegram_id: videoData.telegram_id,
        original_url: videoData.video_url || videoData.original_url,
        platform: videoData.platform || 'unknown',
        subscription_type: videoData.subscription_type || user.subscription_type || 'free',
        status: 'processing',
        file_name: videoData.file_name || null,
        file_size_bytes: videoData.file_size || null,
        mime_type: videoData.mime_type || null,
        duration: videoData.duration || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await this.supabase
        .from('video_processing')
        .insert([videoRecord])
        .select()
        .single();

      if (error) throw error;
      return data;
    }, `createVideo(${videoData.processing_id})`);
  }

  async updateVideo(processingId, updateData) {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('video_processing')
        .update({
          ...updateData,
          updated_at: new Date().toISOString()
        })
        .eq('processing_id', processingId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `updateVideo(${processingId})`);
  }

  async getVideo(processingId) {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('video_processing')
        .select(`
          *,
          short_videos (*)
        `)
        .eq('processing_id', processingId)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return data;
    }, `getVideo(${processingId})`);
  }

  async getVideosByUser(telegramId, limit = 10, offset = 0) {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('video_processing')
        .select(`
          *,
          short_videos (*)
        `)
        .eq('telegram_id', telegramId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        throw error;
      }

      return data || [];
    }, `getVideosByUser(${telegramId})`);
  }

  // Short video operations
  async createShort(shortData) {
    return this.withRetry(async () => {
      const shortRecord = {
        ...shortData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await this.supabase
        .from('short_videos')
        .insert([shortRecord])
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `createShort(${shortData.short_id})`);
  }

  async updateShort(shortId, updateData) {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('short_videos')
        .update({
          ...updateData,
          updated_at: new Date().toISOString()
        })
        .eq('short_id', shortId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `updateShort(${shortId})`);
  }

  // Usage operations
  async canUseService(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) return false;

      // Check subscription validity
      if (['premium', 'pro'].includes(user.subscription_type)) {
        if (user.subscription_expires && new Date() < new Date(user.subscription_expires)) {
          return true; // Valid subscription
        } else if (user.subscription_expires && new Date() >= new Date(user.subscription_expires)) {
          // Subscription expired, downgrade to free
          await this.updateUser(telegramId, {
            subscription_type: 'free',
            subscription_expires: null
          });
        }
      }

      // Free users limited to 3 per day
      return user.daily_usage < 3;
    } catch (error) {
      logger.error('Error checking service usage:', { telegramId, error: error.message });
      return false;
    }
  }

  async incrementUsage(telegramId) {
    return this.withRetry(async () => {
      const user = await this.getUser(telegramId);
      if (!user) {
        throw new Error('User not found');
      }

      const { data, error } = await this.supabase
        .from('users')
        .update({
          daily_usage: user.daily_usage + 1,
          total_usage: user.total_usage + 1,
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `incrementUsage(${telegramId})`);
  }

  async decrementUsage(telegramId) {
    return this.withRetry(async () => {
      const user = await this.getUser(telegramId);
      if (!user) {
        throw new Error('User not found');
      }

      const { data, error } = await this.supabase
        .from('users')
        .update({
          daily_usage: Math.max(user.daily_usage - 1, 0),
          total_usage: Math.max(user.total_usage - 1, 0),
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }, `decrementUsage(${telegramId})`);
  }

  async resetDailyUsage() {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('users')
        .update({ 
          daily_usage: 0,
          updated_at: new Date().toISOString()
        })
        .neq('daily_usage', 0)
        .select();

      if (error) {
        throw error;
      }

      logger.info(`Reset daily usage for ${data?.length || 0} users`);
      return data;
    }, 'resetDailyUsage');
  }

  // Usage logging
  async logUsage(logData) {
    try {
      return this.withRetry(async () => {
        const logRecord = {
          telegram_id: logData.telegram_id,
          video_id: logData.video_id || null,
          processing_id: logData.processing_id || null,
          action: logData.action,
          platform: logData.platform || null,
          success: logData.success !== false,
          error_message: logData.error_message || null,
          processing_time: logData.processing_time || null,
          shorts_generated: logData.shorts_generated || 0,
          total_shorts: logData.total_shorts || 0,
          file_size_bytes: logData.file_size_bytes || null,
          created_at: new Date().toISOString()
        };

        const { data, error } = await this.supabase
          .from('usage_logs')
          .insert([logRecord])
          .select()
          .single();

        if (error) {
          throw error;
        }

        return data;
      }, `logUsage(${logData.action})`);
    } catch (error) {
      logger.error('Error logging usage', { error: error.message });
      // Don't throw - logging failures shouldn't break main functionality
      return null;
    }
  }

  // File operations with enhanced handling
  async uploadFile(bucket, filePath, fileBuffer, contentType, options = {}) {
    return this.withRetry(async () => {
      const uploadOptions = {
        contentType,
        upsert: options.upsert !== false, // Default to true
        cacheControl: options.cacheControl || '3600',
        ...options
      };

      const { data, error } = await this.serviceClient.storage
        .from(bucket)
        .upload(filePath, fileBuffer, uploadOptions);

      if (error) {
        throw error;
      }

      // Get public URL
      const { data: { publicUrl } } = this.serviceClient.storage
        .from(bucket)
        .getPublicUrl(filePath);

      return { 
        ...data, 
        publicUrl,
        bucket,
        path: filePath
      };
    }, `uploadFile(${bucket}/${filePath})`);
  }

  async deleteFile(bucket, filePath) {
    return this.withRetry(async () => {
      const { data, error } = await this.serviceClient.storage
        .from(bucket)
        .remove([filePath]);

      if (error) {
        throw error;
      }

      return data;
    }, `deleteFile(${bucket}/${filePath})`);
  }

  async getFileInfo(bucket, filePath) {
    return this.withRetry(async () => {
      const { data, error } = await this.serviceClient.storage
        .from(bucket)
        .list(path.dirname(filePath), {
          search: path.basename(filePath)
        });

      if (error) {
        throw error;
      }

      return data?.[0] || null;
    }, `getFileInfo(${bucket}/${filePath})`);
  }

  // Enhanced storage operations
  async createBucketIfNotExists(bucketName, isPublic = true) {
    try {
      // Try to get bucket first
      const { data: existingBucket, error: getError } = await this.serviceClient.storage
        .getBucket(bucketName);

      if (!getError) {
        logger.info(`Bucket '${bucketName}' already exists`);
        return existingBucket;
      }

      // Create bucket if it doesn't exist
      const { data, error } = await this.serviceClient.storage
        .createBucket(bucketName, {
          public: isPublic,
          fileSizeLimit: 1024 * 1024 * 1024, // 1GB
          allowedMimeTypes: [
            'video/*',
            'audio/*',
            'image/*',
            'application/json'
          ]
        });

      if (error) {
        throw error;
      }

      logger.info(`Created bucket '${bucketName}'`);
      return data;

    } catch (error) {
      logger.error(`Bucket operation failed for '${bucketName}'`, { error: error.message });
      throw error;
    }
  }

  // Statistics and analytics
  async getStats() {
    try {
      const [usersResult, videosResult, logsResult] = await Promise.all([
        this.supabase
          .from('users')
          .select('subscription_type, created_at'),
        this.supabase
          .from('video_processing')
          .select('status, created_at, file_size_bytes'),
        this.supabase
          .from('usage_logs')
          .select('action, success, created_at')
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      ]);

      const users = usersResult.data || [];
      const videos = videosResult.data || [];
      const logs = logsResult.data || [];

      // User statistics
      const userStats = {
        total: users.length,
        free: users.filter(u => u.subscription_type === 'free').length,
        premium: users.filter(u => u.subscription_type === 'premium').length,
        pro: users.filter(u => u.subscription_type === 'pro').length,
        new_today: users.filter(u => 
          new Date(u.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
        ).length
      };

      // Video statistics
      const videoStats = {
        total: videos.length,
        completed: videos.filter(v => v.status === 'completed').length,
        processing: videos.filter(v => v.status === 'processing').length,
        failed: videos.filter(v => v.status === 'failed').length,
        total_size_gb: videos.reduce((sum, v) => sum + (v.file_size_bytes || 0), 0) / (1024 * 1024 * 1024),
        processed_today: videos.filter(v => 
          new Date(v.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
        ).length
      };

      // Usage statistics (last 24 hours)
      const usageStats = {
        total_actions: logs.length,
        successful: logs.filter(l => l.success).length,
        failed: logs.filter(l => !l.success).length,
        success_rate: logs.length > 0 ? (logs.filter(l => l.success).length / logs.length * 100).toFixed(2) : 0
      };

      return {
        users: userStats,
        videos: videoStats,
        usage: usageStats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error getting stats', { error: error.message });
      return {
        users: { total: 0, free: 0, premium: 0, pro: 0, new_today: 0 },
        videos: { total: 0, completed: 0, processing: 0, failed: 0, total_size_gb: 0, processed_today: 0 },
        usage: { total_actions: 0, successful: 0, failed: 0, success_rate: 0 }
      };
    }
  }

  async getStorageUsage() {
    try {
      const buckets = ['video-files', 'premium-videos', 'thumbnails', 'backups'];
      let totalSize = 0;
      let totalFiles = 0;
      const bucketStats = {};

      for (const bucketName of buckets) {
        try {
          const { data: files, error } = await this.serviceClient.storage
            .from(bucketName)
            .list('', { 
              limit: 1000,
              sortBy: { column: 'created_at', order: 'desc' }
            });

          if (!error && files) {
            const bucketSize = files.reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
            const fileCount = files.length;
            
            bucketStats[bucketName] = {
              files: fileCount,
              size_bytes: bucketSize,
              size_mb: (bucketSize / (1024 * 1024)).toFixed(2),
              size_gb: (bucketSize / (1024 * 1024 * 1024)).toFixed(3)
            };
            
            totalSize += bucketSize;
            totalFiles += fileCount;
          } else {
            bucketStats[bucketName] = {
              files: 0,
              size_bytes: 0,
              size_mb: '0.00',
              size_gb: '0.000'
            };
          }
        } catch (bucketError) {
          logger.error(`Error accessing bucket ${bucketName}:`, bucketError);
          bucketStats[bucketName] = {
            files: 0,
            size_bytes: 0,
            size_mb: '0.00',
            size_gb: '0.000',
            error: bucketError.message
          };
        }
      }

      return {
        total: {
          files: totalFiles,
          size_bytes: totalSize,
          size_mb: (totalSize / (1024 * 1024)).toFixed(2),
          size_gb: (totalSize / (1024 * 1024 * 1024)).toFixed(3)
        },
        buckets: bucketStats,
        limits: {
          supabase_free_limit_gb: 1,
          usage_percent: ((totalSize / (1024 * 1024 * 1024)) / 1 * 100).toFixed(2)
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error getting storage usage', { error: error.message });
      return {
        total: { files: 0, size_bytes: 0, size_mb: '0.00', size_gb: '0.000' },
        buckets: {},
        limits: { supabase_free_limit_gb: 1, usage_percent: '0.00' }
      };
    }
  }

  // Maintenance operations
  async cleanupOldFiles(days = 7, dryRun = true) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const { data: oldVideos, error } = await this.supabase
        .from('video_processing')
        .select('id, processing_id, file_path, thumbnail_path, storage_bucket')
        .lt('created_at', cutoffDate.toISOString())
        .in('status', ['completed', 'failed']);

      if (error) {
        throw error;
      }

      let deletedCount = 0;
      const results = [];

      for (const video of oldVideos || []) {
        try {
          if (!dryRun) {
            // Delete files from storage
            if (video.file_path && video.storage_bucket) {
              await this.deleteFile(video.storage_bucket, video.file_path);
            }

            if (video.thumbnail_path) {
              await this.deleteFile('thumbnails', video.thumbnail_path);
            }

            // Update database record
            await this.supabase
              .from('video_processing')
              .update({
                file_path: null,
                thumbnail_path: null,
                file_url: null,
                thumbnail_url: null,
                updated_at: new Date().toISOString()
              })
              .eq('id', video.id);
          }

          results.push({
            processing_id: video.processing_id,
            file_path: video.file_path,
            thumbnail_path: video.thumbnail_path,
            deleted: !dryRun
          });

          deletedCount++;
        } catch (deleteError) {
          logger.error(`Failed to cleanup video ${video.processing_id}:`, deleteError);
          results.push({
            processing_id: video.processing_id,
            error: deleteError.message,
            deleted: false
          });
        }
      }

      return {
        dry_run: dryRun,
        files_found: oldVideos?.length || 0,
        files_processed: deletedCount,
        results
      };
    } catch (error) {
      logger.error('Error during cleanup', { error: error.message });
      throw error;
    }
  }

  // Health check
  async healthCheck() {
    try {
      const start = Date.now();
      
      // Test basic connectivity
      const { data, error } = await this.supabase
        .from('users')
        .select('count', { count: 'exact', head: true });

      if (error) {
        throw error;
      }

      const responseTime = Date.now() - start;

      // Test storage connectivity
      const storageStart = Date.now();
      const { data: buckets, error: storageError } = await this.serviceClient.storage.listBuckets();
      const storageResponseTime = Date.now() - storageStart;

      return {
        database: {
          connected: true,
          response_time_ms: responseTime,
          user_count: data?.length || 0
        },
        storage: {
          connected: !storageError,
          response_time_ms: storageError ? null : storageResponseTime,
          buckets_count: buckets?.length || 0,
          error: storageError?.message
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        database: {
          connected: false,
          error: error.message
        },
        storage: {
          connected: false,
          error: 'Database connection failed'
        },
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new SupabaseService();