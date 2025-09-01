const { createClient } = require('@supabase/supabase-js');

class SupabaseDB {
  constructor() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }
    
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  }

  // Test connection
  async testConnection() {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .select('telegram_id')
        .limit(1);
      
      if (error) {
        console.error('Supabase connection test failed:', error);
        return false;
      }
      
      console.log('Supabase connection successful');
      return true;
    } catch (error) {
      console.error('Supabase connection error:', error);
      return false;
    }
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
        console.error('Error getting user:', error);
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
          videos_processed: 0,
          shorts_generated: 0,
          settings: {},
          metadata: {}
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating user:', error);
        throw error;
      }
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

      if (error) {
        console.error('Error updating user:', error);
        throw error;
      }
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
        if (user.subscription_expires_at && new Date() < new Date(user.subscription_expires_at)) {
          return true;
        } else if (user.subscription_expires_at && new Date() >= new Date(user.subscription_expires_at)) {
          // Subscription expired, downgrade to free
          await this.updateUser(telegramId, {
            subscription_type: 'free',
            subscription_expires_at: null
          });
        }
      }
      
      // For free users, check daily usage (assuming 3 videos per day limit)
      // Since there's no daily_usage field in the schema, we'll count today's videos
      const today = new Date().toISOString().split('T')[0];
      const { data: todayVideos, error } = await this.supabase
        .from('video_processing')
        .select('id')
        .eq('telegram_id', telegramId)
        .gte('created_at', `${today}T00:00:00Z`)
        .eq('status', 'completed');

      if (error) {
        console.error('Error checking daily usage:', error);
        return false;
      }

      return (todayVideos?.length || 0) < 3;
    } catch (error) {
      console.error('Error checking service usage:', error);
      return false;
    }
  }

  async incrementUsage(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) throw new Error('User not found');

      const { data, error } = await this.supabase
        .from('users')
        .update({
          videos_processed: user.videos_processed + 1,
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', telegramId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error incrementing usage:', error);
      throw error;
    }
  }

  async decrementUsage(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) throw new Error('User not found');

      const { data, error } = await this.supabase
        .from('users')
        .update({
          videos_processed: Math.max(user.videos_processed - 1, 0),
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
      // Since there's no daily_usage field, this is a no-op
      // Daily usage is calculated dynamically from video_processing table
      console.log('Daily usage reset completed (calculated dynamically)');
      return [];
    } catch (error) {
      console.error('Error resetting daily usage:', error);
      throw error;
    }
  }

  // Video management - Fixed to use correct table names
  async createVideo(videoData) {
    try {
      const { data, error } = await this.supabase
        .from('video_processing')
        .insert({
          processing_id: videoData.processing_id,
          user_id: videoData.user_id, // Will need to get this from users table
          telegram_id: videoData.telegram_id,
          original_url: videoData.video_url,
          platform: videoData.platform,
          status: 'processing',
          subscription_type: videoData.subscription_type || 'free',
          video_info: {},
          shorts_segments: [],
          total_shorts: 0,
          shorts_generated: 0,
          metadata: {}
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

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error getting video:', error);
      return null;
    }
  }

  // Shorts management - Fixed to use correct table name
  async createShort(shortData) {
    try {
      const { data, error } = await this.supabase
        .from('short_videos')
        .insert({
          short_id: shortData.short_id,
          video_processing_id: shortData.video_id, // Maps to video_processing.id
          user_id: shortData.user_id, // Will need user UUID
          title: shortData.title,
          description: shortData.description,
          duration: shortData.duration,
          quality: shortData.quality || '720p',
          file_url: shortData.file_url,
          thumbnail_url: shortData.thumbnail_url,
          storage_path: shortData.storage_path,
          thumbnail_path: shortData.thumbnail_path,
          file_size_mb: shortData.file_size,
          status: 'completed',
          features_applied: shortData.features_applied || [],
          metadata: shortData.metadata || {}
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating short:', error);
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
          error_message: logData.error_message || null,
          shorts_generated: logData.shorts_generated || 0,
          total_shorts: logData.total_shorts || 0,
          file_size_mb: logData.file_size_mb || null
        });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error logging usage:', error);
      return null;
    }
  }

  // Analytics methods
  async getStats() {
    try {
      const { data: userStats, error: userError } = await this.supabase
        .from('users')
        .select('subscription_type');

      if (userError) throw userError;

      const { data: videoStats, error: videoError } = await this.supabase
        .from('video_processing')
        .select('status');

      if (videoError) throw videoError;

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
        }
      };

      return stats;
    } catch (error) {
      console.error('Error getting stats:', error);
      throw error;
    }
  }

  // Cleanup old files
  async cleanupOldFiles(daysOld = 7, dryRun = false) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const { data: oldFiles, error } = await this.supabase
        .from('storage_files')
        .select('file_path, bucket_name')
        .lt('created_at', cutoffDate.toISOString());

      if (error) throw error;

      if (!dryRun) {
        for (const file of oldFiles) {
          await this.deleteFile(file.bucket_name, file.file_path).catch(console.error);
        }
      }

      console.log(`${dryRun ? 'Would clean up' : 'Cleaned up'} ${oldFiles.length} old files`);
      return oldFiles.length;
    } catch (error) {
      console.error('Error cleaning up old files:', error);
      throw error;
    }
  }

  // Add method to get storage usage
  async getStorageUsage() {
    try {
      const { data: files, error } = await this.supabase
        .from('storage_files')
        .select('file_size_bytes');

      if (error) throw error;

      const totalBytes = files.reduce((sum, file) => sum + (file.file_size_bytes || 0), 0);
      
      return {
        total_size_bytes: totalBytes,
        total_size_mb: (totalBytes / 1024 / 1024).toFixed(2),
        total_size_gb: (totalBytes / 1024 / 1024 / 1024).toFixed(2),
        file_count: files.length
      };
    } catch (error) {
      console.error('Error getting storage usage:', error);
      return { total_size_gb: 0, file_count: 0 };
    }
  }
}

// Initialize and test connection
const supabaseDB = new SupabaseDB();

// Test connection on startup
supabaseDB.testConnection().then(success => {
  if (!success) {
    console.error('Failed to connect to Supabase - check your environment variables');
    // Don't exit in production, just log the error
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
});

module.exports = supabaseDB;