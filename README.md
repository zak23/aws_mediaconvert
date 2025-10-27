# AWS MediaConvert Video Processing

A simple Node.js script to upload videos to S3 and convert them to MP4 using AWS MediaConvert.

## Features

- Upload videos to S3 with progress tracking
- Automatic video conversion to MP4 (H.264/AAC)
- **Real-time transcoding progress** - See job status updates in terminal
- **Dynamic watermark insertion** - Looping sequential watermark animation
- **Automatic video metadata detection** - Detects video dimensions and duration
- **Smart resolution scaling** - Automatically scales down videos where long edge > 1920px while preserving aspect ratio
- Configurable input/output folders
- Simple CLI interface

## Prerequisites

- Node.js 18+ (ES modules)
- AWS account with S3 and MediaConvert access
- IAM role for MediaConvert (see Setup section)
- **ffmpeg** and **ffprobe** (for video metadata detection)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your AWS credentials and configuration:

```env
# AWS Credentials
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_REGION=us-east-1

# S3 Configuration
S3_BUCKET=your-bucket-name
S3_INPUT_FOLDER=input
S3_OUTPUT_FOLDER=output

# MediaConvert Configuration
MEDIACONVERT_ENDPOINT=https://mediaconvert.us-east-1.amazonaws.com
MEDIACONVERT_ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/service-role/MediaConvert_Default_Role
MEDIACONVERT_QUEUE_ARN=arn:aws:mediaconvert:us-east-1:ACCOUNT_ID:queues/Default
MEDIACONVERT_POLL_INTERVAL_MS=5000  # Optional: Progress check interval in ms (default: 5000)
```

### 3. Set Up IAM Role for MediaConvert

MediaConvert requires an IAM role with S3 access. Create a role with the following policies:

- `AmazonS3FullAccess` (or custom policy with read/write access to your bucket)
- MediaConvert service trust relationship

The role ARN should be added to `MEDIACONVERT_ROLE_ARN` in your `.env` file.

## Usage

Run the script with a video file path:

```bash
node index.js ./path-to-your-video.mp4
```

Or use npm:

```bash
npm start ./path-to-your-video.mp4
```

The script will:
1. Upload the video to your S3 bucket in the input folder
2. Create a MediaConvert job to convert it to MP4
3. Monitor job progress in real-time with terminal updates
4. Output the converted video to the output folder in S3

## Supported Video Formats

- MP4 (.mp4)
- MOV (.mov)
- AVI (.avi)
- MKV (.mkv)
- WebM (.webm)
- FLV (.flv)

## Output Format

- Container: MP4
- Video Codec: H.264 (max 5 Mbps, high quality)
- Audio Codec: AAC (128 kbps, 48 kHz)
- **Resolution**: Automatically scales down videos where the long edge exceeds 1920 pixels while preserving aspect ratio

### Automatic Resolution Scaling

The script automatically detects your video dimensions and scales them down if necessary:

- **Long edge ≤ 1920px**: Original resolution preserved
- **Long edge > 1920px**: Scaled down to 1920px on the long edge while maintaining aspect ratio

**Examples:**
- `3840x2160` → `1920x1080` (scaled by 0.5)
- `2560x1440` → `1920x1080` (scaled by 0.75)
- `1920x1080` → `1920x1080` (unchanged)
- `1280x720` → `1280x720` (unchanged)

## Watermark Feature

The script automatically adds a **looping watermark animation** to your videos:

### How it Works

1. **Automatic Detection**: The script detects your video's dimensions and duration
2. **Sequential Animation**: Watermark appears in each corner sequentially (top-left → top-right → bottom-left → bottom-right)
3. **Continuous Loop**: The sequence repeats throughout the entire video
4. **Smart Positioning**: Watermarks are automatically positioned based on video dimensions

### Watermark Configuration

The watermark size and position are **automatically calculated** based on your video dimensions:

```javascript
// Automatic size calculation (in mediaconvert.js)
calculateWatermarkSize(videoWidth, videoHeight, percentSize = 8, minSize = 60)
calculateWatermarkOffset(videoWidth, videoHeight)

// Configuration options
{
  videoWidth: videoMetadata.width,      // Auto-detected
  videoHeight: videoMetadata.height,    // Auto-detected  
  videoDurationMs: videoMetadata.durationMs, // Auto-detected
  watermarkSize: calculatedSize,         // 8% of smaller dimension, min 60px
  offset: calculatedOffset,             // 3-5% of smaller dimension, min 30px
  durationMs: 2000,                     // Duration per corner (2 seconds)
  opacity: 80,                          // Opacity (0-100)
  watermarkUri: `s3://bucket/assets/watermark.png`
}
```

**Size Examples:**
- 1920x1080 video → 86px watermark (8% of 1080, min 60px)
- 3840x2160 video → 173px watermark (8% of 2160)
- 720x480 video → 60px watermark (8% = 38px, but minimum 60px applied)

### Watermark Asset

Place your watermark image at `s3://your-bucket/assets/watermark.png`

## S3 Structure

```
your-bucket/
├── input/
│   └── your-video.mp4          # Uploaded source file
└── output/
    └── your-video_TIMESTAMP.mp4  # Converted output file
```

## Real-Time Progress Monitoring

The script now monitors job progress in real-time and displays updates in your terminal:

```
=== AWS MediaConvert Video Processing ===

Uploading to S3: input/my-video.mp4
Upload progress: 100%

Creating MediaConvert job...
MediaConvert job created: abc123-def456-ghi789

📊 Monitoring transcoding progress...

[10:30:15] ⏳ Job submitted (0s elapsed)
[10:30:20] 🎬 Job progressing... (5s elapsed)
     Current phase: Transcoding
[10:30:45] 🎬 Job progressing... (30s elapsed)
     Current phase: Transcoding
[10:31:15] ✅ Job completed successfully! (60s total)
     Output file: s3://your-bucket/output/

=== Processing Complete ===
S3 Output Location: s3://your-bucket/output/
```

### Status Updates

The terminal shows real-time updates for:
- ⏳ **SUBMITTED** - Job queued for processing
- 🎬 **PROGRESSING** - Actively transcoding (with current phase)
- ✅ **COMPLETE** - Successfully finished
- ❌ **ERROR** - Job failed (with error details)

### Configuration Options

Control the polling interval via the `.env` file:

```env
# How often to check job status (in milliseconds)
# Default: 5000ms (5 seconds)
# Faster updates: 2000ms
# Slower updates: 10000ms
MEDIACONVERT_POLL_INTERVAL_MS=5000
```

### Manual Monitoring

You can also monitor jobs in the AWS Console:
1. Go to AWS MediaConvert service
2. Navigate to "Jobs"
3. Find your job by ID
4. Check the status and progress

## Error Handling

The script includes comprehensive error handling:
- File existence validation
- Upload progress tracking
- MediaConvert job creation verification
- Clear error messages for troubleshooting

## Troubleshooting

### Common Issues

**"File not found"**
- Ensure the file path is correct and the file exists

**"AWS credentials not configured"**
- Check your `.env` file has valid AWS credentials

**"Access Denied" or permission errors**
- Verify IAM role has proper S3 and MediaConvert permissions
- Check bucket policies allow your account

**"Region mismatch"**
- Ensure MediaConvert endpoint matches your AWS region

## Project Structure

```
.
├── config.js           # Configuration loader
├── upload.js           # S3 upload module
├── mediaconvert.js     # MediaConvert job module
├── index.js            # Main script
├── package.json        # Node.js dependencies
├── .env               # Environment variables (not in git)
├── .env.example       # Example environment file
└── README.md          # This file
```

## License

ISC

