#!/usr/bin/env node

import { uploadToS3, downloadFromS3 } from './upload.js';
import { createMediaConvertJob, monitorJobProgress } from './mediaconvert.js';
import path from 'path';
import fs from 'fs';

/**
 * Format file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

async function main() {
  try {
    // Check if file path is provided
    const filePath = process.argv[2];
    
    if (!filePath) {
      console.error('Usage: node index.js <path-to-video-file>');
      console.error('Example: node index.js ./my-video.mp4');
      process.exit(1);
    }

    console.log('=== AWS MediaConvert Video Processing ===\n');

    // Log initial file size
    const initialFileStats = fs.statSync(filePath);
    const initialFileSize = initialFileStats.size;
    console.log(`📁 Initial file size: ${formatFileSize(initialFileSize)} (${initialFileSize.toLocaleString()} bytes)\n`);

    // Step 1: Upload video to S3
    const s3Uri = await uploadToS3(filePath);

    // Step 2: Create MediaConvert job (pass local file path for metadata detection)
    const jobId = await createMediaConvertJob(s3Uri, filePath);

    // Step 3: Monitor job progress until completion
    const { outputUri } = await monitorJobProgress(jobId);

    console.log('\n=== Processing Complete ===');
    console.log(`S3 Output Location: ${outputUri}`);
    
    // Step 4: Download the processed file to outputs directory
    if (outputUri) {
      // Extract filename from S3 URI
      const s3FileName = path.basename(outputUri);
      const localOutputPath = path.join('outputs', s3FileName);
      
      // Download file from S3
      await downloadFromS3(outputUri, localOutputPath);
      
      // Log completed file size
      if (fs.existsSync(localOutputPath)) {
        const completedFileStats = fs.statSync(localOutputPath);
        const completedFileSize = completedFileStats.size;
        console.log(`\n📁 Completed file size: ${formatFileSize(completedFileSize)} (${completedFileSize.toLocaleString()} bytes)`);
        
        // Calculate compression ratio
        const compressionRatio = ((1 - completedFileSize / initialFileSize) * 100).toFixed(1);
        console.log(`📊 Compression ratio: ${compressionRatio}% smaller`);
      }
      
      console.log('\n🎉 All done! Processed video saved locally.');
    }
    
  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  }
}

// Run the script
main();

