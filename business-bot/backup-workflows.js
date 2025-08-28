// Create backup-workflows.js in your business-bot folder
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class WorkflowBackup {
  constructor() {
    this.n8nUrl = process.env.N8N_URL || 'https://n8n-on-render-wf30.onrender.com';
    this.backupDir = './workflow-backups';
    
    // Create backup directory
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  async backupWorkflows() {
    try {
      console.log('Starting workflow backup...');
      
      // Get list of workflows
      const workflowsResponse = await axios.get(`${this.n8nUrl}/api/v1/workflows`, {
        timeout: 10000
      });
      
      const workflows = workflowsResponse.data.data;
      console.log(`Found ${workflows.length} workflows to backup`);
      
      const backupData = {
        timestamp: new Date().toISOString(),
        workflows: []
      };
      
      // Backup each workflow
      for (const workflow of workflows) {
        try {
          const workflowResponse = await axios.get(`${this.n8nUrl}/api/v1/workflows/${workflow.id}`, {
            timeout: 10000
          });
          
          backupData.workflows.push(workflowResponse.data.data);
          console.log(`Backed up workflow: ${workflow.name}`);
        } catch (error) {
          console.error(`Failed to backup workflow ${workflow.name}:`, error.message);
        }
      }
      
      // Save backup to file
      const backupFileName = `workflows-backup-${new Date().toISOString().split('T')[0]}.json`;
      const backupPath = path.join(this.backupDir, backupFileName);
      
      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
      console.log(`Backup saved to: ${backupPath}`);
      
      // Also save to Supabase storage for redundancy
      await this.saveToSupabase(backupFileName, backupData);
      
      return backupData;
    } catch (error) {
      console.error('Workflow backup failed:', error.message);
      throw error;
    }
  }
  
  async saveToSupabase(fileName, data) {
    try {
      const db = require('./utils/supabase');
      const backupBuffer = Buffer.from(JSON.stringify(data, null, 2));
      
      await db.uploadFile('backups', `workflows/${fileName}`, backupBuffer, 'application/json');
      console.log(`Backup also saved to Supabase: workflows/${fileName}`);
    } catch (error) {
      console.error('Failed to save backup to Supabase:', error.message);
    }
  }

  async restoreWorkflows(backupFile = null) {
    try {
      let backupData;
      
      if (backupFile) {
        backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      } else {
        // Get latest backup
        const backupFiles = fs.readdirSync(this.backupDir)
          .filter(f => f.startsWith('workflows-backup-'))
          .sort()
          .reverse();
        
        if (backupFiles.length === 0) {
          throw new Error('No backup files found');
        }
        
        const latestBackup = path.join(this.backupDir, backupFiles[0]);
        backupData = JSON.parse(fs.readFileSync(latestBackup, 'utf8'));
        console.log(`Restoring from: ${latestBackup}`);
      }
      
      console.log(`Restoring ${backupData.workflows.length} workflows...`);
      
      // Restore each workflow
      for (const workflow of backupData.workflows) {
        try {
          // Try to update existing workflow first
          await axios.patch(`${this.n8nUrl}/api/v1/workflows/${workflow.id}`, workflow);
          console.log(`Updated workflow: ${workflow.name}`);
        } catch (error) {
          if (error.response?.status === 404) {
            // Workflow doesn't exist, create new one
            try {
              delete workflow.id; // Remove ID for new workflow
              await axios.post(`${this.n8nUrl}/api/v1/workflows`, workflow);
              console.log(`Created new workflow: ${workflow.name}`);
            } catch (createError) {
              console.error(`Failed to create workflow ${workflow.name}:`, createError.message);
            }
          } else {
            console.error(`Failed to update workflow ${workflow.name}:`, error.message);
          }
        }
      }
      
      console.log('Workflow restoration completed');
      
    } catch (error) {
      console.error('Workflow restoration failed:', error.message);
      throw error;
    }
  }

  // Schedule automatic backups
  startScheduledBackups() {
    const cron = require('cron');
    
    // Daily backup at 2 AM UTC
    const backupJob = new cron.CronJob('0 2 * * *', async () => {
      console.log('Running scheduled workflow backup...');
      try {
        await this.backupWorkflows();
        console.log('Scheduled backup completed successfully');
      } catch (error) {
        console.error('Scheduled backup failed:', error.message);
      }
    }, null, true, 'UTC');
    
    console.log('Scheduled workflow backups enabled (daily at 2 AM UTC)');
    
    // Also backup on startup
    setTimeout(() => {
      this.backupWorkflows().catch(console.error);
    }, 30000); // Wait 30 seconds after startup
  }
}

module.exports = WorkflowBackup;