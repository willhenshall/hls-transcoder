import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { transcode, getJobStatus, cleanupJob, cleanupOldJobs } from './transcode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10);
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const JOB_CLEANUP_MINUTES = parseInt(process.env.JOB_CLEANUP_MINUTES || '60', 10);

// Ensure temp directory exists
const TEMP_DIR = '/tmp/hls-jobs';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobDir = path.join(TEMP_DIR, req.jobId);
    if (!fs.existsSync(jobDir)) {
      fs.mkdirSync(jobDir, { recursive: true });
    }
    cb(null, jobDir);
  },
  filename: (req, file, cb) => {
    // Preserve original filename
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    // Only accept MP3 files
    if (file.mimetype === 'audio/mpeg' || file.originalname.toLowerCase().endsWith('.mp3')) {
      cb(null, true);
    } else {
      cb(new Error('Only MP3 files are allowed'), false);
    }
  }
});

// Middleware to generate job ID before upload
app.use('/transcode', (req, res, next) => {
  req.jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  next();
});

// Simple password protection middleware
const authMiddleware = (req, res, next) => {
  if (!AUTH_PASSWORD) {
    return next();
  }
  
  const providedPassword = req.headers['x-auth-password'] || req.query.password;
  if (providedPassword === AUTH_PASSWORD) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized' });
};

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get service info
app.get('/api/info', (req, res) => {
  res.json({
    maxFileSizeMB: MAX_FILE_SIZE_MB,
    passwordRequired: !!AUTH_PASSWORD,
    hlsConfig: {
      segmentDuration: 10,
      audioCodec: 'aac',
      audioBitrate: '256k',
      sampleRate: 44100,
      channels: 2
    }
  });
});

// Upload and transcode endpoint
app.post('/transcode', authMiddleware, upload.array('files', 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const jobId = req.jobId;
    const files = req.files.map(f => ({
      originalName: f.originalname,
      path: f.path,
      size: f.size
    }));

    console.log(`[${jobId}] Starting transcode job with ${files.length} file(s)`);

    // Start transcoding in background
    transcode(jobId, files).catch(err => {
      console.error(`[${jobId}] Transcode error:`, err);
    });

    res.json({
      jobId,
      files: files.map(f => f.originalName),
      status: 'processing',
      message: 'Transcoding started. Poll /status/:jobId for progress.'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check job status
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = getJobStatus(jobId);
  
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(status);
});

// Download transcoded files as ZIP
app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = getJobStatus(jobId);
  
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (status.status !== 'completed') {
    return res.status(400).json({ error: 'Job not yet completed', status: status.status });
  }
  
  if (!status.zipPath || !fs.existsSync(status.zipPath)) {
    return res.status(404).json({ error: 'ZIP file not found' });
  }
  
  res.download(status.zipPath, `hls-${jobId}.zip`, (err) => {
    if (err) {
      console.error(`[${jobId}] Download error:`, err);
    }
  });
});

// Delete job and cleanup files
app.delete('/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  try {
    cleanupJob(jobId);
    res.json({ success: true, message: 'Job cleaned up' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CORS middleware for cross-origin requests from Focus Music app
app.use('/api/transcode-sync', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-auth-password');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Synchronous transcode endpoint - accepts MP3, returns HLS files as base64
// This is the server-to-server API for Focus Music app integration
app.post('/api/transcode-sync', authMiddleware, upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = req.jobId;
    const file = {
      originalName: req.file.originalname,
      path: req.file.path,
      size: req.file.size
    };

    console.log(`[${jobId}] Sync transcode: ${file.originalName}`);

    // Transcode synchronously
    const { transcodeSync } = await import('./transcode.js');
    const result = await transcodeSync(jobId, file);

    if (!result.success) {
      return res.status(500).json({ 
        error: result.error || 'Transcoding failed',
        jobId 
      });
    }

    // Read HLS files and encode as base64
    const hlsFiles = [];
    for (const hlsFile of result.files) {
      const fileData = fs.readFileSync(hlsFile.path);
      hlsFiles.push({
        name: hlsFile.name,
        size: hlsFile.size,
        contentType: hlsFile.name.endsWith('.m3u8') 
          ? 'application/vnd.apple.mpegurl' 
          : 'video/mp2t',
        data: fileData.toString('base64')
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[${jobId}] Sync transcode complete: ${hlsFiles.length} files in ${duration}ms`);

    // Cleanup job files after sending response
    setTimeout(() => cleanupJob(jobId), 1000);

    res.json({
      success: true,
      jobId,
      originalFileName: file.originalName,
      hlsFolder: result.hlsFolder,
      segmentCount: result.segmentCount,
      files: hlsFiles,
      transcodeDurationMs: duration
    });

  } catch (error) {
    console.error('Sync transcode error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cleanup old jobs periodically
setInterval(() => {
  cleanupOldJobs(JOB_CLEANUP_MINUTES);
}, 5 * 60 * 1000); // Check every 5 minutes

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB` });
    }
    return res.status(400).json({ error: err.message });
  }
  
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           HLS Transcoding Service                          ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                              ║
║  Max file size: ${MAX_FILE_SIZE_MB}MB                                 ║
║  Password protection: ${AUTH_PASSWORD ? 'Enabled' : 'Disabled'}                        ║
║  Job cleanup: ${JOB_CLEANUP_MINUTES} minutes                               ║
╚════════════════════════════════════════════════════════════╝
  `);
});
