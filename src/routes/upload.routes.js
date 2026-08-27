const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const exifToolService = require('../services/exiftool.service');
const cloudConvertService = require('../services/cloudconvert.service');
const comparatorService = require('../services/comparator.service');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit for test uploads
});

/**
 * POST /api/upload/test
 * Upload a local file and extract both ExifTool and live CloudConvert metadata in real-time
 */
router.post('/test', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const uploadedPath = req.file.path;
  const startTime = Date.now();
  let exifToolDuration = 0;
  let cloudConvertDuration = 0;

  try {
    // 1. Run local ExifTool extraction
    const etStart = Date.now();
    const exifToolMeta = await exifToolService.extractMetadata(uploadedPath);
    exifToolDuration = Date.now() - etStart;

    let cloudConvertMeta = null;
    let ccStatus = 'not_configured';

    // 2. Run live CloudConvert API extraction if configured
    if (cloudConvertService.isConfigured()) {
      try {
        const ccStart = Date.now();
        cloudConvertMeta = await cloudConvertService.extractLiveMetadata(uploadedPath);
        cloudConvertDuration = Date.now() - ccStart;
        ccStatus = 'live_api_success';
      } catch (ccErr) {
        console.warn('Live CloudConvert call failed:', ccErr.message);
        ccStatus = `error: ${ccErr.message}`;
      }
    }

    // 3. Compare the two metadata payloads
    const comparison = comparatorService.compare(
      cloudConvertMeta || exifToolMeta,
      exifToolMeta
    );

    res.json({
      success: true,
      data: {
        file: {
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size
        },
        cloudConvertStatus: ccStatus,
        benchmarks: {
          exifToolDurationMs: exifToolDuration,
          cloudConvertDurationMs: cloudConvertDuration,
          speedupMultiplier: cloudConvertDuration > 0 ? (cloudConvertDuration / Math.max(exifToolDuration, 1)).toFixed(1) + 'x faster' : 'Local instant'
        },
        exifToolMetadata: exifToolMeta,
        cloudConvertMetadata: cloudConvertMeta,
        comparison
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // Clean up uploaded file
    if (fs.existsSync(uploadedPath)) {
      await fs.promises.unlink(uploadedPath).catch(() => {});
    }
  }
});

module.exports = router;
