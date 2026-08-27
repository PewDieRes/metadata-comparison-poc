const { exiftool } = require('exiftool-vendored');
const path = require('path');
const fs = require('fs');

class ExifToolService {
  /**
   * Extract metadata from a local file path using ExifTool
   * @param {string} filePath - Absolute path to local file
   * @returns {Promise<Record<string, any>>}
   */
  async extractMetadata(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found at path: ${filePath}`);
    }

    try {
      const rawTags = await exiftool.read(filePath);
      
      // Clean tags into plain serializable JSON
      const cleanTags = {};
      for (const [key, value] of Object.entries(rawTags)) {
        // Skip private internal exiftool fields starting with '_' or errors if non-fatal
        if (key.startsWith('_') || key === 'errors') continue;
        cleanTags[key] = value;
      }

      return cleanTags;
    } catch (error) {
      console.error(`ExifTool extraction failed for ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Extract metadata from a buffer or stream by writing to a temporary file
   * @param {Buffer} buffer 
   * @param {string} originalFilename 
   * @returns {Promise<Record<string, any>>}
   */
  async extractFromBuffer(buffer, originalFilename = 'temp_file') {
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFilePath = path.join(tempDir, `${Date.now()}_${originalFilename}`);
    await fs.promises.writeFile(tempFilePath, buffer);

    try {
      const metadata = await this.extractMetadata(tempFilePath);
      return metadata;
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempFilePath)) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }
    }
  }

  /**
   * Graceful shutdown of ExifTool process
   */
  async shutdown() {
    await exiftool.end();
  }
}

module.exports = new ExifToolService();
