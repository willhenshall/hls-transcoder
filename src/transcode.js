import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';

const TEMP_DIR = '/tmp/hls-jobs';

// In-memory job status tracking
const jobs = new Map();

// HLS Configuration - matches Focus Music requirements
const HLS_CONFIG = {
  segmentDuration: 10,      // seconds
  audioCodec: 'aac',
  audioBitrate: '256k',
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
 * Transcode a single MP3 file to HLS
 */
function transcodeFile(inputPath, outputDir, fileName) {
  return new Promise((resolve, reject) => {
    const baseName = path.basename(fileName, '.mp3');
    const hlsDir = path.join(outputDir, baseName);
    
    // Create HLS output directory
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }
    
    const masterPlaylist = path.join(hlsDir, 'master.m3u8');
    const segmentPattern = path.join(hlsDir, 'segment_%03d.ts');
    
    const ffmpegArgs = [
      '-i', inputPath,
      '-c:a', HLS_CONFIG.audioCodec,
      '-b:a', HLS_CONFIG.audioBitrate,
      '-ar', HLS_CONFIG.sampleRate.toString(),
      '-ac', HLS_CONFIG.channels.toString(),
      '-hls_time', HLS_CONFIG.segmentDuration.toString(),
      '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      '-hls_flags', 'independent_segments',
      '-y',
      masterPlaylist
    ];
    
    console.log(`[FFmpeg] Transcoding: ${fileName}`);
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    
    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Count segments
        const files = fs.readdirSync(hlsDir);
        const segmentCount = files.filter(f => f.endsWith('.ts')).length;
        
        console.log(`[FFmpeg] Completed: ${fileName} (${segmentCount} segments)`);
        
        resolve({
          success: true,
          hlsFolder: baseName,
          segmentCount,
          hlsDir
        });
      } else {
        console.error(`[FFmpeg] Failed: ${fileName}`, stderr.slice(-500));
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      console.error(`[FFmpeg] Error: ${fileName}`, err);
      reject(err);
    });
  });
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
        // Add the HLS folder
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
  
  console.log(`[Job ${jobId}] Starting transcode of ${files.length} file(s)`);
  
  try {
    // Process each file
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
    
    // Check if any files succeeded
    const successfulFiles = job.files.filter(f => f.status === 'completed');
    
    if (successfulFiles.length > 0) {
      // Create ZIP of all HLS folders
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
