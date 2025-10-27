/**
 * Upload Module - S3 File Operations
 * 
 * This module handles all S3 file operations including:
 * - Uploading videos to S3 with progress tracking
 * - Downloading processed videos from S3
 * - Video metadata extraction using FFprobe
 * - Waiting for files to appear in S3 (MediaConvert timing issue)
 * 
 * Key Features:
 * - Multipart upload support for large files
 * - Real-time progress tracking
 * - Automatic retry mechanism for S3 file availability
 * - Video bitrate extraction using FFprobe
 * 
 * Dependencies:
 * - @aws-sdk/client-s3: S3 client and commands
 * - @aws-sdk/lib-storage: Multipart upload support
 * - fluent-ffmpeg: Video metadata extraction via FFprobe
 */

import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

/**
 * S3 Client Instance
 * 
 * Initialized with AWS credentials and region from config.
 * This client is used for all S3 operations (upload, download, check existence).
 */
const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * Extract video bitrate using FFprobe
 * 
 * Uses FFprobe (via fluent-ffmpeg) to extract video bitrate information.
 * This is used to log the original video quality before processing.
 * 
 * Priority: video stream bitrate > format bitrate > 0
 * 
 * @param {string} videoPath - Local path to the video file
 * @returns {Promise<number>} Video bitrate in bits per second (bps)
 * @throws {Error} If video file cannot be read or has no video stream
 * 
 * Example:
 * - Input: '/path/to/video.mp4'
 * - Output: 5000000 (5 Mbps)
 */
async function getVideoBitrate(videoPath) {
  return new Promise((resolve, reject) => {
    // Use FFprobe to extract metadata
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      // Find the video stream in the metadata
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }
      
      // Try to get bitrate from video stream, fallback to format, default to 0
      // Priority: video stream bitrate > format bitrate > 0
      const bitrate = videoStream.bit_rate || metadata.format.bit_rate || 0;
      resolve(bitrate);
    });
  });
}

/**
 * Upload a video file to S3
 * 
 * Uploads a local video file to S3 using multipart upload for large files.
 * Automatically determines the content type based on file extension.
 * Shows real-time upload progress in the terminal.
 * 
 * S3 Path Structure: s3://{bucket}/{inputFolder}/{filename}
 * Example: s3://my-bucket/input/video.mp4
 * 
 * @param {string} filePath - Local path to the video file
 * @returns {Promise<string>} S3 URI of the uploaded file (e.g., 's3://bucket/input/file.mp4')
 * @throws {Error} If file doesn't exist or upload fails
 * 
 * Progress Events:
 * - Shows upload progress as percentage
 * - Logs video bitrate before upload
 * - Final S3 URI is returned upon completion
 */
export async function uploadToS3(filePath) {
  try {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Extract filename and construct S3 key
    const fileName = path.basename(filePath);
    const s3Key = `${config.s3.inputFolder}/${fileName}`;

    // Attempt to log video bitrate (graceful failure if FFprobe unavailable)
    try {
      const bitrate = await getVideoBitrate(filePath);
      // Convert bits per second to Mbps for display
      console.log(`📊 Original video bitrate: ${(bitrate / 1000000).toFixed(2)} Mbps`);
      console.log(`Uploading ${fileName} to S3...`);
    } catch (error) {
      // Continue with upload even if bitrate extraction fails
      console.log(`Uploading ${fileName} to S3...`);
      console.warn(`Could not read video bitrate: ${error.message}`);
    }

    // Create multipart upload instance
    // Uses streaming for efficient memory usage with large files
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: config.s3.bucket,
        Key: s3Key,
        // Stream the file to avoid loading entire file into memory
        Body: fs.createReadStream(filePath),
        ContentType: getContentType(filePath),
      },
    });

    // Track upload progress in real-time
    upload.on('httpUploadProgress', (progress) => {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      // Overwrite the same line for progress updates
      process.stdout.write(`\rUpload progress: ${percentage}%`);
    });

    // Wait for upload to complete
    const result = await upload.done();
    
    // Construct full S3 URI for MediaConvert job
    const s3Uri = `s3://${config.s3.bucket}/${s3Key}`;
    
    console.log(`\nUpload complete: ${s3Uri}`);
    return s3Uri;

  } catch (error) {
    console.error('Error uploading to S3:', error.message);
    throw error;
  }
}

/**
 * Determine content type based on file extension
 * 
 * Maps common video file extensions to MIME types.
 * Used by S3 to properly serve the video file.
 * 
 * @param {string} filePath - Path to the file
 * @returns {string} MIME content type
 * 
 * Supported Formats:
 * - MP4: video/mp4
 * - MOV: video/quicktime
 * - AVI: video/x-msvideo
 * - MKV: video/x-matroska
 * - WebM: video/webm
 * - FLV: video/x-flv
 * - Default: video/mp4
 */
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.flv': 'video/x-flv',
  };
  // Return content type or default to MP4
  return contentTypes[ext] || 'video/mp4';
}

/**
 * Wait for a file to appear in S3
 * 
 * This function polls S3 to check if a file exists. This is necessary because
 * MediaConvert job completion doesn't guarantee the output file is immediately
 * available in S3 - it may take a few seconds.
 * 
 * Why this is needed:
 * - MediaConvert marks job as "COMPLETE" when transcoding finishes
 * - S3 file writing happens asynchronously
 * - Immediate download attempts may fail if file isn't ready yet
 * 
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key (path within bucket)
 * @param {number} maxAttempts - Maximum number of polling attempts (default: 12)
 * @param {number} delayMs - Delay between attempts in milliseconds (default: 5000)
 * @returns {Promise<boolean>} True if file exists, false if not found after all attempts
 * 
 * Polling Strategy:
 * - Default: 12 attempts × 5 seconds = 60 seconds max wait time
 * - Uses HEAD request (lightweight, only checks existence)
 * - Logs each attempt for transparency
 */
async function waitForS3Object(bucket, key, maxAttempts = 12, delayMs = 5000) {
  console.log(`⏳ Waiting for file to appear in S3...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Use HEAD request to check if file exists (more efficient than GET)
      const headCommand = new HeadObjectCommand({ Bucket: bucket, Key: key });
      await s3Client.send(headCommand);
      console.log(`✅ File found in S3 (attempt ${attempt})`);
      return true;
    } catch (error) {
      // Handle "file not found" errors - this is expected while waiting
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        if (attempt < maxAttempts) {
          // Log progress and wait before next attempt
          console.log(`   Attempt ${attempt}/${maxAttempts}: File not ready yet, waiting ${delayMs/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          // Final attempt failed
          console.error(`   File still not found after ${maxAttempts} attempts`);
          return false;
        }
      } else {
        // Unexpected error - rethrow
        throw error;
      }
    }
  }
  
  return false;
}

/**
 * Download a processed video file from S3 to local filesystem
 * 
 * Downloads the processed video from S3 after MediaConvert completes.
 * Includes retry logic to wait for file availability and progress tracking.
 * 
 * Features:
 * - Waits for file to appear in S3 (retry mechanism)
 * - Real-time download progress
 * - Automatic directory creation
 * - Streaming download for efficient memory usage
 * 
 * @param {string} s3Uri - S3 URI in format 's3://bucket/key'
 * @param {string} localOutputPath - Local path where file should be saved (e.g., 'outputs/video.mp4')
 * @returns {Promise<string>} Path to the downloaded file (same as localOutputPath)
 * @throws {Error} If download fails or file doesn't appear in S3
 * 
 * Example:
 * - Input: 's3://bucket/output/video.mp4', 'outputs/video.mp4'
 * - Output: 'outputs/video.mp4' (with file written to disk)
 */
export async function downloadFromS3(s3Uri, localOutputPath) {
  try {
    // Parse S3 URI into bucket and key components
    // Format: s3://bucket-name/path/to/file.mp4
    const s3UriRegex = /^s3:\/\/([^/]+)\/(.+)$/;
    const match = s3Uri.match(s3UriRegex);
    
    if (!match) {
      throw new Error(`Invalid S3 URI format: ${s3Uri}`);
    }
    
    // Extract bucket and key from regex match
    const bucket = match[1];
    const key = match[2];
    
    console.log(`\n📥 Downloading ${path.basename(key)} from S3...`);
    
    // Wait for file to appear in S3 (MediaConvert completion doesn't guarantee immediate availability)
    const fileExists = await waitForS3Object(bucket, key, 12, 5000);
    if (!fileExists) {
      throw new Error('File not found in S3 after waiting for MediaConvert to complete');
    }
    
    // Ensure output directory exists (create if needed)
    const outputDir = path.dirname(localOutputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Get file from S3
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    
    const response = await s3Client.send(command);
    
    // Track download progress
    let downloadedBytes = 0;
    const totalBytes = response.ContentLength || 0;
    
    // Collect chunks from the stream with progress tracking
    // This approach uses streaming to avoid loading entire file into memory
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
      downloadedBytes += chunk.length;
      
      // Update progress if we know the total size
      if (totalBytes > 0) {
        const percentage = Math.round((downloadedBytes / totalBytes) * 100);
        // Overwrite the same line for progress updates
        process.stdout.write(`\rDownload progress: ${percentage}%`);
      }
    }
    
    // Combine all chunks and write to file
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(localOutputPath, buffer);
    
    console.log(`\n✅ Download complete: ${localOutputPath}`);
    return localOutputPath;
    
  } catch (error) {
    console.error('Error downloading from S3:', error.message);
    throw error;
  }
}
