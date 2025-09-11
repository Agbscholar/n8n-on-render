const { createClient } = require('@supabase/supabase-js');

class SupabaseService {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    
    this.serviceClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  // User operations
  async getUser(telegramId) {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        throw error;
      }
      
      return data;
    } catch (error) {
      console.error('Error getting user:', error);
      return null;
    }
  }

  async createUser(userData) {
    try {
      const userRecord = {
        telegram_id: userData.telegram_id,
        username: userData.username || null,
        first_name: userData.first_name || null,
        subscription_type: 'free',
        daily_usage: 0,
        total_usage: 0,
        referral_code: `REF${userData.telegram_id}`,
        referred_users: 0,
        created_at: new Date().toISOString()
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
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  }

  // FIXED: Video operations with correct field names
async createVideo(videoData) {
  try {
    // Get user UUID from telegram_id
    const user = await this.getUser(videoData.telegram_id);
    if (!user) {
      throw new Error('User not found');
    }

    const videoRecord = {
      processing_id: videoData.processing_id,
      user_id: user.id, // Add this line
      telegram_id: videoData.telegram_id,
      original_url: videoData.video_url,
      platform: videoData.platform,
      subscription_type: videoData.subscription_type || 'free',
      status: 'processing',
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
  } catch (error) {
    console.error('Error creating video record:', error);
    throw error;
  }
}

  async updateVideo(processingId, updateData) {
    try {
      const { data, error } = await this.supabase
        .from('video_processing')
        .update(updateData)
        .eq('processing_id', processingId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error updating video:', error);
      throw error;
    }
  }

  async getVideo(processingId) {
    try {
      const { data, error } = await this.supabase
        .from('video_processing')
        .select('*')
        .eq('processing_id', processingId)
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error getting video:', error);
      return null;
    }
  }

  // Short video operations
  async createShort(shortData) {
    try {
      const { data, error } = await this.supabase
        .from('short_videos')
        .insert([shortData])
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error creating short:', error);
      throw error;
    }
  }

  // Usage operations
  async canUseService(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) return false;

      // Premium and Pro users have unlimited usage
      if (['premium', 'pro'].includes(user.subscription_type)) {
        return true;
      }

      // Free users limited to 3 per day
      return user.daily_usage < 3;
    } catch (error) {
      console.error('Error checking service usage:', error);
      return false;
    }
  }

  async incrementUsage(telegramId) {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .update({
          daily_usage: this.supabase.sql`daily_usage + 1`,
          total_usage: this.supabase.sql`total_usage + 1`
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error incrementing usage:', error);
      throw error;
    }
  }

  async decrementUsage(telegramId) {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .update({
          daily_usage: this.supabase.sql`GREATEST(daily_usage - 1, 0)`,
          total_usage: this.supabase.sql`GREATEST(total_usage - 1, 0)`
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error decrementing usage:', error);
      throw error;
    }
  }

  async resetDailyUsage() {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .update({ daily_usage: 0 })
        .neq('daily_usage', 0);

      if (error) {
        throw error;
      }

      console.log(`Reset daily usage for ${data?.length || 0} users`);
      return data;
    } catch (error) {
      console.error('Error resetting daily usage:', error);
      throw error;
    }
  }

  // Usage logging
  async logUsage(logData) {
    try {
      const logRecord = {
        telegram_id: logData.telegram_id,
        video_id: logData.video_id || null,
        processing_id: logData.processing_id || null,
        action: logData.action,
        platform: logData.platform || null,
        success: logData.success || false,
        error_message: logData.error_message || null,
        processing_time: logData.processing_time || null,
        shorts_generated: logData.shorts_generated || 0,
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
    } catch (error) {
      console.error('Error logging usage:', error);
      // Don't throw - logging failures shouldn't break main functionality
      return null;
    }
  }

  // Referral operations
  async processReferral(referrerId, newUserId) {
    try {
      // Check if referral already processed
      const existingUser = await this.getUser(newUserId);
      if (existingUser && existingUser.referred_by) {
        return false; // Already referred by someone
      }

      // Update new user with referrer
      await this.supabase
        .from('users')
        .update({ referred_by: referrerId })
        .eq('telegram_id', newUserId);

      // Increment referrer's count
      await this.supabase
        .from('users')
        .update({
          referred_users: this.supabase.sql`referred_users + 1`
        })
        .eq('telegram_id', referrerId);

      return true;
    } catch (error) {
      console.error('Error processing referral:', error);
      throw error;
    }
  }

  // File operations
  async uploadFile(bucket, filePath, fileBuffer, contentType) {
    try {
      const { data, error } = await this.serviceClient.storage
        .from(bucket)
        .upload(filePath, fileBuffer, {
          contentType,
          upsert: true
        });

      if (error) {
        throw error;
      }

      // Get public URL
      const { data: { publicUrl } } = this.serviceClient.storage
        .from(bucket)
        .getPublicUrl(filePath);

      return { ...data, publicUrl };
    } catch (error) {
      console.error('Error uploading file:', error);
      throw error;
    }
  }

  // Statistics
  async getStats() {
    try {
      const [usersResult, videosResult] = await Promise.all([
        this.supabase
          .from('users')
          .select('subscription_type', { count: 'exact' }),
        this.supabase
          .from('video_processing')
          .select('status', { count: 'exact' })
      ]);

      const userStats = {
        total: usersResult.count || 0,
        free: usersResult.data?.filter(u => u.subscription_type === 'free').length || 0,
        premium: usersResult.data?.filter(u => u.subscription_type === 'premium').length || 0,
        pro: usersResult.data?.filter(u => u.subscription_type === 'pro').length || 0
      };

      const videoStats = {
        total: videosResult.count || 0,
        completed: videosResult.data?.filter(v => v.status === 'completed').length || 0,
        processing: videosResult.data?.filter(v => v.status === 'processing').length || 0,
        failed: videosResult.data?.filter(v => v.status === 'failed').length || 0
      };

      return {
        users: userStats,
        videos: videoStats
      };
    } catch (error) {
      console.error('Error getting stats:', error);
      return {
        users: { total: 0, free: 0, premium: 0, pro: 0 },
        videos: { total: 0, completed: 0, processing: 0, failed: 0 }
      };
    }
  }

  // Storage usage
  async getStorageUsage() {
    try {
      const [videoFiles, thumbnailFiles] = await Promise.all([
        this.serviceClient.storage.from('video-files').list('', { limit: 1000 }),
        this.serviceClient.storage.from('thumbnails').list('', { limit: 1000 })
      ]);

      const videoSize = videoFiles.data?.reduce((sum, file) => sum + (file.metadata?.size || 0), 0) || 0;
      const thumbnailSize = thumbnailFiles.data?.reduce((sum, file) => sum + (file.metadata?.size || 0), 0) || 0;
      const totalSize = videoSize + thumbnailSize;

      return {
        total_size_bytes: totalSize,
        total_size_gb: (totalSize / 1024 / 1024 / 1024).toFixed(3),
        video_files: videoFiles.data?.length || 0,
        thumbnails: thumbnailFiles.data?.length || 0
      };
    } catch (error) {
      console.error('Error getting storage usage:', error);
      return {
        total_size_bytes: 0,
        total_size_gb: '0.000',
        video_files: 0,
        thumbnails: 0
      };
    }
  }

  // Cleanup operations
  async cleanupOldFiles(days = 7, dryRun = false) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const { data: oldVideos, error } = await this.supabase
        .from('video_processing')
        .select('id, file_path, thumbnail_path')
        .lt('created_at', cutoffDate.toISOString());

      if (error) {
        throw error;
      }

      let deletedCount = 0;

      for (const video of oldVideos || []) {
        if (!dryRun) {
          // Delete files from storage
          if (video.file_path) {
            await this.serviceClient.storage
              .from('video-files')
              .remove([video.file_path]);
          }

          if (video.thumbnail_path) {
            await this.serviceClient.storage
              .from('thumbnails')
              .remove([video.thumbnail_path]);
          }

          // Update database record
          await this.supabase
            .from('video_processing')
            .update({ 
              file_path: null, 
              thumbnail_path: null,
              file_url: null,
              thumbnail_url: null 
            })
            .eq('id', video.id);
        }

        deletedCount++;
      }

      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up old files:', error);
      return 0;
    }
  }
}

module.exports = new SupabaseService();