#!/usr/bin/env node

import { uploadToS3 } from './upload.js';
import { createMediaConvertJob, monitorJobProgress } from './mediaconvert.js';

/**
 * Main function to upload video and create MediaConvert job
 */
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

    // Step 1: Upload video to S3
    const s3Uri = await uploadToS3(filePath);

    // Step 2: Create MediaConvert job (pass local file path for metadata detection)
    const jobId = await createMediaConvertJob(s3Uri, filePath);

    // Step 3: Monitor job progress until completion
    await monitorJobProgress(jobId);

    console.log('\n=== Processing Complete ===');
    console.log(`S3 Output Location: s3://${process.env.S3_BUCKET}/${process.env.S3_OUTPUT_FOLDER}/`);
    
  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  }
}

// Run the script
main();

