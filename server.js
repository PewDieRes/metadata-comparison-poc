const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const config = require('./src/config');
const dbRoutes = require('./src/routes/db.routes');
const compareRoutes = require('./src/routes/compare.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const exifToolService = require('./src/services/exiftool.service');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve frontend dashboard
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/db', dbRoutes);
app.use('/api/compare', compareRoutes);
app.use('/api/upload', uploadRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'The Vault Metadata Comparison POC',
    timestamp: new Date().toISOString()
  });
});

// Fallback to index.html for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const server = app.listen(config.port, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Metadata Comparison POC Server is running!`);
  console.log(`📍 Dashboard URL: http://localhost:${config.port}`);
  console.log(`🗄️  PostgreSQL DB: ${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`=======================================================`);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    try {
      await exifToolService.shutdown();
      console.log('ExifTool process terminated.');
    } catch (e) {
      console.error('Error shutting down ExifTool:', e);
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
