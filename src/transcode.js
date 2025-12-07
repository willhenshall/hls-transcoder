import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';

const TEMP_DIR = '/tmp/hls-jobs';

// In-memory job status tracking
const jobs = new Map();

// 4-Bitrate Ladder Configuration
const BITRATE_LADDER = [
  { name: 'low', bitrate: '32k', bandwidth: 48000 },
  { name: 'medium', bitrate: '64k', bandwidth: 96000 },
  { name: 'high', bitrate: '96k', bandwidth: 144000 },
  { name: 'premium', bitrate: '128k', bandwidth: 192000 },
];

// HLS Configuration
const HLS_CONFIG = {
  segmentDuration: 6,       // seconds (optimized for mobile)
  audioCodec: 'aac',
  sampleRate: 44100,
  channels: 2,
};

/**
 * Initialize a job status entry
 */
function initJob(jobId, files) {
  const job = {
    jobId,
    status: 'processing',
    startedAt: new Date().toISOString(),
    files: files.map(f => ({
      name: f.originalName,
      status: 'pending',
      hlsFolder: null,
      segmentCount: 0,
      error: null
    })),
    completedFiles: 0,
    failedFiles: 0,
    zipPath: null,
    error: null
  };
  jobs.set(jobId, job);
  return job;
}

/**
 * Update job file status
 */
function updateFileStatus(jobId, fileName, updates) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  const file = job.files.find(f => f.name === fileName);
  if (file) {
    Object.assign(file, updates);
  }
  
  // Update overall job status
  job.completedFiles = job.files.filter(f => f.status === 'completed').length;
  job.failedFiles = job.files.filter(f => f.status === 'failed').length;
}

/**
 * Get job status
 */
export function getJobStatus(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Transcode a single MP3 file to a single HLS variant
 */
function transcodeVariant(inputPath, outputDir, bitrate) {
  return new Promise((resolve, reject) => {
    const indexFile = path.join(outputDir, 'index.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%03d.ts');
    
    const ffmpegArgs = [
      '-i', inputPath,
      '-c:a', HLS_CONFIG.audioCodec,
      '-b:a', bitrate,
      '-ar', HLS_CONFIG.sampleRate.toString(),
      '-ac', HLS_CONFIG.channels.toString(),
      '-f', 'hls',
      '-hls_time', HLS_CONFIG.segmentDuration.toString(),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', segmentPattern,
      '-y',
      indexFile
    ];
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    
    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        const files = fs.readdirSync(outputDir);
        const segmentCount = files.filter(f => f.endsWith('.ts')).length;
        resolve({ success: true, segmentCount });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Generate the master playlist referencing all variants
 */
function generateMasterPlaylist() {
  return `#EXTM3U
#EXT-X-VERSION:3

# 32 kbps LOW
#EXT-X-STREAM-INF:BANDWIDTH=48000,CODECS="mp4a.40.2"
low/index.m3u8

# 64 kbps MEDIUM
#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"
medium/index.m3u8

# 96 kbps HIGH
#EXT-X-STREAM-INF:BANDWIDTH=144000,CODECS="mp4a.40.2"
high/index.m3u8

# 128 kbps PREMIUM
#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"
premium/index.m3u8
`;
}

/**
 * Transcode a single MP3 file to 4-bitrate HLS ladder
 */
async function transcodeFile(inputPath, outputDir, fileName) {
  const baseName = path.basename(fileName, '.mp3');
  const hlsDir = path.join(outputDir, baseName);
  
  // Create directories for each variant
  for (const variant of BITRATE_LADDER) {
    fs.mkdirSync(path.join(hlsDir, variant.name), { recursive: true });
  }
  
  console.log(`[FFmpeg] Transcoding 4-bitrate ladder: ${fileName}`);
  
  const variants = [];
  let totalSegments = 0;
  
  // Transcode each variant
  for (const variant of BITRATE_LADDER) {
    const variantDir = path.join(hlsDir, variant.name);
    console.log(`[FFmpeg]   ${variant.name} (${variant.bitrate})...`);
    
    const result = await transcodeVariant(inputPath, variantDir, variant.bitrate);
    
    variants.push({
      name: variant.name,
      bitrate: parseInt(variant.bitrate),
      bandwidth: variant.bandwidth,
      segmentCount: result.segmentCount
    });
    
    totalSegments += result.segmentCount;
    console.log(`[FFmpeg]   ✓ ${variant.name}: ${result.segmentCount} segments`);
  }
  
  // Generate master playlist
  const masterContent = generateMasterPlaylist();
  fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), masterContent);
  
  console.log(`[FFmpeg] Completed: ${fileName} (${totalSegments} total segments across 4 variants)`);
  
  return {
    success: true,
    hlsFolder: baseName,
    segmentCount: totalSegments,
    hlsDir,
    variants,
    isMultiBitrate: true
  };
}

/**
 * Create ZIP archive of all HLS folders
 */
function createZipArchive(jobId, outputDir) {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(outputDir, `hls-output.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });
    
    output.on('close', () => {
      console.log(`[ZIP] Created: ${zipPath} (${archive.pointer()} bytes)`);
      resolve(zipPath);
    });
    
    archive.on('error', (err) => {
      reject(err);
    });
    
    archive.pipe(output);
    
    // Add each HLS folder to the archive
    const items = fs.readdirSync(outputDir);
    for (const item of items) {
      const itemPath = path.join(outputDir, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory() && item !== 'uploads') {
        archive.directory(itemPath, item);
      }
    }
    
    archive.finalize();
  });
}

/**
 * Main transcode function - processes all files in a job
 */
export async function transcode(jobId, files) {
  const job = initJob(jobId, files);
  const jobDir = path.join(TEMP_DIR, jobId);
  
  console.log(`[Job ${jobId}] Starting 4-bitrate ladder transcode of ${files.length} file(s)`);
  
  try {
    for (const file of files) {
      updateFileStatus(jobId, file.originalName, { status: 'processing' });
      
      try {
        const result = await transcodeFile(file.path, jobDir, file.originalName);
        
        updateFileStatus(jobId, file.originalName, {
          status: 'completed',
          hlsFolder: result.hlsFolder,
          segmentCount: result.segmentCount
        });
      } catch (err) {
        console.error(`[Job ${jobId}] File failed: ${file.originalName}`, err.message);
        
        updateFileStatus(jobId, file.originalName, {
          status: 'failed',
          error: err.message
        });
      }
    }
    
    const successfulFiles = job.files.filter(f => f.status === 'completed');
    
    if (successfulFiles.length > 0) {
      console.log(`[Job ${jobId}] Creating ZIP archive...`);
      const zipPath = await createZipArchive(jobId, jobDir);
      
      job.zipPath = zipPath;
      job.status = job.failedFiles > 0 ? 'completed_with_errors' : 'completed';
    } else {
      job.status = 'failed';
      job.error = 'All files failed to transcode';
    }
    
    job.completedAt = new Date().toISOString();
    
    console.log(`[Job ${jobId}] Finished: ${job.status}`);
    
  } catch (error) {
    console.error(`[Job ${jobId}] Fatal error:`, error);
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
  }
  
  return job;
}

/**
 * Cleanup a specific job
 */
export function cleanupJob(jobId) {
  const jobDir = path.join(TEMP_DIR, jobId);
  
  if (fs.existsSync(jobDir)) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    console.log(`[Cleanup] Removed job directory: ${jobId}`);
  }
  
  jobs.delete(jobId);
}

/**
 * Cleanup jobs older than specified minutes
 */
export function cleanupOldJobs(maxAgeMinutes) {
  const now = Date.now();
  const maxAge = maxAgeMinutes * 60 * 1000;
  
  for (const [jobId, job] of jobs.entries()) {
    const jobAge = now - new Date(job.startedAt).getTime();
    
    if (jobAge > maxAge) {
      console.log(`[Cleanup] Removing old job: ${jobId} (age: ${Math.round(jobAge / 60000)} min)`);
      cleanupJob(jobId);
    }
  }
}

/**
 * Collect all HLS files from output directory (recursive)
 */
function collectHLSFiles(hlsDir) {
  const files = [];
  
  function readDir(dir, prefix = '') {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relativePath = prefix ? `${prefix}/${item}` : item;
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        readDir(fullPath, relativePath);
      } else {
        files.push({
          name: relativePath,
          path: fullPath,
          size: stat.size
        });
      }
    }
  }
  
  readDir(hlsDir);
  return files;
}

/**
 * Synchronous transcode for single file - returns HLS files directly
 * Creates 4-bitrate ladder for ABR streaming
 */
export async function transcodeSync(jobId, file) {
  const jobDir = path.join(TEMP_DIR, jobId);
  
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }
  
  console.log(`[Job ${jobId}] Sync 4-bitrate transcode: ${file.originalName}`);
  
  try {
    const result = await transcodeFile(file.path, jobDir, file.originalName);
    
    // Collect all HLS files (master + 4 variants with segments)
    const hlsFiles = collectHLSFiles(result.hlsDir);
    
    console.log(`[Job ${jobId}] Sync transcode success: ${hlsFiles.length} files (4 variants)`);
    
    return {
      success: true,
      hlsFolder: result.hlsFolder,
      segmentCount: result.segmentCount,
      files: hlsFiles,
      variants: result.variants,
      isMultiBitrate: true
    };
    
  } catch (error) {
    console.error(`[Job ${jobId}] Sync transcode failed:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Export bitrate ladder for health check
export { BITRATE_LADDER };
