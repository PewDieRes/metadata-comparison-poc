const CloudConvert = require('cloudconvert');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class CloudConvertService {
  constructor() {
    this.cloudConvert = null;
  }

  getClient() {
    const apiKey = config.cloudConvert.apiKey || process.env.CLOUDCONVERT_API_KEY;
    if (!this.cloudConvert && apiKey) {
      this.cloudConvert = new CloudConvert(apiKey);
    }
    return this.cloudConvert;
  }

  isConfigured() {
    return Boolean(config.cloudConvert.apiKey || process.env.CLOUDCONVERT_API_KEY);
  }

  /**
   * Get metadata stored in database (produced by CloudConvert)
   * @param {Object} fileRecord 
   * @returns {Record<string, any>}
   */
  getStoredMetadata(fileRecord) {
    if (!fileRecord || !fileRecord.metadata) {
      return {};
    }

    let meta = fileRecord.metadata;
    if (typeof meta === 'string') {
      try {
        meta = JSON.parse(meta);
      } catch (e) {
        meta = {};
      }
    }
    return meta;
  }

  /**
   * Trigger live CloudConvert metadata extraction via official API
   * @param {string} localFilePath 
   * @returns {Promise<Record<string, any>>}
   */
  async extractLiveMetadata(localFilePath) {
    const client = this.getClient();
    if (!client) {
      throw new Error('CloudConvert API Key is not configured in .env (CLOUDCONVERT_API_KEY)');
    }

    if (!fs.existsSync(localFilePath)) {
      throw new Error(`File not found: ${localFilePath}`);
    }

    const filename = path.basename(localFilePath);

    // Create job with upload and metadata tasks
    const job = await client.jobs.create({
      tasks: {
        'import-task': {
          operation: 'import/upload'
        },
        'metadata-task': {
          operation: 'metadata',
          input: 'import-task'
        }
      }
    });

    const uploadTask = job.tasks.find(t => t.name === 'import-task');
    if (!uploadTask) {
      throw new Error('Failed to create CloudConvert upload task');
    }

    // Upload local file stream
    const fileStream = fs.createReadStream(localFilePath);
    await client.tasks.upload(uploadTask, fileStream, filename);

    // Wait for metadata extraction to complete
    const finishedJob = await client.jobs.wait(job.id);
    const metadataTask = finishedJob.tasks.find(t => t.name === 'metadata-task');

    if (!metadataTask || metadataTask.status === 'error') {
      const errMsg = metadataTask?.message || 'CloudConvert metadata extraction task failed';
      throw new Error(errMsg);
    }

    return metadataTask.result?.metadata || {};
  }
}

module.exports = new CloudConvertService();
