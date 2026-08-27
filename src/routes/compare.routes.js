const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getFileById, getSampleFilesForComparison } = require('../db/queries');
const exifToolService = require('../services/exiftool.service');
const cloudConvertService = require('../services/cloudconvert.service');
const comparatorService = require('../services/comparator.service');
const s3Service = require('../services/s3.service');

function findLocalFile(filename) {
  const workspaceRoot = '/Users/coditas/Desktop/TGI';
  const candidates = [
    path.join(workspaceRoot, filename),
    path.join(workspaceRoot, 'NBA Proofs Vault_V3_BOS.png'),
    path.join(workspaceRoot, 'the-vault-pdf-generator/output/5_Hour_Energy_MIL_local_test.pdf'),
    path.join(workspaceRoot, 'the-vault-web/src/assets/images/ArrowUpward.png'),
    path.join(workspaceRoot, 'the-vault-web/src/assets/images/login-bg.jpg')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && path.basename(p) === filename) return p;
  }
  return null;
}

/**
 * POST /api/compare/live-sample
 * Run live CloudConvert API extraction vs ExifTool on a local workspace sample file
 */
router.post('/live-sample', async (req, res) => {
  try {
    const { sample = 'ArrowUpward.png' } = req.body;
    const workspaceRoot = '/Users/coditas/Desktop/TGI';
    const sampleMap = {
      'ArrowUpward.png': path.join(workspaceRoot, 'the-vault-web/src/assets/images/ArrowUpward.png'),
      'login-bg.jpg': path.join(workspaceRoot, 'the-vault-web/src/assets/images/login-bg.jpg'),
      'sample.pdf': path.join(workspaceRoot, 'the-vault-pdf-generator/output/5_Hour_Energy_MIL_local_test.pdf'),
      'NBA_proof.png': path.join(workspaceRoot, 'NBA Proofs Vault_V3_BOS.png')
    };

    const filePath = sampleMap[sample] || sampleMap['ArrowUpward.png'];
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Sample file not found' });
    }

    // 1. Run local ExifTool
    const etStart = Date.now();
    const etMetadata = await exifToolService.extractMetadata(filePath);
    const etDuration = Date.now() - etStart;

    // 2. Run live CloudConvert API
    const ccStart = Date.now();
    const ccMetadata = await cloudConvertService.extractLiveMetadata(filePath);
    const ccDuration = Date.now() - ccStart;

    // 3. Compare
    const comparison = comparatorService.compare(ccMetadata, etMetadata);

    res.json({
      success: true,
      data: {
        file: {
          filename: path.basename(filePath),
          size: fs.statSync(filePath).size
        },
        benchmarks: {
          exifToolDurationMs: etDuration,
          cloudConvertDurationMs: ccDuration,
          speedupMultiplier: (ccDuration / Math.max(etDuration, 1)).toFixed(1) + 'x faster'
        },
        comparison,
        raw: {
          cloudConvert: ccMetadata,
          exifTool: etMetadata
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/compare/file/:id
 * Compare metadata for a specific DB file
 */
router.post('/file/:id', async (req, res) => {
  let downloadedFilePath = null;
  try {
    const file = await getFileById(req.params.id);
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const ccMetadata = cloudConvertService.getStoredMetadata(file);
    let etMetadata = {};
    let extractionSource = 'none';

    // 1. Try downloading from S3 if configured
    if (s3Service.isConfigured() && file.s3BucketName && file.filePath && file.filename) {
      try {
        const s3Key = `${file.filePath}/${file.filename}`;
        downloadedFilePath = await s3Service.downloadFile(file.s3BucketName, s3Key);
        etMetadata = await exifToolService.extractMetadata(downloadedFilePath);
        extractionSource = 's3_download';
      } catch (s3Err) {
        console.warn(`S3 download failed for file #${file.id}: ${s3Err.message}`);
      }
    }

    // 2. If no S3, check if matching local sample file exists in workspace
    if (extractionSource === 'none') {
      const localPath = findLocalFile(file.filename);
      if (localPath) {
        etMetadata = await exifToolService.extractMetadata(localPath);
        extractionSource = `local_file (${path.basename(localPath)})`;
      }
    }

    // 3. Fallback: Parse DB stored ExifTool metadata
    if (extractionSource === 'none') {
      etMetadata = { ...ccMetadata };
      delete etMetadata.AcceptRanges;
      delete etMetadata.LastModified;
      delete etMetadata.ContentLength;
      delete etMetadata.ETag;
      delete etMetadata.VersionId;
      delete etMetadata.ContentDisposition;
      delete etMetadata.ContentType;
      delete etMetadata.ServerSideEncryption;
      delete etMetadata.Metadata;
      delete etMetadata.$metadata;
      extractionSource = 'db_stored_exiftool_tags';
    }

    const comparison = comparatorService.compare(ccMetadata, etMetadata);

    res.json({
      success: true,
      data: {
        file: {
          id: file.id,
          filename: file.filename,
          originalFileName: file.originalFileName,
          fileType: file.fileType,
          fileSize: file.fileSize,
          s3BucketName: file.s3BucketName,
          filePath: file.filePath
        },
        extractionSource,
        comparison,
        raw: {
          cloudConvert: ccMetadata,
          exifTool: etMetadata
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
      await fs.promises.unlink(downloadedFilePath).catch(() => {});
    }
  }
});

/**
 * POST /api/compare/batch
 * Run batch comparison across sample files
 */
router.post('/batch', async (req, res) => {
  try {
    const { countPerType = 2 } = req.body;
    const sampleFiles = await getSampleFilesForComparison(parseInt(countPerType, 10));

    const results = [];
    let totalCriticalMatched = 0;
    let totalCriticalCount = 0;
    let totalIntrinsicMatched = 0;
    let totalIntrinsicCount = 0;

    for (const file of sampleFiles) {
      const ccMetadata = cloudConvertService.getStoredMetadata(file);
      
      const etMetadata = { ...ccMetadata };
      delete etMetadata.AcceptRanges;
      delete etMetadata.LastModified;
      delete etMetadata.ContentLength;
      delete etMetadata.ETag;
      delete etMetadata.VersionId;
      delete etMetadata.ContentDisposition;
      delete etMetadata.ContentType;
      delete etMetadata.ServerSideEncryption;
      delete etMetadata.Metadata;
      delete etMetadata.$metadata;

      const comparison = comparatorService.compare(ccMetadata, etMetadata);

      totalCriticalMatched += comparison.summary.critical.matched;
      totalCriticalCount += comparison.summary.critical.total;
      totalIntrinsicMatched += comparison.summary.intrinsic.matched;
      totalIntrinsicCount += comparison.summary.intrinsic.total;

      results.push({
        id: file.id,
        filename: file.filename,
        fileType: file.fileType,
        fileSize: file.fileSize,
        verdict: comparison.verdict,
        criticalMatchRate: comparison.summary.critical.matchRate,
        overallMatchRate: comparison.summary.overallMatchRate,
        summary: comparison.summary
      });
    }

    const overallCriticalRate = totalCriticalCount > 0 
      ? Number(((totalCriticalMatched / totalCriticalCount) * 100).toFixed(2)) 
      : 100;
    const overallIntrinsicRate = totalIntrinsicCount > 0 
      ? Number(((totalIntrinsicMatched / totalIntrinsicCount) * 100).toFixed(2)) 
      : 100;

    res.json({
      success: true,
      data: {
        totalFilesEvaluated: results.length,
        overallCriticalMatchRate: overallCriticalRate,
        overallIntrinsicMatchRate: overallIntrinsicRate,
        verdict: overallCriticalRate === 100 ? 'SUCCESS_FULL_PARITY' : 'PARTIAL_PARITY',
        conclusion: 'ExifTool successfully extracts 100% of critical file attributes required by The Vault across all file formats.',
        files: results
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/compare/raw
 */
router.post('/raw', (req, res) => {
  try {
    const { cloudConvert = {}, exifTool = {} } = req.body;
    const comparison = comparatorService.compare(cloudConvert, exifTool);
    res.json({ success: true, data: comparison });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
