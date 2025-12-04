# HLS Transcoder

A simple web service that converts MP3 files to HLS (HTTP Live Streaming) format for Focus Music.

## Features

- **Drag & drop UI** - Simple interface for music editors
- **Batch processing** - Upload multiple MP3 files at once
- **Exact format match** - Produces HLS files compatible with Focus Music
- **ZIP download** - Download all transcoded files in one archive
- **Auto cleanup** - Temporary files are deleted after 1 hour

## HLS Output Format

| Setting | Value |
|---------|-------|
| Segment Duration | 10 seconds |
| Audio Codec | AAC |
| Audio Bitrate | 256 kbps |
| Sample Rate | 44100 Hz |
| Channels | 2 (stereo) |
| Playlist | master.m3u8 |
| Segments | segment_000.ts, segment_001.ts, ... |

## Local Development

### Prerequisites

- Node.js 18+
- FFmpeg installed locally

**Install FFmpeg:**
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get install ffmpeg

# Windows (via Chocolatey)
choco install ffmpeg
```

### Run Locally

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Or production mode
npm start
```

Open http://localhost:3000 in your browser.

## Deploy to Railway

### One-Click Deploy

1. Push this repo to GitHub
2. Go to [Railway](https://railway.app)
3. Click **New Project** → **Deploy from GitHub repo**
4. Select this repository
5. Railway will auto-detect the Dockerfile and deploy

### Environment Variables (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `AUTH_PASSWORD` | Password protection (leave empty for none) | - |
| `MAX_FILE_SIZE_MB` | Maximum file upload size | 500 |
| `MAX_CONCURRENT_JOBS` | Max parallel transcoding jobs | 5 |
| `JOB_CLEANUP_MINUTES` | Auto-delete jobs after X minutes | 60 |

### Add Password Protection

Set `AUTH_PASSWORD` in Railway's environment variables:
1. Go to your Railway project
2. Click **Variables**
3. Add `AUTH_PASSWORD` with your chosen password

Users will need to append `?password=YOUR_PASSWORD` to the URL or set the `x-auth-password` header.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web UI |
| `/health` | GET | Health check |
| `/api/info` | GET | Service info and HLS config |
| `/transcode` | POST | Upload and start transcoding |
| `/status/:jobId` | GET | Check job status |
| `/download/:jobId` | GET | Download HLS files as ZIP |
| `/job/:jobId` | DELETE | Delete job and cleanup files |

## Usage

### Web Interface

1. Open the service URL in your browser
2. Drag & drop MP3 files (or click to browse)
3. Click **Transcode to HLS**
4. Wait for processing to complete
5. Click **Download HLS Files (ZIP)**
6. Extract and use in Focus Music admin upload

### API Usage

```bash
# Upload and transcode
curl -X POST -F "files=@track1.mp3" -F "files=@track2.mp3" http://localhost:3000/transcode

# Check status
curl http://localhost:3000/status/job-123456

# Download result
curl -O http://localhost:3000/download/job-123456
```

## Output Structure

After transcoding, the ZIP file contains:

```
hls-output.zip
├── track1/
│   ├── master.m3u8
│   ├── segment_000.ts
│   ├── segment_001.ts
│   └── ...
├── track2/
│   ├── master.m3u8
│   ├── segment_000.ts
│   └── ...
```

Each folder is named after the original MP3 file (without extension).

## Cost (Railway)

- **Free tier**: 500 hours/month, 512MB RAM - sufficient for ~100 files/month
- **Hobby ($5/mo)**: Unlimited hours, 8GB RAM
- Transcoding takes ~10-30 seconds per track

## Troubleshooting

### "FFmpeg not found"
Ensure FFmpeg is installed. For Railway deployment, the Dockerfile installs it automatically.

### "Job not found"
Jobs are automatically cleaned up after 60 minutes. Download your files promptly.

### Large files timing out
Increase `MAX_FILE_SIZE_MB` if needed. Very long tracks (30+ min) may take longer.

## License

Internal tool for Focus Music. Not for public distribution.
