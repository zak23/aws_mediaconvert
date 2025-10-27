import dotenv from 'dotenv';

/**
 * Configuration Module
 * 
 * This module loads and validates all environment variables from .env file.
 * It sets up configuration for:
 * - AWS credentials (access key, secret, region)
 * - S3 bucket settings (bucket name, input/output folders)
 * - MediaConvert service settings (endpoint, IAM role, queue, polling interval)
 * 
 * Validation happens on module load (fail-fast approach).
 * Invalid configuration will cause the application to exit immediately.
 */

dotenv.config();

/**
 * Application Configuration Object
 * Loads all settings from environment variables with defaults where appropriate.
 * 
 * Structure:
 * - aws: AWS credentials and region
 * - s3: S3 bucket configuration
 * - mediaconvert: MediaConvert job settings
 */
export const config = {
  aws: {
    // AWS Access Key ID - Required for S3 and MediaConvert access
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    // AWS Secret Access Key - Required for S3 and MediaConvert access
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    // AWS Region - Defaults to us-east-1 if not specified
    region: process.env.AWS_REGION || 'us-east-1',
  },
  s3: {
    // S3 Bucket Name - Where videos are stored (required)
    bucket: process.env.S3_BUCKET,
    // Input Folder - Where original videos are uploaded (default: 'input')
    inputFolder: process.env.S3_INPUT_FOLDER || 'input',
    // Output Folder - Where processed videos are saved (default: 'output')
    outputFolder: process.env.S3_OUTPUT_FOLDER || 'output',
  },
  mediaconvert: {
    // MediaConvert Endpoint URL - Auto-constructed if not provided
    // Format: https://mediaconvert.{region}.amazonaws.com
    endpoint: process.env.MEDIACONVERT_ENDPOINT || `https://mediaconvert.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`,
    // IAM Role ARN - Required: Role that MediaConvert assumes to access S3
    // This role must have S3 read/write permissions
    roleArn: process.env.MEDIACONVERT_ROLE_ARN,
    // MediaConvert Queue ARN - Optional: Specific queue to use for jobs
    // If not provided, uses default queue
    queueArn: process.env.MEDIACONVERT_QUEUE_ARN,
    // Polling Interval - How often to check job status (default: 5000ms)
    // Lower values = more frequent updates but more API calls
    pollIntervalMs: parseInt(process.env.MEDIACONVERT_POLL_INTERVAL_MS) || 5000,
    // Watermark Opacity - Opacity level for watermarks (0-100, default: 80)
    // 100 = fully opaque, 0 = fully transparent
    watermarkOpacity: parseInt(process.env.WATERMARK_OPACITY) || 50,
  },
};

/**
 * Configuration Validation
 * 
 * Validates that all required configuration values are present.
 * This is done on module load to ensure the application fails fast
 * if configuration is incomplete, rather than failing later during runtime.
 * 
 * Required values:
 * - AWS credentials (accessKeyId, secretAccessKey)
 * - S3 bucket name
 * - MediaConvert IAM role ARN
 * 
 * Optional values (have defaults):
 * - AWS region (defaults to us-east-1)
 * - Input/output folders (default to 'input' and 'output')
 * - Polling interval (defaults to 5000ms)
 */

// Validate AWS credentials are configured
if (!config.aws.accessKeyId || !config.aws.secretAccessKey) {
  console.error('Error: AWS credentials not configured in .env file');
  console.error('Required: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
  process.exit(1);
}

// Validate S3 bucket is configured
if (!config.s3.bucket) {
  console.error('Error: S3_BUCKET not configured in .env file');
  console.error('Required: S3_BUCKET environment variable');
  process.exit(1);
}

// Validate MediaConvert IAM role is configured
if (!config.mediaconvert.roleArn) {
  console.error('Error: MEDIACONVERT_ROLE_ARN not configured in .env file');
  console.error('Required: MEDIACONVERT_ROLE_ARN (IAM role with S3 permissions)');
  process.exit(1);
}
