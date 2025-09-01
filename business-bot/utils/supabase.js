const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
});

class DatabaseService {
  constructor() {
    this.supabase = supabase;
  }

  // USERS METHODS
  async getUser(telegramId) {
    try {
      const { data, error } = await supabase
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
      throw error;
    }
  }

  async createUser(userData) {
    try {
      // Generate referral code
      const referralCode = `REF${userData.telegram_id}`;
      
      const { data, error } = await supabase
        .from('users')
        .insert([{
          telegram_id: userData.telegram_id,
          username: userData.username,
          first_name: userData.first_name,
          subscription_type: 'free',
          daily_usage: 0,
          total_usage: 0,
          referral_code: referralCode,
          referred_users: 0
        }])
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
      const { data, error } = await supabase
        .from('users')
        .update({ ...updates, updated_at: new Date().toISOString() })
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

  // Usage checking and limits
  async canUseService(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) return false;

      // Premium and Pro users have unlimited access
      if (user.subscription_type !== 'free') return true;

      // Free users: check daily limit
      const { data: todayUsage, error } = await supabase
        .from('usage_logs')
        .select('id')
        .eq('telegram_id', telegramId)
        .eq('action', 'video_processing_completed')
        .eq('success', true)
        .gte('created_at', new Date().toISOString().split('T')[0] + 'T00:00:00.000Z')
        .lt('created_at', new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0] + 'T00:00:00.000Z');

      if (error) throw error;

      return (todayUsage?.length || 0) < 3; // Free limit is 3 per day
    } catch (error) {
      console.error('Error checking service usage:', error);
      return false;
    }
  }

  async incrementUsage(telegramId) {
    try {
      const { data, error } = await supabase
        .from('users')
        .update({ 
          daily_usage: supabase.raw('daily_usage + 1'),
          total_usage: supabase.raw('total_usage + 1'),
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
      const { data, error } = await supabase
        .from('users')
        .update({ 
          daily_usage: supabase.raw('GREATEST(daily_usage - 1, 0)'),
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
      const { data, error } = await supabase
        .from('users')
        .update({ 
          daily_usage: 0,
          updated_at: new Date().toISOString()
        })
        .neq('daily_usage', 0); // Only update users with non-zero usage

      if (error) throw error;
      console.log('Daily usage reset completed');
      return data;
    } catch (error) {
      console.error('Error resetting daily usage:', error);
      throw error;
    }
  }

  // VIDEO PROCESSING METHODS (Updated for current schema)
  async createVideo(videoData) {
    try {
      // Get user ID first
      const user = await this.getUser(videoData.telegram_id);
      if (!user) throw new Error('User not found');

      const { data, error } = await supabase
        .from('video_processing')
        .insert([{
          processing_id: videoData.processing_id,
          user_id: user.id,
          telegram_id: videoData.telegram_id,
          original_url: videoData.video_url,
          platform: videoData.platform,
          status: 'processing',
          subscription_type: user.subscription_type
        }])
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
      const { data, error } = await supabase
        .from('video_processing')
        .update({ ...updates, updated_at: new Date().toISOString() })
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
      const { data, error } = await supabase
        .from('video_processing')
        .select('*')
        .eq('processing_id', processingId)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error getting video:', error);
      throw error;
    }
  }

  // SHORT VIDEOS METHODS (Updated for current schema)
  async createShort(shortData) {
    try {
      const { data, error } = await supabase
        .from('short_videos')
        .insert([{
          short_id: shortData.short_id,
          video_processing_id: shortData.video_id, // Map to correct column
          user_id: shortData.user_id || (await this.getVideo(shortData.processing_id))?.user_id,
          title: shortData.title,
          duration: shortData.duration,
          quality: shortData.quality,
          file_url: shortData.file_url,
          thumbnail_url: shortData.thumbnail_url,
          file_size_mb: shortData.file_size ? parseFloat(shortData.file_size) / (1024 * 1024) : null,
          features_applied: shortData.features_applied || [],
          status: 'completed'
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error creating short:', error);
      throw error;
    }
  }

  // USAGE LOGS METHODS (Fixed to match current schema)
  async logUsage(logData) {
    try {
      const { data, error } = await supabase
        .from('usage_logs')
        .insert([{
          telegram_id: logData.telegram_id,
          video_id: logData.video_id || null,
          processing_id: logData.processing_id || null,
          action: logData.action,
          platform: logData.platform || null,
          processing_time: logData.processing_time || null,
          success: logData.success !== false,
          error_message: logData.error_message || null,
          shorts_generated: logData.shorts_generated || 0
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error logging usage:', error);
      // Don't throw - logging failures shouldn't break main flow
      return null;
    }
  }

  // REFERRAL SYSTEM
  async processReferral(referrerId, newUserId) {
    try {
      const { data: referrer } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', referrerId)
        .single();

      if (referrer) {
        await supabase
          .from('users')
          .update({ 
            referred_users: supabase.raw('referred_users + 1'),
            updated_at: new Date().toISOString()
          })
          .eq('telegram_id', referrerId);

        await this.logUsage({
          telegram_id: newUserId,
          action: 'referral_processed',
          success: true,
          metadata: { referrer_id: referrerId }
        });
      }
    } catch (error) {
      console.error('Error processing referral:', error);
      throw error;
    }
  }

  // STORAGE METHODS
  async uploadFile(bucketName, filePath, fileBuffer, contentType) {
    try {
      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(filePath, fileBuffer, {
          contentType: contentType,
          duplex: 'half'
        });

      if (error) throw error;

      const { data: publicData } = supabase.storage
        .from(bucketName)
        .getPublicUrl(filePath);

      return {
        ...data,
        publicUrl: publicData.publicUrl
      };
    } catch (error) {
      console.error('Error uploading file:', error);
      throw error;
    }
  }

  // STATISTICS AND ANALYTICS
  async getStats() {
    try {
      const [usersResult, videosResult, usageResult] = await Promise.all([
        supabase
          .from('users')
          .select('subscription_type')
          .not('subscription_type', 'is', null),
        supabase
          .from('video_processing')
          .select('status'),
        supabase
          .from('usage_logs')
          .select('success, created_at')
          .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())
      ]);

      const users = usersResult.data || [];
      const videos = videosResult.data || [];
      const usage = usageResult.data || [];

      return {
        users: {
          total: users.length,
          free: users.filter(u => u.subscription_type === 'free').length,
          premium: users.filter(u => u.subscription_type === 'premium').length,
          pro: users.filter(u => u.subscription_type === 'pro').length,
          active_today: usage.length
        },
        videos: {
          total: videos.length,
          completed: videos.filter(v => v.status === 'completed').length,
          processing: videos.filter(v => v.status === 'processing').length,
          failed: videos.filter(v => v.status === 'failed').length
        },
        usage: {
          today_total: usage.length,
          today_success: usage.filter(u => u.success).length,
          today_failed: usage.filter(u => !u.success).length
        }
      };
    } catch (error) {
      console.error('Error getting stats:', error);
      return {
        users: { total: 0, free: 0, premium: 0, pro: 0, active_today: 0 },
        videos: { total: 0, completed: 0, processing: 0, failed: 0 },
        usage: { today_total: 0, today_success: 0, today_failed: 0 }
      };
    }
  }

  async getStorageUsage() {
    try {
      const { data: videoFiles, error: videoError } = await supabase.storage
        .from('video-files')
        .list('', { limit: 1000 });

      const { data: thumbnailFiles, error: thumbnailError } = await supabase.storage
        .from('thumbnails')
        .list('', { limit: 1000 });

      if (videoError || thumbnailError) {
        throw new Error(videoError?.message || thumbnailError?.message);
      }

      const videoSize = (videoFiles || []).reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
      const thumbnailSize = (thumbnailFiles || []).reduce((sum, file) => sum + (file.metadata?.size || 0), 0);
      const totalSize = videoSize + thumbnailSize;

      return {
        video_files: videoFiles?.length || 0,
        thumbnail_files: thumbnailFiles?.length || 0,
        total_files: (videoFiles?.length || 0) + (thumbnailFiles?.length || 0),
        total_size_bytes: totalSize,
        total_size_mb: (totalSize / (1024 * 1024)).toFixed(2),
        total_size_gb: (totalSize / (1024 * 1024 * 1024)).toFixed(3)
      };
    } catch (error) {
      console.error('Error getting storage usage:', error);
      return null;
    }
  }

  // CLEANUP METHODS
  async cleanupOldFiles(days = 7, dryRun = false) {
    try {
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      
      const { data: oldVideos, error } = await supabase
        .from('video_processing')
        .select('id, processing_id')
        .lt('created_at', cutoffDate.toISOString())
        .eq('status', 'completed');

      if (error) throw error;

      let deletedCount = 0;

      for (const video of oldVideos || []) {
        try {
          if (!dryRun) {
            // Delete from storage
            await supabase.storage
              .from('video-files')
              .remove([`videos/${video.processing_id}/`]);
            
            await supabase.storage
              .from('thumbnails')
              .remove([`thumbnails/${video.processing_id}/`]);

            // Delete database records
            await supabase
              .from('short_videos')
              .delete()
              .eq('video_processing_id', video.id);
            
            await supabase
              .from('video_processing')
              .delete()
              .eq('id', video.id);
          }
          
          deletedCount++;
        } catch (fileError) {
          console.warn(`Failed to cleanup video ${video.processing_id}:`, fileError);
        }
      }

      return deletedCount;
    } catch (error) {
      console.error('Error during cleanup:', error);
      throw error;
    }
  }

  // Connection management
  async close() {
    // Supabase client doesn't need explicit closing
    console.log('Database connection closed');
  }
}

module.exports = new DatabaseService();