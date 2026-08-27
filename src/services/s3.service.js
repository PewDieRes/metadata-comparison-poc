const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const config = require('../config');

class S3Service {
  constructor() {
    this.s3Client = null;
  }

  getClient() {
    if (!this.s3Client) {
      const { region, accessKeyId, secretAccessKey } = config.aws;
      if (!accessKeyId || !secretAccessKey) {
        return null;
      }
      this.s3Client = new S3Client({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey
        }
      });
    }
    return this.s3Client;
  }

  isConfigured() {
    return Boolean(config.aws.accessKeyId && config.aws.secretAccessKey);
  }

  /**
   * Download a file from S3 to local temp folder
   * @param {string} bucketName 
   * @param {string} key 
   * @returns {Promise<string>} Local file path
   */
  async downloadFile(bucketName, key) {
    const client = this.getClient();
    if (!client) {
      throw new Error('AWS S3 credentials not configured in .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)');
    }

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const filename = path.basename(key);
    const localFilePath = path.join(tempDir, `${Date.now()}_${filename}`);

    const command = new GetObjectCommand({
      Bucket: bucketName || config.aws.bucketName,
      Key: key
    });

    const response = await client.send(command);
    await pipeline(response.Body, fs.createWriteStream(localFilePath));

    return localFilePath;
  }
}

module.exports = new S3Service();
