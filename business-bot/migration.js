// migration.js - Run this script to safely migrate your database
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function runMigration() {
  console.log('🚀 Starting database migration...');
  
  try {
    // Step 1: Add missing columns to usage_logs if they don't exist
    console.log('📝 Step 1: Updating usage_logs table structure...');
    
    const alterTableSQL = `
      ALTER TABLE usage_logs 
      ADD COLUMN IF NOT EXISTS shorts_generated INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_shorts INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS file_size_mb NUMERIC;
    `;
    
    const { error: alterError } = await supabase.rpc('exec_sql', { 
      sql: alterTableSQL 
    });
    
    if (alterError) {
      console.log('⚠️ Could not add columns (they may already exist):', alterError.message);
    } else {
      console.log('✅ Usage logs table updated successfully');
    }

    // Step 2: Create indexes for better performance
    console.log('📝 Step 2: Creating performance indexes...');
    
    const indexesSQL = `
      CREATE INDEX IF NOT EXISTS idx_usage_logs_telegram_id_action ON usage_logs(telegram_id, action);
      CREATE INDEX IF NOT EXISTS idx_usage_logs_processing_id ON usage_logs(processing_id);
      CREATE INDEX IF NOT EXISTS idx_usage_logs_success ON usage_logs(success);
      CREATE INDEX IF NOT EXISTS idx_usage_logs_date ON usage_logs(DATE(created_at));
    `;
    
    const { error: indexError } = await supabase.rpc('exec_sql', { 
      sql: indexesSQL 
    });
    
    if (indexError) {
      console.log('⚠️ Some indexes may already exist:', indexError.message);
    } else {
      console.log('✅ Performance indexes created');
    }

    // Step 3: Verify table structure
    console.log('📝 Step 3: Verifying table structure...');
    
    const { data: usageLogsStructure, error: structureError } = await supabase
      .from('usage_logs')
      .select('*')
      .limit(1);

    if (structureError) {
      console.error('❌ Error verifying table structure:', structureError);
      return false;
    }

    console.log('✅ Table structure verified');

    // Step 4: Test database operations
    console.log('📝 Step 4: Testing database operations...');
    
    // Test user operations
    const testTelegramId = 'test_migration_' + Date.now();
    
    // Test user creation
    const { data: testUser, error: createError } = await supabase
      .from('users')
      .insert([{
        telegram_id: testTelegramId,
        username: 'migration_test',
        first_name: 'Migration Test',
        subscription_type: 'free'
      }])
      .select()
      .single();

    if (createError) {
      console.error('❌ Error creating test user:', createError);
      return false;
    }

    console.log('✅ Test user created:', testUser.telegram_id);

    // Test usage log creation
    const { data: testLog, error: logError } = await supabase
      .from('usage_logs')
      .insert([{
        telegram_id: testTelegramId,
        action: 'migration_test',
        platform: 'test',
        success: true,
        shorts_generated: 2
      }])
      .select()
      .single();

    if (logError) {
      console.error('❌ Error creating test usage log:', logError);
      return false;
    }

    console.log('✅ Test usage log created');

    // Clean up test data
    await supabase.from('usage_logs').delete().eq('telegram_id', testTelegramId);
    await supabase.from('users').delete().eq('telegram_id', testTelegramId);
    
    console.log('✅ Test data cleaned up');

    // Step 5: Verify current data integrity
    console.log('📝 Step 5: Verifying data integrity...');
    
    const { data: userCount } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true });

    const { data: videoCount } = await supabase
      .from('video_processing')
      .select('id', { count: 'exact', head: true });

    const { data: logCount } = await supabase
      .from('usage_logs')
      .select('id', { count: 'exact', head: true });

    console.log('📊 Current database stats:');
    console.log(`   Users: ${userCount?.length || 0}`);
    console.log(`   Videos: ${videoCount?.length || 0}`);
    console.log(`   Usage logs: ${logCount?.length || 0}`);

    console.log('🎉 Migration completed successfully!');
    console.log('📋 Next steps:');
    console.log('   1. Update your utils/supabase.js with the new database service');
    console.log('   2. Test your bot with a real video processing request');
    console.log('   3. Monitor the logs to ensure everything works correctly');
    
    return true;

  } catch (error) {
    console.error('❌ Migration failed:', error);
    return false;
  }
}

async function verifyMigration() {
  console.log('🔍 Verifying migration...');
  
  try {
    // Check if all required tables exist
    const tables = ['users', 'video_processing', 'short_videos', 'usage_logs'];
    
    for (const table of tables) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1);
      
      if (error) {
        console.error(`❌ Table ${table} not accessible:`, error.message);
        return false;
      } else {
        console.log(`✅ Table ${table} is accessible`);
      }
    }

    console.log('✅ All tables verified successfully');
    return true;
  } catch (error) {
    console.error('❌ Verification failed:', error);
    return false;
  }
}

// Run migration if called directly
if (require.main === module) {
  runMigration()
    .then(success => {
      if (success) {
        return verifyMigration();
      }
      process.exit(1);
    })
    .then(verified => {
      if (verified) {
        console.log('🎉 Migration and verification completed successfully!');
        process.exit(0);
      } else {
        console.log('❌ Migration completed but verification failed');
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('❌ Migration process failed:', error);
      process.exit(1);
    });
}

module.exports = { runMigration, verifyMigration };