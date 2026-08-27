const express = require('express');
const router = express.Router();
const { testConnection } = require('../db/client');
const { getStats, getFilesList, getFileById } = require('../db/queries');

/**
 * GET /api/db/status
 * Test database connectivity
 */
router.get('/status', async (req, res) => {
  try {
    const status = await testConnection();
    res.json(status);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/db/stats
 * Get overall file statistics & MIME type counts
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/db/files
 * Query files with pagination and filters
 */
router.get('/files', async (req, res) => {
  try {
    const { fileType, search, hasMetadata, limit, offset } = req.query;
    const result = await getFilesList({
      fileType,
      search,
      hasMetadata,
      limit: parseInt(limit || '20', 10),
      offset: parseInt(offset || '0', 10)
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/db/files/:id
 * Get single file detail with metadata
 */
router.get('/files/:id', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    res.json({ success: true, data: file });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
