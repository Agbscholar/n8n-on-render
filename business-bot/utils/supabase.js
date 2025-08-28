const { createClient } = require('@supabase/supabase-js');

class SupabaseDB {
  constructor() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }
    
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  // User management
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
      const { telegram_id, username, first_name } = userData;
      const referralCode = `REF${telegram_id}`;
      
      const { data, error } = await this.supabase
        .from('users')
        .upsert({
          telegram_id,
          username,
          first_name,
          referral_code: referralCode,
          subscription_type: 'free',
          daily_usage: 0,
          total_usage: 0,
          referred_users: 0
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  }

  async updateUser(telegramId, updates) {
    try {
      const { data, error } = await this.supabase
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
      console.error('Error updating user:', error);
      throw error;
    }
  }

  async canUseService(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) return false;
      
      // Premium/Pro users have unlimited access if subscription is valid
      if (user.subscription_type === 'premium' || user.subscription_type === 'pro') {
        if (user.subscription_expires && new Date() < new Date(user.subscription_expires)) {
          return true;
        } else if (user.subscription_expires && new Date() >= new Date(user.subscription_expires)) {
          // Subscription expired, downgrade to free
          await this.updateUser(telegramId, {
            subscription_type: 'free',
            subscription_expires: null
          });
        }
      }
      
      // Free users have daily limits
      return user.daily_usage < 3;
    } catch (error) {
      console.error('Error checking service usage:', error);
      return false;
    }
  }

async incrementUsage(telegramId) {
  try {
    const { data, error } = await this.supabase
      .rpc('increment_usage', { user_telegram_id: telegramId });

    if (error) throw error;
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
          daily_usage: this.supabase.raw('GREATEST(daily_usage - 1, 0)'),
          total_usage: this.supabase.raw('GREATEST(total_usage - 1, 0)'),
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) throw error;
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
        .update({ daily_usage: 0, updated_at: new Date().toISOString() })
        .neq('daily_usage', 0);

      if (error) throw error;
      console.log(`Reset daily usage for ${data?.length || 0} users`);
      return data;
    } catch (error) {
      console.error('Error resetting daily usage:', error);
      throw error;
    }
  }

  // Video management
  async createVideo(videoData) {
    try {
      const { data, error } = await this.supabase
        .from('videos')
        .insert({
          processing_id: videoData.processing_id,
          telegram_id: videoData.telegram_id,
          original_url: videoData.video_url,
          platform: videoData.platform,
          title: videoData.title || null,
          status: 'processing'
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating video record:', error);
      throw error;
    }
  }

  async updateVideo(processingId, updates) {
    try {
      const { data, error } = await this.supabase
        .from('videos')
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
      console.error('Error updating video:', error);
      throw error;
    }
  }

  async getVideo(processingId) {
    try {
      const { data, error } = await this.supabase
        .from('videos')
        .select('*, shorts(*)')
        .eq('processing_id', processingId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error getting video:', error);
      return null;
    }
  }

  // Shorts management
  async createShort(shortData) {
    try {
      const { data, error } = await this.supabase
        .from('shorts')
        .insert(shortData)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating short:', error);
      throw error;
    }
  }

  async updateShort(shortId, updates) {
    try {
      const { data, error } = await this.supabase
        .from('shorts')
        .update(updates)
        .eq('short_id', shortId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error updating short:', error);
      throw error;
    }
  }

  // File storage methods
  async uploadFile(bucket, filePath, fileBuffer, contentType) {
    try {
      const { data, error } = await this.supabase.storage
        .from(bucket)
        .upload(filePath, fileBuffer, {
          contentType,
          upsert: true
        });

      if (error) throw error;
      
      // Get public URL
      const { data: { publicUrl } } = this.supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

      return {
        path: data.path,
        fullPath: data.fullPath,
        publicUrl
      };
    } catch (error) {
      console.error('Error uploading file:', error);
      throw error;
    }
  }

  async deleteFile(bucket, filePath) {
    try {
      const { data, error } = await this.supabase.storage
        .from(bucket)
        .remove([filePath]);

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error deleting file:', error);
      throw error;
    }
  }

  // Usage logging
  async logUsage(logData) {
    try {
      const { data, error } = await this.supabase
        .from('usage_logs')
        .insert({
          telegram_id: logData.telegram_id,
          video_id: logData.video_id || null,
          processing_id: logData.processing_id || null,
          action: logData.action,
          platform: logData.platform || null,
          processing_time: logData.processing_time || null,
          success: logData.success !== false,
          error_message: logData.error_message || null
        });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error logging usage:', error);
      // Don't throw error for logging failures
      return null;
    }
  }

  // Analytics methods
  async getStats() {
    try {
      // Get user counts by subscription type
      const { data: userStats, error: userError } = await this.supabase
        .from('users')
        .select('subscription_type');

      if (userError) throw userError;

      // Get total videos processed
      const { data: videoStats, error: videoError } = await this.supabase
        .from('videos')
        .select('status');

      if (videoError) throw videoError;

      // Get recent activity
      const { data: recentLogs, error: logsError } = await this.supabase
        .from('usage_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (logsError) throw logsError;

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
        recent_activity: recentLogs
      };

      return stats;
    } catch (error) {
      console.error('Error getting stats:', error);
      throw error;
    }
  }

  // Cleanup old files (for maintenance)
  async cleanupOldFiles(daysOld = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const { data: oldVideos, error } = await this.supabase
        .from('videos')
        .select('file_path, thumbnail_path')
        .lt('created_at', cutoffDate.toISOString())
        .eq('status', 'completed');

      if (error) throw error;

      // Delete files from storage
      for (const video of oldVideos) {
        if (video.file_path) {
          await this.deleteFile('video-files', video.file_path).catch(console.error);
        }
        if (video.thumbnail_path) {
          await this.deleteFile('thumbnails', video.thumbnail_path).catch(console.error);
        }
      }

      console.log(`Cleaned up ${oldVideos.length} old video files`);
      return oldVideos.length;
    } catch (error) {
      console.error('Error cleaning up old files:', error);
      throw error;
    }
  }
}

module.exports = new SupabaseDB();