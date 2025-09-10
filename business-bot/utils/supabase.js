const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const path = require('path');

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
        },
        global: {
          headers: {
            'Content-Type': 'application/json'
          }
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

  // Initialize storage buckets
  async initializeStorage() {
    const buckets = [
      { name: 'video-files', public: true },
      { name: 'processed-shorts', public: true },
      { name: 'thumbnails', public: true },
      { name: 'temp-files', public: false }
    ];
    
    for (const bucket of buckets) {
      try {
        const { data, error } = await this.supabase.storage.createBucket(bucket.name, {
          public: bucket.public
        });
        
        if (error && !error.message.includes('already exists')) {
          console.error(`Error creating bucket ${bucket.name}:`, error);
        } else {
          console.log(`Bucket ${bucket.name} ready`);
        }
      } catch (error) {
        console.error(`Failed to initialize bucket ${bucket.name}:`, error);
      }
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
          daily_usage: 0,
          total_usage: 0,
          referred_users: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
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
      // First try using RPC function
      const { data: rpcData, error: rpcError } = await this.supabase
        .rpc('increment_usage', { user_telegram_id: telegramId });

      if (!rpcError) {
        return rpcData;
      }

      // Fallback to manual increment
      console.log('RPC failed, using manual increment');
      const user = await this.getUser(telegramId);
      if (!user) throw new Error('User not found');

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
      console.error('Error decrementing usage:', error);
      throw error;
    }
  }

  async resetDailyUsage() {
    try {
      const { data, error } = await this.supabase
        .from('users')
        .update({ 
          daily_usage: 0, 
          updated_at: new Date().toISOString() 
        })
        .neq('daily_usage', 0)
        .select();

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
        .from('video_processing')
        .insert({
          processing_id: videoData.processing_id,
          user_id: videoData.user_id,
          telegram_id: videoData.telegram_id,
          original_url: videoData.video_url,
          platform: videoData.platform,
          title: videoData.title || null,
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
        .select('*, short_videos(*)')
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
      console.error('Error creating short:', error);
      throw error;
    }
  }

  async updateShort(shortId, updates) {
    try {
      const { data, error } = await this.supabase
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
          upsert: true,
          cacheControl: '3600'
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

  async createSignedUrl(bucket, filePath, expiresIn = 3600) {
    try {
      const { data, error } = await this.supabase.storage
        .from(bucket)
        .createSignedUrl(filePath, expiresIn);

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating signed URL:', error);
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
          file_size_bytes: logData.file_size_bytes || null,
          created_at: new Date().toISOString()
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
        .from('video_processing')
        .select('status');

      if (videoError) throw videoError;

      // Get storage usage
      const storageUsage = await this.getStorageUsage();

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
      console.error('Error getting stats:', error);
      throw error;
    }
  }

  async getStorageUsage() {
    try {
      const buckets = ['video-files', 'processed-shorts', 'thumbnails'];
      let totalSize = 0;
      let fileCount = 0;
      
      for (const bucket of buckets) {
        try {
          const { data, error } = await this.supabase.storage
            .from(bucket)
            .list();
          
          if (!error && data) {
            fileCount += data.length;
            // Calculate size (this is approximate as we'd need to get each file's metadata)
            totalSize += data.length * 5 * 1024 * 1024; // Estimate 5MB per file
          }
        } catch (bucketError) {
          console.error(`Error listing bucket ${bucket}:`, bucketError);
        }
      }
      
      return {
        total_size_bytes: totalSize,
        total_size_mb: (totalSize / 1024 / 1024).toFixed(2),
        total_size_gb: (totalSize / 1024 / 1024 / 1024).toFixed(2),
        file_count: fileCount
      };
    } catch (error) {
      console.error('Error getting storage usage:', error);
      return {
        total_size_bytes: 0,
        total_size_mb: 0,
        total_size_gb: 0,
        file_count: 0
      };
    }
  }

  // Cleanup old files (for maintenance)
  async cleanupOldFiles(daysOld = 7, dryRun = true) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const { data: oldVideos, error } = await this.supabase
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
            await this.deleteFile(video.storage_bucket, video.file_path).catch(console.error);
            deletedCount++;
          }
          if (video.thumbnail_path) {
            await this.deleteFile('thumbnails', video.thumbnail_path).catch(console.error);
            deletedCount++;
          }
        }
      }

      console.log(`Would clean up ${oldVideos.length} old video files (dry run: ${dryRun})`);
      return {
        dry_run: dryRun,
        files_found: oldVideos.length,
        files_deleted: dryRun ? 0 : deletedCount
      };
    } catch (error) {
      console.error('Error cleaning up old files:', error);
      throw error;
    }
  }

  // Close connection (if needed)
  async close() {
    // Supabase JS client doesn't have a close method
    return true;
  }
}

// Initialize and test connection
const supabaseDB = new SupabaseDB();

// Test connection on startup
supabaseDB.testConnection().then(success => {
  if (success) {
    console.log('Supabase connection successful');
    // Initialize storage buckets
    supabaseDB.initializeStorage().catch(console.error);
  } else {
    console.error('Failed to connect to Supabase - check your environment variables');
  }
});

module.exports = supabaseDB;