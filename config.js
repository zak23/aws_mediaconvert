import dotenv from 'dotenv';

dotenv.config();

export const config = {
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
  },
  s3: {
    bucket: process.env.S3_BUCKET,
    inputFolder: process.env.S3_INPUT_FOLDER || 'input',
    outputFolder: process.env.S3_OUTPUT_FOLDER || 'output',
  },
  mediaconvert: {
    endpoint: process.env.MEDIACONVERT_ENDPOINT || `https://mediaconvert.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`,
    roleArn: process.env.MEDIACONVERT_ROLE_ARN,
    queueArn: process.env.MEDIACONVERT_QUEUE_ARN,
    pollIntervalMs: parseInt(process.env.MEDIACONVERT_POLL_INTERVAL_MS) || 5000,
  },
};

// Validate required configuration
if (!config.aws.accessKeyId || !config.aws.secretAccessKey) {
  console.error('Error: AWS credentials not configured in .env file');
  process.exit(1);
}

if (!config.s3.bucket) {
  console.error('Error: S3_BUCKET not configured in .env file');
  process.exit(1);
}

if (!config.mediaconvert.roleArn) {
  console.error('Error: MEDIACONVERT_ROLE_ARN not configured in .env file');
  process.exit(1);
}

