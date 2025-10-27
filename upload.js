import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

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

    console.log(`Uploading ${fileName} to S3...`);

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

