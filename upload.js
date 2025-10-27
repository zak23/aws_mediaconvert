import { S3Client } from '@aws-sdk/client-s3';
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

