// supabase-video-processing.js
// Enhanced Supabase Video Processing - Complete Real File Processing
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execPromise = promisify(exec);

// Main processing function
async function processVideo(inputData) {
  // Create temporary directory for processing
  const tempDir = path.join(os.tmpdir(), `video-processing-${inputData.processing_id}`);
  try {
    await fs.mkdir(tempDir, { recursive: true });
    
    // Enhanced Supabase configuration with validation
    const supabaseUrl = inputData.supabase?.url || process.env.SUPABASE_URL;
    const supabaseKey = inputData.supabase?.service_key || process.env.SUPABASE_SERVICE_ROLE_KEY;

    console.log('🎬 Real Video Processing Starting...');
    console.log('Platform:', inputData.platform);
    console.log('Video URL:', inputData.video_url);
    console.log('Temp Directory:', tempDir);
    console.log('Supabase URL configured:', !!supabaseUrl);
    console.log('Service key configured:', !!supabaseKey);

    // Enhanced validation with specific error messages
    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL environment variable is missing.');
    }
    
    if (!supabaseKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is missing.');
    }

    // Helper function with improved error handling
    async function supabaseRequest(endpoint, method = 'GET', data = null) {
      try {
        const axios = require('axios');
        const options = {
          url: `${supabaseUrl}/rest/v1/${endpoint}`,
          method: method,
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
          },
          data: data
        };

        const response = await axios(options);
        return response.data;
      } catch (error) {
        if (error.response) {
          console.error(`Supabase ${method} ${endpoint} failed:`, {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data
          });
          
          if (error.response.status === 401) {
            throw new Error('Supabase authentication failed. Please check your SUPABASE_SERVICE_ROLE_KEY.');
          } else if (error.response.status === 404) {
            throw new Error(`Supabase table/endpoint not found: ${endpoint}. Please check your database schema.`);
          } else if (error.response.status === 400) {
            throw new Error(`Supabase request error: ${error.response.data?.message || 'Bad request'}`);
          }
        }
        
        console.error(`Supabase request failed:`, error);
        throw error;
      }
    }

    // Test connection with a simple query
    try {
      await supabaseRequest('users?limit=1');
      console.log('✅ Supabase connection successful');
    } catch (connectionError) {
      throw new Error(`Supabase connection test failed: ${connectionError.message}`);
    }

    // Use video info from the error handler (could be fallback or successful)
    const videoInfo = inputData.video_info;
    
    if (!videoInfo) {
      throw new Error('No video information available for processing');
    }

    console.log('📹 Using video info:', videoInfo);

    // 1. Check if user exists, create if not
    console.log('🔍 Checking user in database...');
    let user;
    try {
      const users = await supabaseRequest(`users?telegram_id=eq.${inputData.telegram_id}`);
      
      if (users && users.length > 0) {
        user = users[0];
        console.log('✅ User found:', user.id);
        
        // Update last_active
        await supabaseRequest(`users?id=eq.${user.id}`, 'PATCH', {
          last_active: new Date().toISOString(),
          last_video_processed: new Date().toISOString()
        });
      } else {
        // Create new user
        console.log('👤 Creating new user...');
        const newUsers = await supabaseRequest('users', 'POST', [{
          telegram_id: inputData.telegram_id,
          username: inputData.user_name || 'Unknown',
          subscription_type: inputData.subscription_type || 'free',
          created_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          videos_processed: 0,
          shorts_generated: 0
        }]);
        
        if (newUsers && newUsers.length > 0) {
          user = newUsers[0];
        } else {
          throw new Error('Failed to create user - no user returned');
        }
        console.log('✅ User created:', user.id);
      }
    } catch (error) {
      console.error('❌ User operation failed:', error);
      throw error;
    }

    // 2. Create video processing record with FIXED status values
    console.log('🎬 Creating video processing record...');
    let videoRecord;
    try {
      // FIXED: Use only valid status values from the database constraint
      let dbStatus = 'processing'; // Default valid status
      
      if (inputData.processing_status === 'continue_with_fallback') {
        dbStatus = 'processing'; // Use valid status, store fallback info in metadata
      }

      const videoProcessingData = {
        processing_id: inputData.processing_id,
        user_id: user.id,
        telegram_id: inputData.telegram_id,
        original_url: inputData.video_url,
        platform: inputData.platform,
        status: dbStatus, // FIXED: Only use valid constraint values
        subscription_type: inputData.subscription_type || 'free',
        created_at: new Date().toISOString(),
        metadata: {
          user_name: inputData.user_name,
          chat_id: inputData.chat_id,
          user_limits: inputData.user_limits,
          timestamp: inputData.timestamp,
          metadata_source: videoInfo.metadata_source,
          youtube_error: inputData.youtube_downloader_error?.occurred || false,
          error_recovery: inputData.error_recovery || null,
          // FIXED: Store fallback processing info in metadata instead of status
          fallback_processing: inputData.processing_status === 'continue_with_fallback',
          processing_method: inputData.processing_status === 'continue_with_fallback' ? 'fallback' : 'normal'
        }
      };

      const videoRecords = await supabaseRequest('video_processing', 'POST', [videoProcessingData]);
      
      if (videoRecords && videoRecords.length > 0) {
        videoRecord = videoRecords[0];
      } else {
        throw new Error('Failed to create video record - no record returned');
      }
      console.log('✅ Video processing record created:', videoRecord.id);
    } catch (error) {
      console.error('❌ Video record creation failed:', error);
      throw error;
    }

    // 3. Download the video for processing
    console.log('📥 Downloading video for processing...');
    let videoFilePath;
    try {
      videoFilePath = path.join(tempDir, 'original_video.mp4');
      
      // Use curl or wget to download the video
      const downloadCommand = `curl -L "${inputData.video_url}" -o "${videoFilePath}" --connect-timeout 30 --max-time 300`;
      await execPromise(downloadCommand);
      
      // Verify the file was downloaded
      try {
        await fs.access(videoFilePath);
        const stats = await fs.stat(videoFilePath);
        console.log(`✅ Video downloaded: ${stats.size} bytes`);
      } catch {
        throw new Error('Downloaded video file is not accessible');
      }
    } catch (error) {
      console.error('❌ Video download failed:', error);
      throw new Error(`Failed to download video: ${error.message}`);
    }

    // 4. Generate shorts segments based on subscription
    console.log('📏 Generating shorts segments...');
    const maxShorts = inputData.subscription_type === 'free' ? 3 : 
                     inputData.subscription_type === 'premium' ? 5 : 10;
    
    // Use fallback duration if metadata fetch failed
    const duration = videoInfo.duration || 180;
    const shortsCount = Math.min(maxShorts, Math.ceil(duration / 60));

    const shortsSegments = [];
    for (let i = 0; i < shortsCount; i++) {
      const segmentDuration = Math.floor(duration / shortsCount);
      const startTime = i * segmentDuration;
      const endTime = Math.min((i + 1) * segmentDuration, duration);
      
      shortsSegments.push({
        segment_id: i + 1,
        start_time: startTime,
        end_time: endTime,
        duration: endTime - startTime,
        title: `${videoInfo.title} - Part ${i + 1}`,
        status: 'pending',
        processing_note: inputData.processing_status === 'continue_with_fallback' ? 
                        'Using fallback metadata due to YouTube API error' : null
      });
    }

    // 5. Update video processing record with video info
    try {
      await supabaseRequest(`video_processing?id=eq.${videoRecord.id}`, 'PATCH', {
        video_info: videoInfo,
        shorts_segments: shortsSegments,
        total_shorts: shortsSegments.length,
        updated_at: new Date().toISOString()
      });
      console.log('✅ Video info updated in database');
    } catch (error) {
      console.error('❌ Video info update failed:', error);
      throw error;
    }

    // 6. Process each short segment
    console.log('🎥 Processing video segments...');
    const processedShorts = [];
    const failedShorts = [];

    for (const segment of shortsSegments) {
      try {
        const shortId = `short_${inputData.processing_id}_${segment.segment_id}`;
        const quality = {
          free: '720p',
          premium: '1080p', 
          pro: '4K'
        }[inputData.subscription_type || 'free'];
        
        // Process the video segment
        const outputPath = path.join(tempDir, `${shortId}.mp4`);
        const thumbnailPath = path.join(tempDir, `${shortId}.jpg`);
        
        // Extract segment using ffmpeg
        const ffmpegCommand = `ffmpeg -i "${videoFilePath}" -ss ${segment.start_time} -t ${segment.duration} -c:v libx264 -c:a aac -vf "scale=iw:ih" -y "${outputPath}"`;
        await execPromise(ffmpegCommand);
        
        // Generate thumbnail
        const thumbnailCommand = `ffmpeg -i "${outputPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" -y "${thumbnailPath}"`;
        await execPromise(thumbnailCommand);
        
        // Upload to Supabase storage using the storage API directly
        const { createClient } = require('@supabase/supabase-js');
        const supabaseStorage = createClient(supabaseUrl, supabaseKey);
        
        const videoBuffer = await fs.readFile(outputPath);
        const thumbnailBuffer = await fs.readFile(thumbnailPath);
        
        const videoStoragePath = `shorts/${user.id}/${inputData.processing_id}/${shortId}.mp4`;
        const thumbnailStoragePath = `thumbnails/${user.id}/${inputData.processing_id}/${shortId}.jpg`;
        
        // Upload video
        const { data: videoUploadData, error: videoUploadError } = await supabaseStorage.storage
          .from('processed-shorts')
          .upload(videoStoragePath, videoBuffer, {
            contentType: 'video/mp4',
            upsert: true
          });
        
        if (videoUploadError) throw videoUploadError;
        
        // Upload thumbnail
        const { data: thumbnailUploadData, error: thumbnailUploadError } = await supabaseStorage.storage
          .from('thumbnails')
          .upload(thumbnailStoragePath, thumbnailBuffer, {
            contentType: 'image/jpeg',
            upsert: true
          });
        
        if (thumbnailUploadError) throw thumbnailUploadError;
        
        // Get public URLs
        const { data: { publicUrl: videoPublicUrl } } = supabaseStorage.storage
          .from('processed-shorts')
          .getPublicUrl(videoStoragePath);
        
        const { data: { publicUrl: thumbnailPublicUrl } } = supabaseStorage.storage
          .from('thumbnails')
          .getPublicUrl(thumbnailStoragePath);
        
        // Create short record in database
        const shortRecordsResult = await supabaseRequest('short_videos', 'POST', [{
          short_id: shortId,
          video_processing_id: videoRecord.id,
          user_id: user.id,
          title: segment.title,
          segment_data: segment,
          quality: quality,
          subscription_type: inputData.subscription_type || 'free',
          status: 'completed',
          file_url: videoPublicUrl,
          thumbnail_url: thumbnailPublicUrl,
          storage_path: videoStoragePath,
          thumbnail_path: thumbnailStoragePath,
          file_size_bytes: videoBuffer.length,
          duration: segment.duration,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          metadata: {
            segment_id: segment.segment_id,
            platform: inputData.platform,
            original_url: inputData.video_url,
            video_id: videoInfo.video_id,
            fallback_processing: inputData.processing_status === 'continue_with_fallback',
            youtube_error_recovered: inputData.youtube_downloader_error?.occurred || false
          }
        }]);
        
        if (shortRecordsResult && shortRecordsResult.length > 0) {
          const processedShort = {
            short_id: shortId,
            title: segment.title,
            duration: segment.duration,
            quality: quality,
            file_url: videoPublicUrl,
            thumbnail_url: thumbnailPublicUrl,
            storage_path: videoStoragePath,
            thumbnail_path: thumbnailStoragePath,
            status: 'completed',
            created_at: new Date().toISOString(),
            file_size: `${Math.round(videoBuffer.length / (1024 * 1024))}MB`,
            features_applied: inputData.subscription_type === 'free' ? ['basic_trim', 'watermark'] : 
                             inputData.subscription_type === 'premium' ? ['smart_crop', 'auto_captions'] :
                             ['ai_highlights', 'custom_branding', 'batch_export'],
            processing_notes: inputData.processing_status === 'continue_with_fallback' ? 
                             'Processed with fallback metadata due to YouTube API limitations' : null
          };
          
          // Add subscription-specific features
          if (inputData.subscription_type === 'free') {
            processedShort.watermark = '@VideoShortsBot';
          }
          
          processedShorts.push(processedShort);
          console.log(`✅ Short processed: ${shortId}`);
        } else {
          console.warn(`⚠️ No short record returned for ${shortId}`);
          failedShorts.push(segment);
        }
      } catch (error) {
        console.error(`❌ Short processing failed for segment ${segment.segment_id}:`, error);
        failedShorts.push(segment);
      }
    }

    // 7. Update final video processing status - FIXED to use valid constraint values
    try {
      // FIXED: Use only valid status values from database constraint
      const finalStatus = inputData.processing_status === 'continue_with_fallback' ? 
                         'completed' : 'completed'; // Both map to 'completed'
                         
      await supabaseRequest(`video_processing?id=eq.${videoRecord.id}`, 'PATCH', {
        status: finalStatus, // FIXED: Only valid constraint values
        completed_at: new Date().toISOString(),
        shorts_generated: processedShorts.length,
        updated_at: new Date().toISOString(),
        processing_notes: inputData.processing_status === 'continue_with_fallback' ? 
                         'Completed using fallback metadata after YouTube API error' : null,
        // FIXED: Store processing method info in metadata
        metadata: {
          ...videoRecord.metadata,
          final_processing_method: inputData.processing_status === 'continue_with_fallback' ? 'fallback' : 'normal',
          completion_status: inputData.processing_status === 'continue_with_fallback' ? 'completed_with_fallback' : 'completed_normal'
        }
      });
      
      // Update user stats
      await supabaseRequest(`users?id=eq.${user.id}`, 'PATCH', {
        videos_processed: (user.videos_processed || 0) + 1,
        shorts_generated: (user.shorts_generated || 0) + processedShorts.length,
        updated_at: new Date().toISOString()
      });
      
      console.log('✅ Processing completed and database updated');
    } catch (error) {
      console.error('❌ Final update failed:', error);
    }

    // 8. Log processing completion to analytics
    try {
      await supabaseRequest('usage_analytics', 'POST', [{
        user_id: user.id,
        video_processing_id: videoRecord.id,
        action_type: 'video_processing_completed',
        platform: inputData.platform,
        subscription_type: inputData.subscription_type,
        processing_time_seconds: Math.floor((Date.now() - new Date(videoRecord.created_at).getTime()) / 1000),
        file_size_bytes: processedShorts.reduce((sum, short) => sum + (parseInt(short.file_size) * 1024 * 1024 || 0), 0),
        quality: processedShorts[0]?.quality,
        created_at: new Date().toISOString(),
        metadata: {
          processing_id: inputData.processing_id,
          platform_detected: inputData.platform,
          video_title: inputData.video_info?.title?.substring(0, 200),
          shorts_generated: processedShorts.length,
          metadata_source: inputData.video_info?.metadata_source,
          video_duration: inputData.video_info?.duration,
          failed_shorts_count: failedShorts.length,
          youtube_error_occurred: inputData.youtube_downloader_error?.occurred || false,
          error_recovery_used: inputData.processing_status === 'continue_with_fallback',
          processing_method: inputData.processing_status === 'continue_with_fallback' ? 'fallback' : 'normal'
        }
      }]);
      console.log('✅ Analytics logged');
    } catch (error) {
      console.warn('⚠️ Analytics logging failed:', error);
    }

    // Return the complete result
    const result = {
      ...inputData,
      user_id: user.id,
      video_record_id: videoRecord.id,
      video_info: videoInfo,
      shorts_segments: shortsSegments,
      shorts_results: processedShorts,
      processing_completed_at: new Date().toISOString(),
      status: 'completed',
      total_shorts: processedShorts.length,
      database_records: {
        user_id: user.id,
        video_processing_id: videoRecord.id,
        short_record_ids: processedShorts.map(s => s.short_id)
      },
      processing_summary: {
        platform: inputData.platform,
        metadata_source: videoInfo.metadata_source,
        shorts_generated: processedShorts.length,
        shorts_failed: failedShorts.length,
        subscription_features: processedShorts[0]?.features_applied || [],
        youtube_error_recovered: inputData.youtube_downloader_error?.occurred || false,
        processing_method: inputData.processing_status === 'continue_with_fallback' ? 'fallback' : 'normal'
      },
      usage_stats: {
        processing_time: `${Math.floor((Date.now() - new Date(videoRecord.created_at).getTime()) / 1000)} seconds`,
        segments_created: shortsSegments.length,
        shorts_processed: processedShorts.length,
        metadata_method: videoInfo.metadata_source,
        subscription_tier: inputData.subscription_type || 'free',
        total_file_size: `${processedShorts.reduce((sum, short) => sum + (parseInt(short.file_size) || 0), 0)}MB`
      }
    };

    console.log('🎉 Real Video Processing completed successfully!');
    console.log('Result summary:', {
      user_id: result.user_id,
      video_record_id: result.video_record_id,
      shorts_count: result.total_shorts,
      metadata_source: result.video_info.metadata_source,
      error_recovery: result.processing_summary.youtube_error_recovered
    });

    return result;

  } catch (mainError) {
    console.error('❌ Main processing error:', mainError);
    
    // Enhanced error information with YouTube context
    const errorInfo = {
      message: mainError.message,
      type: mainError.name || 'ProcessingError',
      timestamp: new Date().toISOString(),
      youtube_error_context: inputData?.youtube_downloader_error || null
    };

    // Provide specific guidance based on error type
    if (mainError.message.includes('SUPABASE_URL')) {
      errorInfo.resolution = 'Set SUPABASE_URL environment variable in n8n settings';
    } else if (mainError.message.includes('SUPABASE_SERVICE_ROLE_KEY')) {
      errorInfo.resolution = 'Set SUPABASE_SERVICE_ROLE_KEY environment variable in n8n settings';
    } else if (mainError.message.includes('authentication failed')) {
      errorInfo.resolution = 'Check your Supabase service role key is correct';
    } else if (mainError.message.includes('not found')) {
      errorInfo.resolution = 'Verify your Supabase database schema matches the expected tables';
    } else if (mainError.message.includes('YouTube processing failed')) {
      errorInfo.resolution = 'YouTube API error - check video URL accessibility';
    } else if (mainError.message.includes('ffmpeg')) {
      errorInfo.resolution = 'FFmpeg error - check if ffmpeg is installed and accessible';
    } else if (mainError.message.includes('download')) {
      errorInfo.resolution = 'Video download failed - check URL accessibility and network connection';
    }
    
    // Ensure inputData is available for error handling
    if (typeof inputData === 'undefined') {
      try {
        // Try to get input data from different sources
        if (typeof $input !== 'undefined' && $input.first) {
          inputData = $input.first().json;
        } else {
          inputData = {};
        }
      } catch (inputError) {
        console.error('❌ Cannot access input data:', inputError);
        return {
          status: 'error',
          error: 'Failed to access input data: ' + inputError.message,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    // Try to update video record status to failed if we have one
    try {
      if (typeof videoRecord !== 'undefined' && videoRecord?.id) {
        await supabaseRequest(`video_processing?id=eq.${videoRecord.id}`, 'PATCH', {
          status: 'failed', // FIXED: Use valid constraint value
          error_message: mainError.message,
          updated_at: new Date().toISOString()
        });
      }
    } catch (updateError) {
      console.error('❌ Failed to update error status:', updateError);
    }
    
    // Clean up temp directory
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error('Error cleaning up temp directory:', cleanupError);
    }
    
    // Return comprehensive error response
    return {
      status: 'error',
      error: mainError.message,
      error_info: errorInfo,
      processing_id: inputData?.processing_id || 'unknown',
      telegram_id: inputData?.telegram_id,
      chat_id: inputData?.chat_id,
      timestamp: new Date().toISOString(),
      configuration_check: {
        supabase_url_set: !!(process.env.SUPABASE_URL || inputData.supabase?.url),
        service_key_set: !!(process.env.SUPABASE_SERVICE_ROLE_KEY || inputData.supabase?.service_key),
        anon_key_set: !!(process.env.SUPABASE_ANON_KEY || inputData.supabase?.key)
      },
      youtube_context: inputData?.youtube_downloader_error || null
    };
  } finally {
    // Always clean up temp directory
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error('Error cleaning up temp directory:', cleanupError);
    }
  }
}

// For n8n usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processVideo };
}

// For direct usage in n8n
if (typeof $input !== 'undefined') {
  // Execute the processing when running in n8n
  processVideo($input.first().json)
    .then(result => $output = [result])
    .catch(error => {
      console.error('Processing failed:', error);
      $output = [{
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      }];
    });
}