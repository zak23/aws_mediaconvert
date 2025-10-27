# AWS MediaConvert Video Processing

A simple Node.js script to upload videos to S3 and convert them to MP4 using AWS MediaConvert.

> 📚 **For Laravel Conversion**: See [ARCHITECTURE.md](ARCHITECTURE.md) for comprehensive architecture documentation and Laravel conversion guide.

## Features

- Upload videos to S3 with progress tracking
- Automatic video conversion to MP4 (H.264/AAC)
- **Real-time transcoding progress** - See job status updates in terminal
- **Dynamic watermark insertion** - Looping sequential watermark animation
- **Automatic video metadata detection** - Detects video dimensions and duration
- **Automatic rotation handling** - Correctly handles portrait videos with rotation metadata
- **Smart resolution scaling** - Automatically scales down videos where long edge > 1920px while preserving aspect ratio
- **Automatic download** - Downloads processed videos from S3 to local `outputs/` directory
- **File size tracking** - Logs initial and completed file sizes with compression ratio
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

#### Required IAM Permissions

Your AWS user/role needs the following IAM permissions to run this script:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "S3BucketFullAccess",
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:DeleteObject",
                "s3:ListBucket",
                "s3:GetObjectAttributes",
                "s3:PutObjectAcl",
                "s3:GetObjectVersion",
                "s3:DeleteObjectVersion"
            ],
            "Resource": [
                "arn:aws:s3:::your-bucket-name",
                "arn:aws:s3:::your-bucket-name/*"
            ]
        },
        {
            "Sid": "ElasticTranscoderJobManagement",
            "Effect": "Allow",
            "Action": [
                "elastictranscoder:CreateJob",
                "elastictranscoder:ReadJob",
                "elastictranscoder:ReadPreset",
                "elastictranscoder:ReadPipeline",
                "elastictranscoder:ListJobsByPipeline",
                "elastictranscoder:ListJobsByStatus"
            ],
            "Resource": "*"
        },
        {
            "Sid": "MediaConvertJobManagement",
            "Effect": "Allow",
            "Action": [
                "mediaconvert:CreateJob",
                "mediaconvert:GetJob",
                "mediaconvert:ListJobs",
                "mediaconvert:CancelJob",
                "mediaconvert:ListJobTemplates",
                "mediaconvert:GetJobTemplate",
                "mediaconvert:DescribeEndpoints"
            ],
            "Resource": "*"
        },
        {
            "Sid": "SNSTopicPublish",
            "Effect": "Allow",
            "Action": [
                "sns:Publish",
                "sns:GetTopicAttributes",
                "sns:ListTopics",
                "sns:Subscribe",
                "sns:Unsubscribe"
            ],
            "Resource": "*"
        },
        {
            "Sid": "IAMPassRoleForMediaConvert",
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "arn:aws:iam::ACCOUNT_ID:role/service-role/MediaConvert_Default_Role"
        }
    ]
}
```

**Important Notes:**
- Replace `your-bucket-name` with your actual S3 bucket name
- Replace `ACCOUNT_ID` with your AWS account ID
- Replace `MediaConvert_Default_Role` with the actual MediaConvert role name you create
- You can attach this policy directly to your IAM user/role in the AWS Console

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
4. Download the processed video from S3 to the local `outputs/` directory
5. The processed video will be saved in the `outputs/` folder with a timestamped filename

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

- **Long edge ≤ 1920px**: Original resolution preserved (with even dimension adjustment if needed)
- **Long edge > 1920px**: Scaled down to 1920px on the long edge while maintaining aspect ratio

**Important Note:** MediaConvert requires all dimensions to be even numbers. The script automatically adjusts dimensions to be even (rounds down if necessary).

**Examples:**
- `3840x2160` → `1920x1080` (scaled by 0.5)
- `2560x1440` → `1920x1080` (scaled by 0.75)
- `1920x1080` → `1920x1080` (unchanged)
- `1280x720` → `1280x720` (unchanged)
- `1921x1081` → `1920x1080` (even dimension adjustment)
- `1079x1920` → `1078x1920` (even dimension adjustment)

### Automatic Rotation Handling

The script automatically detects and handles portrait videos with rotation metadata:

- **Detection**: Checks rotation metadata in video files (e.g., -90°, 90°, 270°)
- **Dimension Swap**: Swaps width and height for portrait videos (640x360 → 360x640)
- **MediaConvert Rotation**: Applies `Rotate: 'AUTO'` to MediaConvert job settings for automatic rotation
- **Smart Handling**: Ensures videos display correctly without being sideways

**Example:**
- Portrait video with -90° rotation: Detected and converted to proper orientation
- Landscape video: No rotation applied, processed normally

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

**Requirements:**
- Format: PNG with transparency
- Recommended size: 512x512px or larger
- Location: Must be in the `assets/` folder in your S3 bucket

**Upload Command:**
```bash
aws s3 cp watermark.png s3://your-bucket/assets/watermark.png
```

### Watermark Troubleshooting

#### Watermark Not Appearing

**Problem**: Watermark doesn't show in output video

**Solutions**:

1. **Check S3 Upload**
   ```bash
   aws s3 ls s3://your-bucket/assets/
   # Should show: watermark.png
   ```

2. **Verify IAM Permissions**
   - MediaConvert role must have `s3:GetObject` permission for the watermark
   - Add to your MediaConvert IAM role policy:
   ```json
   {
     "Effect": "Allow",
     "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::your-bucket/assets/*"
   }
   ```

3. **Check Console Output**
   - Look for watermark configuration in console:
   ```
   🔍 Watermark Sequence Generated:
     Total: 6 watermarks
     [0] Start=00:00:00:00, Duration=2000ms, Pos=(32,32), Size=108x108
   ```
   - If Duration is missing or shows as timecode string, update your code

4. **Image Quality**
   - Use high-resolution watermark (512x512px minimum)
   - Ensure PNG has transparent background
   - Check opacity setting (default: 80%)

5. **Verify Video Duration**
   - Watermarks need at least 2 seconds to show
   - Very short videos (<2s) may not display watermarks

#### Watermarks Overlap or Don't Alternate

**Problem**: All watermarks appear in same position or overlap

**Cause**: Missing or incorrect `Duration` field

**Solution**: Ensure `Duration` is integer milliseconds:
```javascript
// ✅ Correct
Duration: 2000  // Integer milliseconds

// ❌ Wrong
Duration: "00:00:02:00"  // Timecode string
// ❌ Wrong  
// Duration field missing
```

#### Watermark Too Small or Large

**Problem**: Watermark size doesn't match video

**Cause**: Automatic sizing based on video dimensions

**Solution**: Adjust percentage in `calculateWatermarkSize()`:
```javascript
// Current: 10% of smaller dimension, min 80px
calculateWatermarkSize(videoWidth, videoHeight, 10, 80)

// Larger watermark: 15% of smaller dimension, min 100px
calculateWatermarkSize(videoWidth, videoHeight, 15, 100)
```

#### Watermark Cut Off or Off-Screen

**Problem**: Watermark partially visible or missing

**Cause**: Incorrect position calculation for rotated videos

**Solution**: System now correctly calculates watermarks based on **POST-ROTATION** dimensions
- MediaConvert applies rotation FIRST, then inserts watermarks on rotated output
- Watermarks are positioned on final output resolution (after rotation and scaling)
- Check console output for "Watermark Configuration" section

**Example**:
```
💧 Watermark Configuration:
  Output Resolution: 1080x1920
  Watermark Size: 108x108px
  Offset: 32px from edges
  Opacity: 80%
  Animation: Looping sequence (top-left & bottom-right, 2s per corner)
```

## S3 Structure

```
your-bucket/
├── input/
│   └── your-video.mp4          # Uploaded source file
└── output/
    └── your-video_TIMESTAMP.mp4  # Converted output file (in S3)

Local project:
├── inputs/                       # Local input videos
├── outputs/                      # Downloaded processed videos
└── your-video_TIMESTAMP.mp4    # Downloaded from S3
```

## Automatic Download Feature

When processing is complete, the script automatically downloads the processed video from S3 to your local `outputs/` directory:

- **Progress tracking**: Shows download progress percentage in real-time
- **Automatic directory creation**: Creates `outputs/` directory if it doesn't exist
- **Timestamped filenames**: Prevents overwriting previous outputs
- **Smart naming**: Preserves original filename with MediaConvert modifiers
- **Retry mechanism**: Waits for file to appear in S3 (MediaConvert sometimes completes before file is fully written)

**Example:**
```
input/video.mp4 → outputs/video_1734567890.mp4
```

**Note**: The script waits up to 60 seconds for the processed file to appear in S3 before attempting to download (with 5-second intervals). This ensures reliable downloads even though MediaConvert job completion doesn't always guarantee the S3 file is immediately available.

**Important**: The output file extension is automatically determined from the MediaConvert container settings (defaults to `.mp4`). For example:
- Input: `video.mov` → Output: `video_TIMESTAMP.mp4`
- Input: `video.mkv` → Output: `video_TIMESTAMP.mp4`

## Real-Time Progress Monitoring

The script now monitors job progress in real-time and displays updates in your terminal:

```
=== AWS MediaConvert Video Processing ===

📁 Initial file size: 25.30 MB (26,534,912 bytes)

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
     Output file: s3://your-bucket/output/my-video_1734567890.mp4

=== Processing Complete ===
S3 Output Location: s3://your-bucket/output/my-video_1734567890.mp4

📥 Downloading my-video_1734567890.mp4 from S3...
⏳ Waiting for file to appear in S3...
   Attempt 1/12: File not ready yet, waiting 5s...
✅ File found in S3 (attempt 2)
Download progress: 100%

✅ Download complete: outputs/my-video_1734567890.mp4

📁 Completed file size: 18.50 MB (19,398,656 bytes)
📊 Compression ratio: 26.9% smaller

🎉 All done! Processed video saved locally.
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
├── config.js                # Configuration loader
├── upload.js                 # S3 upload/download module
├── mediaconvert.js           # MediaConvert job module
├── index.js                  # Main script
├── package.json              # Node.js dependencies
├── .env                      # Environment variables (not in git)
├── .env.example              # Example environment file
├── inputs/                   # Local input videos
├── outputs/                      # Downloaded processed videos
├── README.md                     # This file
├── ARCHITECTURE.md               # Complete architecture documentation
├── LARAVEL_CONVERSION_GUIDE.md   # Quick Laravel conversion guide
└── DOCUMENTATION_SUMMARY.md      # Documentation overview
```

## Documentation

- **[README.md](README.md)** - This file: Usage guide and quick start
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Complete architecture documentation:
  - System overview and data flow
  - Module breakdown with code examples
  - AWS services integration
  - Technical specifications
  - Laravel conversion guide with PHP code
  - API specification
  - Database schema
  - Testing strategy
- **[LARAVEL_CONVERSION_GUIDE.md](LARAVEL_CONVERSION_GUIDE.md)** - Quick-start checklist for Laravel conversion
- **[DOCUMENTATION_SUMMARY.md](DOCUMENTATION_SUMMARY.md)** - Overview of all documentation

## License

ISC

