import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * Get video bitrate using ffprobe
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<number>} Video bitrate in bps
 */
async function getVideoBitrate(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }
      
      const bitrate = videoStream.bit_rate || metadata.format.bit_rate || 0;
      resolve(bitrate);
    });
  });
}

/**
 * Upload a video file to S3
 * @param {string} filePath - Path to the local video file
 * @returns {Promise<string>} S3 URI of the uploaded file
 */
export async function uploadToS3(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const s3Key = `${config.s3.inputFolder}/${fileName}`;

    // Log video bitrate before uploading
    try {
      const bitrate = await getVideoBitrate(filePath);
      console.log(`📊 Original video bitrate: ${(bitrate / 1000000).toFixed(2)} Mbps`);
      console.log(`Uploading ${fileName} to S3...`);
    } catch (error) {
      console.log(`Uploading ${fileName} to S3...`);
      console.warn(`Could not read video bitrate: ${error.message}`);
    }

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: config.s3.bucket,
        Key: s3Key,
        Body: fs.createReadStream(filePath),
        ContentType: getContentType(filePath),
      },
    });

    upload.on('httpUploadProgress', (progress) => {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      process.stdout.write(`\rUpload progress: ${percentage}%`);
    });

    const result = await upload.done();
    const s3Uri = `s3://${config.s3.bucket}/${s3Key}`;
    
    console.log(`\nUpload complete: ${s3Uri}`);
    return s3Uri;

  } catch (error) {
    console.error('Error uploading to S3:', error.message);
    throw error;
  }
}

/**
 * Get content type based on file extension
 * @param {string} filePath - Path to the file
 * @returns {string} Content type
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
  return contentTypes[ext] || 'video/mp4';
}

/**
 * Wait for file to appear in S3 (MediaConvert sometimes completes job before file is fully written)
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key
 * @param {number} maxAttempts - Maximum number of attempts
 * @param {number} delayMs - Delay between attempts in milliseconds
 * @returns {Promise<boolean>} True if file exists, false otherwise
 */
async function waitForS3Object(bucket, key, maxAttempts = 12, delayMs = 5000) {
  console.log(`⏳ Waiting for file to appear in S3...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headCommand = new HeadObjectCommand({ Bucket: bucket, Key: key });
      await s3Client.send(headCommand);
      console.log(`✅ File found in S3 (attempt ${attempt})`);
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        if (attempt < maxAttempts) {
          console.log(`   Attempt ${attempt}/${maxAttempts}: File not ready yet, waiting ${delayMs/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          console.error(`   File still not found after ${maxAttempts} attempts`);
          return false;
        }
      } else {
        throw error;
      }
    }
  }
  
  return false;
}

/**
 * Download a file from S3 to local outputs directory
 * @param {string} s3Uri - S3 URI of the file to download
 * @param {string} localOutputPath - Local path where the file should be saved
 * @returns {Promise<string>} Path to the downloaded file
 */
export async function downloadFromS3(s3Uri, localOutputPath) {
  try {
    // Parse S3 URI (format: s3://bucket/key)
    const s3UriRegex = /^s3:\/\/([^/]+)\/(.+)$/;
    const match = s3Uri.match(s3UriRegex);
    
    if (!match) {
      throw new Error(`Invalid S3 URI format: ${s3Uri}`);
    }
    
    const bucket = match[1];
    const key = match[2];
    
    console.log(`\n📥 Downloading ${path.basename(key)} from S3...`);
    
    // Wait for file to appear in S3 (MediaConvert completion doesn't guarantee file is ready)
    const fileExists = await waitForS3Object(bucket, key, 12, 5000);
    if (!fileExists) {
      throw new Error('File not found in S3 after waiting for MediaConvert to complete');
    }
    
    // Ensure output directory exists
    const outputDir = path.dirname(localOutputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Get object from S3
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    
    const response = await s3Client.send(command);
    
    // Track download progress
    let downloadedBytes = 0;
    const totalBytes = response.ContentLength || 0;
    
    // Collect chunks from the stream with progress tracking
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
      downloadedBytes += chunk.length;
      
      if (totalBytes > 0) {
        const percentage = Math.round((downloadedBytes / totalBytes) * 100);
        process.stdout.write(`\rDownload progress: ${percentage}%`);
      }
    }
    
    // Write all chunks to file
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(localOutputPath, buffer);
    
    console.log(`\n✅ Download complete: ${localOutputPath}`);
    return localOutputPath;
    
  } catch (error) {
    console.error('Error downloading from S3:', error.message);
    throw error;
  }
}

