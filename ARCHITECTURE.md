# AWS MediaConvert - Architecture Documentation

This document provides comprehensive architecture and technical details for converting this Node.js application to Laravel.

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Data Flow](#data-flow)
4. [Module Breakdown](#module-breakdown)
5. [AWS Services Integration](#aws-services-integration)
6. [Technical Specifications](#technical-specifications)
7. [Laravel Conversion Guide](#laravel-conversion-guide)
8. [API Specification](#api-specification)
9. [Database Schema](#database-schema)
10. [Error Handling](#error-handling)
11. [Testing Strategy](#testing-strategy)

---

## System Overview

This is a **video processing CLI application** that uploads videos to AWS S3 and converts them using AWS MediaConvert with the following features:

### Core Functionality

1. **Video Upload**: Streams video files to S3 with progress tracking
2. **Metadata Detection**: Extracts video properties (dimensions, duration, bitrate) using FFprobe
3. **MediaConvert Job Creation**: Creates transcoding jobs with intelligent settings
4. **Progress Monitoring**: Real-time job status polling and updates
5. **Automatic Download**: Downloads processed videos from S3
6. **File Size Tracking**: Logs compression statistics

### Key Features

- **Automatic Resolution Scaling**: Scales down videos exceeding 1920px long edge
- **Even Dimension Enforcement**: Ensures all dimensions are even numbers (MediaConvert requirement)
- **Automatic Rotation Handling**: Detects portrait video rotation metadata and handles orientation correctly
- **Dynamic Watermarking**: Looping watermark animation sequence
- **Smart Bitrate Calculation**: Adjusts bitrate based on resolution scaling
- **Timestamped Output**: Prevents filename collisions

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    CLI (index.js)                        │
│  • Orchestrates workflow                                 │
│  • Handles CLI arguments                                 │
│  • Formats file sizes                                    │
│  • Tracks compression ratio                              │
└──────────────────┬──────────────────────────────────────┘
                   │
        ┌──────────┴──────────┬─────────────────────┐
        │                     │                     │
┌───────▼────────┐  ┌─────────▼───────┐  ┌─────────▼─────────┐
│  config.js     │  │  upload.js       │  │ mediaconvert.js   │
│                │  │                  │  │                   │
│ • Load .env    │  │ • Upload to S3   │  │ • Create job      │
│ • Validate     │  │ • Download S3    │  │ • Monitor status  │
│ • AWS config   │  │ • Progress track │  │ • Parse output    │
└────────────────┘  │ • FFprobe        │  │ • Watermarks      │
                    │ • Bitrate        │  │ • Resolution calc │
                    └────────┬─────────┘  └──────────┬────────┘
                             │                     │
                  ┌───────────┴──────────┐  ┌───────▼────────┐
                  │                      │  │   FFprobe      │
                  │    AWS Services      │  │   (fluent)     │
                  │                      │  └───────────────┘
                  │  ┌────────┬────────┐ │
                  │  │   S3   │  Media │ │
                  │  │ Client │ Convert│ │
                  └──┼────────┼────────┼─┘
                     └───▲────┴────▲───┘
                         │        │
                    ┌────┴────┐  ┌─┴──────────┐
                    │   S3    │  │ MediaConvert│
                    │  Bucket │  │   Service   │
                    └─────────┘  └─────────────┘
```

---

## Data Flow

### Complete Workflow

```
1. CLI receives file path
   └─► Validate file exists
   └─► Get initial file size

2. Upload to S3 (upload.js)
   └─► Read file bitrate with FFprobe
   └─► Stream file to S3 (multipart)
   └─► Progress tracking
   └─► Return S3 URI (s3://bucket/input/file.mp4)

3. Create MediaConvert Job (mediaconvert.js)
   └─► Read video metadata with FFprobe
       ├─ Duration (ms)
       ├─ Dimensions (width x height)
       └─ Bitrate (bps)
   └─► Calculate output resolution
       ├─ If long edge > 1920px: scale down
       └─ Ensure even dimensions
   └─► Calculate output bitrate
       └─ Scale by resolution factor
   └─► Calculate watermark settings
       ├─ Size (10% of smaller dim, min 80px)
       └─ Offset (3-5% of smaller dim, min 20px)
   └─► Generate watermark sequence
       └─ Looping animation (2s per corner)
   └─► Create job with settings
   └─► Return job ID

4. Monitor Job Progress (mediaconvert.js)
   └─► Poll job status every 5s
   └─► Display updates:
       ├─ SUBMITTED
       ├─ PROGRESSING (with phase)
       ├─ COMPLETE
       └─ ERROR
   └─► Extract output URI from completed job
   └─► Return { job, outputUri }

5. Download from S3 (upload.js)
   └─► Wait for file to appear in S3 (poll 12x, 5s apart)
   └─► Stream download from S3
   └─► Progress tracking
   └─► Save to outputs/ directory
   └─► Calculate compression ratio

6. Display Results
   └─► Initial file size
   └─► Completed file size
   └─► Compression ratio
```

---

## Module Breakdown

### 1. config.js

**Purpose**: Environment configuration and validation

**Exports**:
```javascript
export const config = {
  aws: {
    accessKeyId: string,
    secretAccessKey: string,
    region: string (default: 'us-east-1')
  },
  s3: {
    bucket: string,
    inputFolder: string (default: 'input'),
    outputFolder: string (default: 'output')
  },
  mediaconvert: {
    endpoint: string,
    roleArn: string,
    queueArn: string (optional),
    pollIntervalMs: number (default: 5000)
  }
}
```

**Responsibilities**:
- Load environment variables via `dotenv`
- Validate required AWS credentials
- Validate S3 bucket configuration
- Validate MediaConvert role ARN
- Set defaults for optional values
- Exit with error if validation fails

**Key Logic**:
- Validates on module load (fail-fast approach)
- Provides sensible defaults (us-east-1, input/output folders)
- Constructs MediaConvert endpoint URL if not provided

---

### 2. upload.js

**Purpose**: S3 file operations and video metadata extraction

**Exports**:
```javascript
export async function uploadToS3(filePath: string): Promise<string>
export async function downloadFromS3(s3Uri: string, localPath: string): Promise<string>
```

**Dependencies**:
- `@aws-sdk/client-s3` - S3Client, GetObjectCommand, HeadObjectCommand
- `@aws-sdk/lib-storage` - Upload (multipart)
- `fluent-ffmpeg` - Video metadata via ffprobe
- `fs` - File operations
- `path` - Path utilities

**Key Functions**:

#### `getVideoBitrate(videoPath: string): Promise<number>`
- Uses FFprobe to extract video bitrate
- Returns bitrate in bps (bits per second)
- Handles errors gracefully

#### `uploadToS3(filePath: string): Promise<string>`
- Validates file exists
- Determines S3 key: `inputFolder/filename`
- Gets video bitrate for logging
- Creates multipart upload with streaming
- Tracks progress percentage
- Returns S3 URI: `s3://bucket/key`

#### `downloadFromS3(s3Uri: string, localPath: string): Promise<string>`
- Parses S3 URI to extract bucket and key
- Waits for file to appear in S3 (polling)
- Streams download with progress tracking
- Creates output directory if needed
- Returns local file path

#### `waitForS3Object(bucket, key, maxAttempts, delayMs): Promise<boolean>`
- Polls S3 with HeadObjectCommand
- Retries up to 12 times (60s total)
- 5-second intervals between attempts
- Handles NOT_FOUND errors gracefully

**Content Type Mapping**:
```javascript
{
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.flv': 'video/x-flv'
}
```

**Progress Tracking**:
- Upload: `httpUploadProgress` event handler
- Download: Custom chunk collection with byte counting
- Updates via `process.stdout.write()` with carriage return

---

### 3. mediaconvert.js

**Purpose**: MediaConvert job creation, monitoring, and video processing configuration

**Exports**:
```javascript
export async function createMediaConvertJob(inputUri: string, localFilePath?: string): Promise<string>
export async function getJobStatus(jobId: string): Promise<Object>
export async function monitorJobProgress(jobId: string): Promise<{ job, outputUri }>
```

**Dependencies**:
- `@aws-sdk/client-mediaconvert` - MediaConvertClient, CreateJobCommand, GetJobCommand
- `fluent-ffmpeg` - Video metadata via ffprobe
- `child_process` - Shell execution

**Key Functions**:

#### `getVideoMetadata(videoPath: string): Promise<Object>`
- Uses FFprobe to extract:
  - `durationMs`: Video duration in milliseconds
  - `width`: Video width in pixels
  - `height`: Video height in pixels
  - `bitrate`: Video bitrate in bps
- **Rotation Detection**: Detects rotation metadata and swaps width/height for portrait videos
  - Checks `stream_side_data_list` for rotation value
  - If rotation is 90° or -90° (or 270°/-270°), swaps dimensions
  - Logs rotation detection and dimension swap
- Returns: `{ durationMs, width, height, bitrate }`

#### `calculateOutputResolution(width, height, maxLongEdge): Object`
**Purpose**: Scale down videos exceeding max dimension while preserving aspect ratio

**Logic**:
```
1. Calculate long edge = max(width, height)
2. If long edge <= maxLongEdge:
   └─► Ensure even dimensions (round down)
   └─► Return { width, height }
3. Else:
   └─► Calculate scale factor = maxLongEdge / longEdge
   └─► Scale both dimensions proportionally
   └─► Ensure even dimensions (round down)
   └─► Return { width, height }
```

**Examples**:
- `3840x2160` → `1920x1080` (scale: 0.5)
- `2560x1440` → `1920x1080` (scale: 0.75)
- `1920x1080` → `1920x1080` (no scaling)
- `1921x1081` → `1920x1080` (even adjustment only)

#### `ensureEven(dimension: number): number`
- Rounds down to nearest even number
- Formula: `Math.floor(dimension / 2) * 2`
- MediaConvert requires even dimensions

#### `calculateWatermarkSize(width, height, percentSize, minSize): number`
**Purpose**: Calculate optimal watermark size based on video dimensions

**Logic**:
```javascript
smallerDimension = min(width, height)
calculatedSize = (smallerDimension * percentSize) / 100
finalSize = max(calculatedSize, minSize)
return Math.floor(finalSize)
```

**Default**: 10% of smaller dimension, minimum 80px

#### `calculateWatermarkOffset(width, height): number`
- Calculates offset from edges
- Uses 3-5% of smaller dimension
- Minimum 20px

#### `generateWatermarkSequence(options): Array`
**Purpose**: Create looping watermark animation sequence

**Configuration**:
```javascript
{
  videoWidth, videoHeight,  // Output dimensions
  videoDurationMs,         // Video duration
  watermarkSize,           // Calculated size
  offset,                   // Calculated offset
  durationMs: 2000,        // 2 seconds per corner
  opacity: 80,             // 80% opacity
  watermarkUri: string      // S3 URI of watermark
}
```

**Corner Positions**:
1. Top-left: `{ x: offset, y: offset }`
2. Bottom-right: `{ x: videoWidth - size - offset, y: videoHeight - size - offset }`

**Sequence Generation**:
- Calculates number of complete sequences needed
- Each sequence = 4 corners × 2s = 8s total
- Repeats until video duration is covered
- Handles partial sequences at end

**Output Array**:
```javascript
[
  {
    ImageInserterInput: watermarkUri,
    Layer: 0,
    Opacity: 80,
    Width: 100,
    Height: 100,
    Duration: 2000,
    StartTime: "00:00:00:00",
    ImageX: 50,
    ImageY: 50
  },
  // ... more watermarks
]
```

#### `createMediaConvertJob(inputUri, localFilePath): Promise<string>`
**Purpose**: Create and submit MediaConvert transcoding job

**Steps**:
1. Determine output S3 key and URI
2. Get video metadata (dimensions, duration, bitrate)
3. Calculate output resolution
4. Calculate output bitrate (scaled by resolution factor)
5. Calculate watermark size and offset
6. Generate watermark sequence
7. Build job settings object
8. Submit job to MediaConvert
9. Return job ID

**Job Settings Structure**:
```javascript
{
  Role: roleArn,
  Queue?: queueArn,
  StatusUpdateInterval: 'SECONDS_10',
  Settings: {
    Inputs: [{ 
      FileInput, 
      VideoSelector: { Rotate: 'AUTO' },  // Auto-rotate based on metadata
      AudioSelectors 
    }],
    OutputGroups: [{
      Name: 'File Group',
      OutputGroupSettings: { Type, FileGroupSettings: { Destination } },
      Outputs: [{
        VideoDescription: {
          Width, Height,
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              MaxBitrate,           // Calculated from source
              RateControlMode: 'QVBR',
              QualityTuningLevel: 'SINGLE_PASS_HQ',
              SceneChangeDetect: 'TRANSITION_DETECTION'
            }
          },
          VideoPreprocessors: {
            ImageInserter: { InsertableImages: [...] }
          }
        },
        AudioDescriptions: [{ ...AAC settings... }],
        ContainerSettings: { Container: 'MP4' },
        NameModifier: `_${Date.now()}`
      }]
    }],
    TimecodeConfig: { Source: 'ZEROBASED' }
  }
}
```

**H.264 Settings**:
- `MaxBitrate`: Scaled from source bitrate
- `RateControlMode`: QVBR (Quality Variable Bitrate)
- `QualityTuningLevel`: SINGLE_PASS_HQ
- `SceneChangeDetect`: TRANSITION_DETECTION

**AAC Audio Settings**:
- `Bitrate`: 128000 bps (128 kbps)
- `CodingMode`: CODING_MODE_2_0 (stereo)
- `SampleRate`: 48000 Hz

#### `monitorJobProgress(jobId): Promise<{ job, outputUri }>`
**Purpose**: Poll job status and display progress updates

**Status States**:
- `SUBMITTED` - Queued for processing
- `PROGRESSING` - Actively transcoding
- `COMPLETE` - Finished successfully
- `ERROR` - Failed with error
- `CANCELED` - Manually canceled

**Polling Logic**:
- Polls every 5 seconds (configurable)
- Logs status changes immediately
- Logs progress updates every 10 seconds
- Shows current phase and percent complete
- Calculates elapsed time
- Extracts output URI from completed job

**Output URI Extraction**:
1. Extract destination from OutputGroups
2. Extract filename from Inputs
3. Extract NameModifier from Outputs
4. Determine extension from container settings
5. Construct: `s3://bucket/output/filename_nameModifier.ext`

**Error Handling**:
- Throws on ERROR or CANCELED status
- Logs error message and code
- Gracefully exits on terminal states

---

### 4. index.js

**Purpose**: Main CLI application orchestration

**Flow**:
```javascript
async function main() {
  1. Validate CLI arguments (file path required)
  2. Get initial file size
  3. Upload to S3 → get S3 URI
  4. Create MediaConvert job → get job ID
  5. Monitor job progress → get { job, outputUri }
  6. Download from S3 → save to outputs/
  7. Calculate and display compression ratio
}
```

**Dependencies**:
- `upload.js` - uploadToS3, downloadFromS3
- `mediaconvert.js` - createMediaConvertJob, monitorJobProgress
- `fs` - File system operations
- `path` - Path utilities

**Helper Functions**:
```javascript
formatFileSize(bytes: number): string
```
Formats bytes to human-readable format (B, KB, MB, GB)

**Output Format**:
- Displays initial file size
- Shows upload progress
- Shows job status updates
- Displays final output URI
- Shows download progress
- Displays completed file size
- Calculates compression ratio percentage

---

## AWS Services Integration

### S3 Configuration

**Bucket Structure**:
```
s3://your-bucket/
├── input/
│   └── video-name.mp4
├── output/
│   └── video-name_timestamp.mp4
└── assets/
    └── watermark.png
```

**Required Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:HeadObject"
      ],
      "Resource": [
        "arn:aws:s3:::your-bucket/input/*",
        "arn:aws:s3:::your-bucket/output/*",
        "arn:aws:s3:::your-bucket/assets/*"
      ]
    }
  ]
}
```

**Operations**:
- **Upload**: Multipart upload with streaming
- **Download**: Streaming download with progress
- **HeadObject**: Check if file exists (polling)

### MediaConvert Configuration

**Endpoint URLs** (per region):
- `us-east-1`: `https://mediaconvert.us-east-1.amazonaws.com`
- `us-west-1`: `https://mediaconvert.us-west-1.amazonaws.com`
- `eu-west-1`: `https://mediaconvert.eu-west-1.amazonaws.com`
- etc.

**IAM Role Requirements**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "mediaconvert.amazonaws.com" },
      "Action": "sts:AssumeRole"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-bucket/*"
      ]
    }
  ]
}
```

**MediaConvert Permissions**:
- Create jobs
- List jobs
- Get job status
- Read/write S3 objects

---

## Technical Specifications

### Video Processing Specifications

**Input Formats**:
- MP4 (.mp4)
- MOV (.mov)
- AVI (.avi)
- MKV (.mkv)
- WebM (.webm)
- FLV (.flv)

**Output Format**:
- Container: MP4
- Video Codec: H.264 (AVC)
- Audio Codec: AAC
- Resolution: Up to 1920px long edge (scaled if needed)
- Bitrate: Scaled from source
- Frame Rate: Preserved from source
- Audio: 128 kbps, 48 kHz, stereo

### H.264 Encoding Settings

```javascript
{
  MaxBitrate: calculatedBitrate,      // Scaled from source
  RateControlMode: 'QVBR',             // Quality Variable Bitrate
  QualityTuningLevel: 'SINGLE_PASS_HQ', // Single-pass high quality
  SceneChangeDetect: 'TRANSITION_DETECTION', // Scene detection
  CodecLevel: 'AUTO',
  CodecProfile: 'HIGH',
  InterlaceMode: 'PROGRESSIVE',
  ParControl: 'INITIALIZE_FROM_SOURCE',
  GopSize: 'AUTO'
}
```

### AAC Encoding Settings

```javascript
{
  Bitrate: 128000,              // 128 kbps
  CodingMode: 'CODING_MODE_2_0', // Stereo
  SampleRate: 48000,            // 48 kHz
  CodecProfile: 'LC',           // Low Complexity
  RateControlMode: 'CBR'        // Constant Bitrate
}
```

### Watermark Specifications

**Image Requirements**:
- Format: PNG with transparency
- Recommended size: 512x512px or larger
- Upload location: `s3://bucket/assets/watermark.png`

**Animation Behavior**:
- Duration per corner: 2 seconds
- Corners: Top-left and bottom-right (alternating)
- Opacity: 80%
- Loops throughout entire video

**Size Calculation**:
```javascript
const smallerDimension = Math.min(width, height);
const watermarkSize = Math.max(
  (smallerDimension * 0.10),  // 10% of smaller dimension
  80                           // Minimum 80px
);
```

**Offset Calculation**:
```javascript
const percentOffset = Math.max(3, Math.min(5, smallerDimension / 400));
const offset = Math.max(
  (smallerDimension * percentOffset) / 100,  // 3-5% of dimension
  20                                          // Minimum 20px
);
```

### Resolution Scaling Logic

**Rule**: Long edge must not exceed 1920px

**Scaling Formula**:
```javascript
const longEdge = Math.max(width, height);
const scaleFactor = 1920 / longEdge;
const newWidth = Math.floor(width * scaleFactor / 2) * 2;   // Even
const newHeight = Math.floor(height * scaleFactor / 2) * 2; // Even
```

**Examples**:
| Original      | Scaled    | Factor |
|--------------|-----------|--------|
| 3840x2160    | 1920x1080 | 0.5    |
| 2560x1440    | 1920x1080 | 0.75   |
| 1920x1080    | 1920x1080 | 1.0    |
| 1280x720     | 1280x720  | 1.0    |

### Bitrate Calculation

**Formula**:
```javascript
const scaleFactor = Math.min(newWidth / originalWidth, newHeight / originalHeight);
const outputBitrate = originalBitrate * scaleFactor;
```

**Examples**:
| Original Resolution | Original Bitrate | Output Resolution | Output Bitrate | Ratio |
|---------------------|------------------|-------------------|----------------|-------|
| 3840x2160           | 20 Mbps          | 1920x1080        | 5 Mbps         | 0.25  |
| 2560x1440           | 15 Mbps          | 1920x1080        | 7.5 Mbps       | 0.5   |
| 1920x1080           | 10 Mbps          | 1920x1080        | 10 Mbps        | 1.0   |

### File Naming

**Input**: Original filename.ext
**Output**: OriginalFilename_TIMESTAMP.ext

**Example**:
- Input: `video.mp4`
- Output: `video_1734567890.mp4`

**Timestamp**: Unix timestamp (milliseconds) from `Date.now()`

---

## Laravel Conversion Guide

### Project Structure

```
awmediaconvert/
├── app/
│   ├── Console/
│   │   └── Commands/
│   │       └── ProcessVideoCommand.php
│   ├── Services/
│   │   ├── S3Service.php
│   │   ├── MediaConvertService.php
│   │   ├── FFprobeService.php
│   │   └── WatermarkService.php
│   └── Models/
│       └── VideoJob.php
├── config/
│   ├── services.php (AWS credentials)
│   └── mediaconvert.php
├── database/
│   ├── migrations/
│   │   └── create_video_jobs_table.php
│   └── seeds/
├── routes/
│   └── console.php
└── tests/
    ├── Unit/
    │   ├── S3ServiceTest.php
    │   ├── MediaConvertServiceTest.php
    │   └── WatermarkServiceTest.php
    └── Feature/
        └── VideoProcessingTest.php
```

### Service Classes

#### 1. S3Service.php

```php
<?php

namespace App\Services;

use Aws\S3\S3Client;
use Aws\S3\MultipartUploader;
use Psr\Http\Message\StreamInterface;

class S3Service
{
    private S3Client $client;
    private string $bucket;
    private string $inputFolder;
    private string $outputFolder;

    public function __construct()
    {
        $this->client = new S3Client([
            'version' => 'latest',
            'region' => config('services.aws.region'),
            'credentials' => [
                'key' => config('services.aws.key'),
                'secret' => config('services.aws.secret'),
            ],
        ]);

        $this->bucket = config('mediaconvert.s3_bucket');
        $this->inputFolder = config('mediaconvert.input_folder');
        $this->outputFolder = config('mediaconvert.output_folder');
    }

    /**
     * Upload file to S3
     */
    public function upload(string $localPath, string $fileName): string
    {
        $key = "{$this->inputFolder}/{$fileName}";
        
        $uploader = new MultipartUploader($this->client, fopen($localPath, 'r'), [
            'bucket' => $this->bucket,
            'key' => $key,
            'content_type' => $this->getContentType($localPath),
        ]);

        $result = $uploader->upload();

        return "s3://{$this->bucket}/{$key}";
    }

    /**
     * Download file from S3
     */
    public function download(string $s3Uri, string $localPath): void
    {
        [$bucket, $key] = $this->parseS3Uri($s3Uri);
        
        $result = $this->client->getObject([
            'Bucket' => $bucket,
            'Key' => $key,
        ]);

        file_put_contents($localPath, $result['Body']->getContents());
    }

    /**
     * Check if file exists in S3
     */
    public function exists(string $bucket, string $key): bool
    {
        try {
            $this->client->headObject([
                'Bucket' => $bucket,
                'Key' => $key,
            ]);
            return true;
        } catch (\Aws\S3\Exception\S3Exception $e) {
            return false;
        }
    }

    private function getContentType(string $path): string
    {
        $extension = pathinfo($path, PATHINFO_EXTENSION);
        return match($extension) {
            'mp4' => 'video/mp4',
            'mov' => 'video/quicktime',
            'avi' => 'video/x-msvideo',
            'mkv' => 'video/x-matroska',
            'webm' => 'video/webm',
            'flv' => 'video/x-flv',
            default => 'video/mp4',
        };
    }

    private function parseS3Uri(string $uri): array
    {
        if (!preg_match('/^s3:\/\/([^\/]+)\/(.+)$/', $uri, $matches)) {
            throw new \InvalidArgumentException("Invalid S3 URI: {$uri}");
        }
        return [$matches[1], $matches[2]];
    }
}
```

#### 2. FFprobeService.php

```php
<?php

namespace App\Services;

use Symfony\Component\Process\Process;

class FFprobeService
{
    /**
     * Get video metadata
     */
    public function getMetadata(string $videoPath): array
    {
        $command = [
            'ffprobe',
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            $videoPath,
        ];

        $process = new Process($command);
        $process->run();

        if (!$process->isSuccessful()) {
            throw new \RuntimeException("FFprobe failed: {$process->getErrorOutput()}");
        }

        $metadata = json_decode($process->getOutput(), true);
        
        $videoStream = collect($metadata['streams'])->firstWhere('codec_type', 'video');
        
        if (!$videoStream) {
            throw new \RuntimeException('No video stream found');
        }

        return [
            'duration_ms' => (int) ($metadata['format']['duration'] * 1000),
            'width' => $videoStream['width'],
            'height' => $videoStream['height'],
            'bitrate' => $videoStream['bit_rate'] ?? $metadata['format']['bit_rate'] ?? 0,
        ];
    }

    /**
     * Get video bitrate
     */
    public function getBitrate(string $videoPath): int
    {
        $metadata = $this->getMetadata($videoPath);
        return $metadata['bitrate'];
    }
}
```

#### 3. WatermarkService.php

```php
<?php

namespace App\Services;

class WatermarkService
{
    /**
     * Generate watermark sequence
     */
    public function generateSequence(array $config): array
    {
        $watermarks = [];
        $layerIndex = 0;
        $corners = [
            ['name' => 'top-left', 'x' => $config['offset'], 'y' => $config['offset']],
            [
                'name' => 'bottom-right',
                'x' => $config['video_width'] - $config['watermark_size'] - $config['offset'],
                'y' => $config['video_height'] - $config['watermark_size'] - $config['offset'],
            ],
        ];

        $sequenceDurationMs = $config['duration_ms'] * count($corners);
        $numberOfSequences = (int) ceil($config['video_duration_ms'] / $sequenceDurationMs);

        for ($sequenceIndex = 0; $sequenceIndex < $numberOfSequences; $sequenceIndex++) {
            $sequenceStartMs = $sequenceIndex * $sequenceDurationMs;

            foreach ($corners as $cornerIndex => $corner) {
                $watermarkStartMs = $sequenceStartMs + ($cornerIndex * $config['duration_ms']);

                if ($watermarkStartMs < $config['video_duration_ms']) {
                    $watermarkDuration = $config['duration_ms'];
                    if ($watermarkStartMs + $config['duration_ms'] > $config['video_duration_ms']) {
                        $watermarkDuration = $config['video_duration_ms'] - $watermarkStartMs;
                    }

                    $watermarks[] = [
                        'ImageInserterInput' => $config['watermark_uri'],
                        'Layer' => $layerIndex++,
                        'Opacity' => $config['opacity'],
                        'Width' => $config['watermark_size'],
                        'Height' => $config['watermark_size'],
                        'Duration' => $watermarkDuration,
                        'StartTime' => $this->secondsToTimecode($watermarkStartMs / 1000),
                        'ImageX' => $corner['x'],
                        'ImageY' => $corner['y'],
                    ];
                }
            }
        }

        return $watermarks;
    }

    /**
     * Calculate watermark size
     */
    public function calculateSize(int $width, int $height, float $percent = 10.0, int $minSize = 80): int
    {
        $smallerDimension = min($width, $height);
        $calculatedSize = ($smallerDimension * $percent) / 100;
        return max((int) floor($calculatedSize), $minSize);
    }

    /**
     * Calculate watermark offset
     */
    public function calculateOffset(int $width, int $height): int
    {
        $smallerDimension = min($width, $height);
        $percentOffset = max(3, min(5, $smallerDimension / 400));
        $offset = ($smallerDimension * $percentOffset) / 100;
        return max((int) floor($offset), 20);
    }

    private function secondsToTimecode(float $seconds): string
    {
        $hours = floor($seconds / 3600);
        $minutes = floor(($seconds % 3600) / 60);
        $secs = floor($seconds % 60);
        $frames = 0;

        return sprintf(
            '%02d:%02d:%02d:%02d',
            $hours,
            $minutes,
            $secs,
            $frames
        );
    }
}
```

#### 4. MediaConvertService.php

```php
<?php

namespace App\Services;

use Aws\MediaConvert\MediaConvertClient;
use Aws\MediaConvert\Enum\JobStatus;

class MediaConvertService
{
    private MediaConvertClient $client;
    private string $roleArn;
    private ?string $queueArn;
    private S3Service $s3Service;
    private FFprobeService $ffprobe;
    private WatermarkService $watermark;
    private VideoHelperService $videoHelper;

    public function __construct(
        S3Service $s3Service,
        FFprobeService $ffprobe,
        WatermarkService $watermark,
        VideoHelperService $videoHelper
    ) {
        $this->client = new MediaConvertClient([
            'version' => 'latest',
            'region' => config('services.aws.region'),
            'credentials' => [
                'key' => config('services.aws.key'),
                'secret' => config('services.aws.secret'),
            ],
            'endpoint' => config('mediaconvert.endpoint'),
        ]);

        $this->roleArn = config('mediaconvert.role_arn');
        $this->queueArn = config('mediaconvert.queue_arn');
        $this->s3Service = $s3Service;
        $this->ffprobe = $ffprobe;
        $this->watermark = $watermark;
        $this->videoHelper = $videoHelper;
    }

    /**
     * Create MediaConvert job
     */
    public function createJob(string $inputUri, ?string $localPath = null): string
    {
        $fileName = basename($inputUri);
        $outputUri = "s3://" . config('mediaconvert.s3_bucket') . "/" . config('mediaconvert.output_folder') . "/{$fileName}";

        // Get video metadata
        $metadata = $localPath ? $this->ffprobe->getMetadata($localPath) : [
            'duration_ms' => 15000,
            'width' => 1920,
            'height' => 1080,
            'bitrate' => 5000000,
        ];

        // Calculate settings
        $outputResolution = $this->videoHelper->calculateOutputResolution(
            $metadata['width'],
            $metadata['height'],
            1920
        );

        $scaleFactor = min(
            $outputResolution['width'] / $metadata['width'],
            $outputResolution['height'] / $metadata['height']
        );
        $outputBitrate = (int) ($metadata['bitrate'] * $scaleFactor);

        $watermarkSize = $this->watermark->calculateSize(
            $outputResolution['width'],
            $outputResolution['height']
        );
        $watermarkOffset = $this->watermark->calculateOffset(
            $outputResolution['width'],
            $outputResolution['height']
        );

        // Generate watermark sequence
        $watermarks = $this->watermark->generateSequence([
            'video_width' => $outputResolution['width'],
            'video_height' => $outputResolution['height'],
            'video_duration_ms' => $metadata['duration_ms'],
            'watermark_size' => $watermarkSize,
            'offset' => $watermarkOffset,
            'duration_ms' => 2000,
            'opacity' => 80,
            'watermark_uri' => "s3://" . config('mediaconvert.s3_bucket') . "/assets/watermark.png",
        ]);

        // Build job settings
        $settings = [
            'Role' => $this->roleArn,
            'StatusUpdateInterval' => 'SECONDS_10',
            'Settings' => [
                'Inputs' => [[
                    'FileInput' => $inputUri,
                    'VideoSelector' => ['Rotate' => 'AUTO'],  // Auto-rotate based on metadata
                    'AudioSelectors' => [
                        'Audio Selector 1' => [
                            'DefaultSelection' => 'DEFAULT',
                        ],
                    ],
                ]],
                'OutputGroups' => [[
                    'Name' => 'File Group',
                    'OutputGroupSettings' => [
                        'Type' => 'FILE_GROUP_SETTINGS',
                        'FileGroupSettings' => [
                            'Destination' => "s3://" . config('mediaconvert.s3_bucket') . "/" . config('mediaconvert.output_folder') . "/",
                        ],
                    ],
                    'Outputs' => [[
                        'VideoDescription' => [
                            'Width' => $outputResolution['width'],
                            'Height' => $outputResolution['height'],
                            'CodecSettings' => [
                                'Codec' => 'H_264',
                                'H264Settings' => [
                                    'MaxBitrate' => $outputBitrate,
                                    'RateControlMode' => 'QVBR',
                                    'QualityTuningLevel' => 'SINGLE_PASS_HQ',
                                    'SceneChangeDetect' => 'TRANSITION_DETECTION',
                                ],
                            ],
                            'VideoPreprocessors' => [
                                'ImageInserter' => [
                                    'InsertableImages' => $watermarks,
                                ],
                            ],
                        ],
                        'AudioDescriptions' => [[
                            'AudioSourceName' => 'Audio Selector 1',
                            'CodecSettings' => [
                                'Codec' => 'AAC',
                                'AacSettings' => [
                                    'Bitrate' => 128000,
                                    'CodingMode' => 'CODING_MODE_2_0',
                                    'SampleRate' => 48000,
                                ],
                            ],
                        ]],
                        'ContainerSettings' => [
                            'Container' => 'MP4',
                            'Mp4Settings' => [],
                        ],
                        'NameModifier' => '_' . time(),
                    ]],
                ]],
                'TimecodeConfig' => [
                    'Source' => 'ZEROBASED',
                ],
            ],
        ];

        if ($this->queueArn) {
            $settings['Queue'] = $this->queueArn;
        }

        $result = $this->client->createJob($settings);

        return $result['Job']['Id'];
    }

    /**
     * Get job status
     */
    public function getStatus(string $jobId): array
    {
        $result = $this->client->getJob(['Id' => $jobId]);
        return $result['Job'];
    }

    /**
     * Monitor job progress
     */
    public function monitorJob(string $jobId): array
    {
        $startTime = time();
        $pollInterval = config('mediaconvert.poll_interval_ms', 5000);

        while (true) {
            $job = $this->getStatus($jobId);
            $status = $job['Status'];
            $elapsed = time() - $startTime;

            $this->logStatus($status, $elapsed, $job);

            if (in_array($status, [JobStatus::COMPLETE, JobStatus::ERROR, JobStatus::CANCELED])) {
                break;
            }

            usleep($pollInterval * 1000);
        }

        return $job;
    }

    private function logStatus(string $status, int $elapsed, array $job): void
    {
        // Implement logging similar to Node.js version
    }
}
```

#### 5. VideoHelperService.php

```php
<?php

namespace App\Services;

class VideoHelperService
{
    /**
     * Calculate output resolution with scaling
     */
    public function calculateOutputResolution(int $width, int $height, int $maxLongEdge = 1920): array
    {
        $longEdge = max($width, $height);

        if ($longEdge <= $maxLongEdge) {
            return [
                'width' => $this->ensureEven($width),
                'height' => $this->ensureEven($height),
            ];
        }

        $scaleFactor = $maxLongEdge / $longEdge;
        $newWidth = (int) ($width * $scaleFactor);
        $newHeight = (int) ($height * $scaleFactor);

        return [
            'width' => $this->ensureEven($newWidth),
            'height' => $this->ensureEven($newHeight),
        ];
    }

    /**
     * Ensure even number (MediaConvert requirement)
     */
    public function ensureEven(int $dimension): int
    {
        return (int) (floor($dimension / 2) * 2);
    }
}
```

### Console Command

```php
<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Services\S3Service;
use App\Services\MediaConvertService;
use App\Services\FFprobeService;
use Illuminate\Support\Facades\Storage;

class ProcessVideoCommand extends Command
{
    protected $signature = 'video:process {path}';
    protected $description = 'Upload and process video with AWS MediaConvert';

    public function __construct(
        private S3Service $s3,
        private MediaConvertService $mediaConvert,
        private FFprobeService $ffprobe
    ) {
        parent::__construct();
    }

    public function handle()
    {
        $filePath = $this->argument('path');

        if (!file_exists($filePath)) {
            $this->error("File not found: {$filePath}");
            return 1;
        }

        $this->info('=== AWS MediaConvert Video Processing ===');
        
        // Get initial file size
        $initialSize = filesize($filePath);
        $this->info("Initial file size: {$this->formatSize($initialSize)}");

        // Upload to S3
        $this->info('Uploading to S3...');
        $s3Uri = $this->s3->upload($filePath, basename($filePath));
        $this->info("Upload complete: {$s3Uri}");

        // Create job
        $this->info('Creating MediaConvert job...');
        $jobId = $this->mediaConvert->createJob($s3Uri, $filePath);

        // Monitor progress
        $result = $this->mediaConvert->monitorJob($jobId);

        // Download result
        if ($result['Status'] === 'COMPLETE') {
            $outputPath = storage_path('app/outputs/' . basename($s3Uri));
            $this->s3->download($outputUri, $outputPath);
            
            $finalSize = filesize($outputPath);
            $compression = (1 - ($finalSize / $initialSize)) * 100;
            
            $this->info("Final file size: {$this->formatSize($finalSize)}");
            $this->info("Compression: {$compression}%");
        }

        return 0;
    }

    private function formatSize(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB'];
        $size = $bytes;
        $unitIndex = 0;

        while ($size >= 1024 && $unitIndex < count($units) - 1) {
            $size /= 1024;
            $unitIndex++;
        }

        return round($size, 2) . ' ' . $units[$unitIndex];
    }
}
```

### Configuration Files

#### config/services.php (add AWS config)

```php
'aws' => [
    'key' => env('AWS_ACCESS_KEY_ID'),
    'secret' => env('AWS_SECRET_ACCESS_KEY'),
    'region' => env('AWS_REGION', 'us-east-1'),
],
```

#### config/mediaconvert.php

```php
<?php

return [
    's3_bucket' => env('S3_BUCKET'),
    'input_folder' => env('S3_INPUT_FOLDER', 'input'),
    'output_folder' => env('S3_OUTPUT_FOLDER', 'output'),
    'endpoint' => env('MEDIACONVERT_ENDPOINT'),
    'role_arn' => env('MEDIACONVERT_ROLE_ARN'),
    'queue_arn' => env('MEDIACONVERT_QUEUE_ARN'),
    'poll_interval_ms' => env('MEDIACONVERT_POLL_INTERVAL_MS', 5000),
];
```

### Environment File

```env
AWS_ACCESS_KEY_ID=your_key_here
AWS_SECRET_ACCESS_KEY=your_secret_here
AWS_REGION=us-east-1

S3_BUCKET=your-bucket-name
S3_INPUT_FOLDER=input
S3_OUTPUT_FOLDER=output

MEDIACONVERT_ENDPOINT=https://mediaconvert.us-east-1.amazonaws.com
MEDIACONVERT_ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/service-role/MediaConvert_Default_Role
MEDIACONVERT_QUEUE_ARN=arn:aws:mediaconvert:us-east-1:ACCOUNT_ID:queues/Default
MEDIACONVERT_POLL_INTERVAL_MS=5000
```

### Database Migration

```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateVideoJobsTable extends Migration
{
    public function up()
    {
        Schema::create('video_jobs', function (Blueprint $table) {
            $table->id();
            $table->string('aws_job_id');
            $table->string('original_filename');
            $table->string('input_uri');
            $table->string('output_uri')->nullable();
            $table->enum('status', ['submitted', 'progressing', 'complete', 'error'])->default('submitted');
            $table->integer('initial_size')->nullable();
            $table->integer('final_size')->nullable();
            $table->float('compression_ratio')->nullable();
            $table->text('error_message')->nullable();
            $table->timestamps();
        });
    }

    public function down()
    {
        Schema::dropIfExists('video_jobs');
    }
}
```

---

## API Specification

If converting to an API service:

### Endpoints

#### POST /api/v1/videos/upload
Upload and process video

**Request**:
```
Content-Type: multipart/form-data

{
  file: File,
  options: {
    watermark: boolean,
    output_format: string
  }
}
```

**Response**:
```json
{
  "job_id": "abc-123-def",
  "status": "submitted",
  "s3_uri": "s3://bucket/input/video.mp4",
  "estimated_completion": "2024-01-15T12:00:00Z"
}
```

#### GET /api/v1/videos/{jobId}
Get job status

**Response**:
```json
{
  "job_id": "abc-123-def",
  "status": "complete",
  "progress": 100,
  "output_uri": "s3://bucket/output/video_timestamp.mp4",
  "download_url": "https://api.example.com/download/{jobId}"
}
```

#### GET /api/v1/videos/{jobId}/download
Download processed video

**Response**: Binary file download

---

## Database Schema

### video_jobs Table

```sql
CREATE TABLE video_jobs (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    aws_job_id VARCHAR(255) NOT NULL UNIQUE,
    original_filename VARCHAR(255) NOT NULL,
    input_uri TEXT NOT NULL,
    output_uri TEXT NULL,
    status ENUM('submitted', 'progressing', 'complete', 'error', 'canceled') DEFAULT 'submitted',
    progress_percent INT NULL,
    current_phase VARCHAR(50) NULL,
    initial_size BIGINT NULL,
    final_size BIGINT NULL,
    compression_ratio DECIMAL(5,2) NULL,
    error_message TEXT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    
    INDEX idx_status (status),
    INDEX idx_aws_job_id (aws_job_id)
);
```

**Field Descriptions**:
- `aws_job_id`: MediaConvert job ID
- `original_filename`: Original uploaded filename
- `input_uri`: S3 URI of input file
- `output_uri`: S3 URI of processed file
- `status`: Current job status
- `progress_percent`: Job completion percentage
- `current_phase`: Current processing phase
- `initial_size`: Original file size in bytes
- `final_size`: Processed file size in bytes
- `compression_ratio`: Percentage reduction
- `error_message`: Error details if failed
- `metadata`: JSON with video properties (dimensions, duration, bitrate)

---

## Error Handling

### Error Types

1. **Upload Errors**
   - File not found
   - S3 permission denied
   - Network timeout
   - Invalid file type

2. **Job Creation Errors**
   - Invalid job settings
   - IAM role permission denied
   - Invalid S3 URI
   - FFprobe execution failed

3. **Job Execution Errors**
   - Codec not supported
   - Resolution out of bounds
   - Insufficient storage
   - Watermark file not found

4. **Download Errors**
   - File not found in S3
   - Download timeout
   - Disk space insufficient
   - Permission denied

### Error Response Format

```json
{
  "error": {
    "code": "FILE_NOT_FOUND",
    "message": "File not found: /path/to/video.mp4",
    "details": {
      "path": "/path/to/video.mp4",
      "timestamp": "2024-01-15T12:00:00Z"
    }
  }
}
```

### Recommended Retry Logic

```php
public function createJobWithRetry(string $inputUri, int $maxRetries = 3): string
{
    $attempt = 0;
    
    while ($attempt < $maxRetries) {
        try {
            return $this->createJob($inputUri);
        } catch (\Exception $e) {
            $attempt++;
            
            if ($attempt >= $maxRetries) {
                throw $e;
            }
            
            sleep(2 ** $attempt); // Exponential backoff
        }
    }
}
```

---

## Testing Strategy

### Unit Tests

Test each service independently with mocked dependencies:

```php
class MediaConvertServiceTest extends TestCase
{
    public function test_calculates_output_resolution()
    {
        $service = new MediaConvertService(...);
        
        $result = $service->calculateOutputResolution(3840, 2160, 1920);
        
        $this->assertEquals(1920, $result['width']);
        $this->assertEquals(1080, $result['height']);
    }
    
    public function test_ensures_even_dimensions()
    {
        $service = new MediaConvertService(...);
        
        $this->assertEquals(1920, $service->ensureEven(1921));
        $this->assertEquals(1920, $service->ensureEven(1920));
    }
}
```

### Integration Tests

Test full workflow with test AWS credentials:

```php
class VideoProcessingTest extends TestCase
{
    public function test_complete_video_processing_workflow()
    {
        // Upload test video
        $s3Uri = $this->s3->upload($testVideoPath, 'test.mp4');
        
        // Create job
        $jobId = $this->mediaConvert->createJob($s3Uri, $testVideoPath);
        
        // Monitor job
        $result = $this->mediaConvert->monitorJob($jobId);
        
        // Assert job completed
        $this->assertEquals('COMPLETE', $result['Status']);
        
        // Download result
        $this->s3->download($result['OutputUri'], $outputPath);
        
        // Assert file exists
        $this->assertFileExists($outputPath);
    }
}
```

### Test Files

Store test videos in `tests/fixtures/videos/`:
- `test-1920x1080.mp4` - Standard HD
- `test-3840x2160.mp4` - 4K (needs scaling)
- `test-1280x720.mp4` - HD (no scaling)

---

## Deployment Considerations

### Queue Jobs

For production, use Laravel queues to process videos asynchronously:

```php
ProcessVideoJob::dispatch($videoPath)
    ->onQueue('video-processing');
```

### Storage

Use Laravel Storage facade for file operations:

```php
Storage::disk('s3')->put($path, $file);
Storage::disk('local')->put($path, $content);
```

### Monitoring

Log all operations for debugging:

```php
Log::info('Video job created', [
    'job_id' => $jobId,
    'input_uri' => $inputUri,
]);
```

### Security

- Validate file types
- Set upload size limits
- Sanitize filenames
- Use signed URLs for downloads
- Rate limit API endpoints

---

## Conclusion

This architecture provides a complete foundation for converting the Node.js AWS MediaConvert application to Laravel. The service-based architecture ensures maintainability and testability, while preserving all features and functionality of the original implementation.

**Key Conversion Points**:
1. AWS SDK v2 → Laravel AWS SDK integration
2. ES modules → PHP classes
3. CLI script → Console command
4. Progress callbacks → Status monitoring
5. File streaming → Multipart upload/download

**Next Steps for Implementation**:
1. Set up Laravel project structure
2. Install AWS SDK via Composer
3. Create service classes
4. Implement console command
5. Add database migrations
6. Write tests
7. Deploy and configure

