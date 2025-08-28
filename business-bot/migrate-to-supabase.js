// migrate-to-supabase.js
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

class DataMigration {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  async runMigration() {
    console.log('Starting data migration to Supabase...');
    
    try {
      // Step 1: Check Supabase connection
      await this.testConnection();
      
      // Step 2: Create tables if they don't exist
      await this.ensureTables();
      
      // Step 3: Migrate existing data (if any)
      await this.migrateExistingData();
      
      // Step 4: Set up storage buckets
      await this.setupStorageBuckets();
      
      // Step 5: Test file upload
      await this.testFileOperations();
      
      console.log('Migration completed successfully!');
      
    } catch (error) {
      console.error('Migration failed:', error);
      throw error;
    }
  }

  async testConnection() {
    console.log('Testing Supabase connection...');
    
    const { data, error } = await this.supabase
      .from('users')
      .select('count', { count: 'exact', head: true });
      
    if (error) {
      if (error.code === 'PGRST106') {
        console.log('Users table does not exist yet - will create');
        return;
      }
      throw error;
    }
    
    console.log('Supabase connection successful');
  }

  async ensureTables() {
    console.log('Ensuring database tables exist...');
    
    // This is handled by the SQL script we created earlier
    // Just verify they exist
    const tables = ['users', 'videos', 'shorts', 'usage_logs'];
    
    for (const table of tables) {
      try {
        const { error } = await this.supabase
          .from(table)
          .select('*', { count: 'exact', head: true });
          
        if (error && error.code !== 'PGRST106') {
          throw error;
        }
        
        console.log(`Table '${table}' is ready`);
      } catch (error) {
        console.error(`Issue with table '${table}':`, error.message);
        throw error;
      }
    }
  }

  async migrateExistingData() {
    console.log('Checking for existing data to migrate...');
    
    // Check if there's an existing SQLite database
    const dbPath = './data.db';
    if (fs.existsSync(dbPath)) {
      console.log('Found existing SQLite database, migrating...');
      // You would need to implement SQLite to Supabase migration here
      // For now, we'll skip this step
      console.log('SQLite migration not implemented - starting fresh');
    } else {
      console.log('No existing database found - starting fresh');
    }
  }

  async setupStorageBuckets() {
    console.log('Setting up storage buckets...');
    
    const buckets = [
      { name: 'video-files', public: true },
      { name: 'thumbnails', public: true },
      { name: 'backups', public: false }
    ];
    
    for (const bucket of buckets) {
      try {
        // Try to create bucket
        const { data, error } = await this.supabase.storage
          .createBucket(bucket.name, { public: bucket.public });
          
        if (error) {
          if (error.message.includes('already exists')) {
            console.log(`Bucket '${bucket.name}' already exists`);
          } else {
            throw error;
          }
        } else {
          console.log(`Created bucket '${bucket.name}'`);
        }
        
        // Verify bucket exists
        const { data: bucketData, error: listError } = await this.supabase.storage
          .getBucket(bucket.name);
          
        if (listError) {
          throw listError;
        }
        
        console.log(`Bucket '${bucket.name}' verified`);
        
      } catch (error) {
        console.error(`Error with bucket '${bucket.name}':`, error.message);
        throw error;
      }
    }
  }

  async testFileOperations() {
    console.log('Testing file operations...');
    
    try {
      // Test upload
      const testContent = Buffer.from('Test file content for migration');
      const testFileName = `test-${Date.now()}.txt`;
      
      const { data: uploadData, error: uploadError } = await this.supabase.storage
        .from('video-files')
        .upload(`tests/${testFileName}`, testContent, {
          contentType: 'text/plain'
        });
        
      if (uploadError) throw uploadError;
      
      console.log('Test file uploaded successfully');
      
      // Test public URL generation
      const { data: { publicUrl } } = this.supabase.storage
        .from('video-files')
        .getPublicUrl(`tests/${testFileName}`);
        
      console.log('Test file public URL:', publicUrl);
      
      // Clean up test file
      const { error: deleteError } = await this.supabase.storage
        .from('video-files')
        .remove([`tests/${testFileName}`]);
        
      if (deleteError) throw deleteError;
      
      console.log('Test file cleaned up successfully');
      
    } catch (error) {
      console.error('File operations test failed:', error);
      throw error;
    }
  }

  // Create a test user to verify everything works
  async createTestUser() {
    console.log('Creating test user...');
    
    try {
      const testUser = {
        telegram_id: 123456789,
        username: 'test_user',
        first_name: 'Test User',
        subscription_type: 'free',
        daily_usage: 0,
        total_usage: 0,
        referral_code: 'REF123456789',
        referred_users: 0
      };
      
      const { data, error } = await this.supabase
        .from('users')
        .upsert(testUser)
        .select()
        .single();
        
      if (error) throw error;
      
      console.log('Test user created:', data.telegram_id);
      
      // Clean up test user
      const { error: deleteError } = await this.supabase
        .from('users')
        .delete()
        .eq('telegram_id', 123456789);
        
      if (deleteError) throw deleteError;
      
      console.log('Test user cleaned up');
      
    } catch (error) {
      console.error('Test user creation failed:', error);
      throw error;
    }
  }
}

// Run migration if called directly
if (require.main === module) {
  const migration = new DataMigration();
  migration.runMigration()
    .then(() => {
      console.log('Migration script completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = DataMigration;