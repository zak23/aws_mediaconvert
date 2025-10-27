import { MediaConvertClient, CreateJobCommand, GetJobCommand, JobStatus } from '@aws-sdk/client-mediaconvert';
import { config } from './config.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { execSync } from 'child_process';

const mediaConvertClient = new MediaConvertClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
  endpoint: config.mediaconvert.endpoint,
});

/**
 * Convert seconds to MediaConvert timecode format (HH:MM:SS:FF)
 * @param {number} totalSeconds - Total seconds
 * @param {number} frames - Frame number
 * @returns {string} Timecode string
 */
function secondsToTimecode(totalSeconds, frames = 0) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Generate looping watermark sequence for entire video duration
 * @param {Object} options - Watermark configuration options
 * @param {number} options.videoWidth - Video width in pixels
 * @param {number} options.videoHeight - Video height in pixels
 * @param {number} options.videoDurationMs - Video duration in milliseconds
 * @param {number} options.watermarkSize - Watermark size in pixels (width and height)
 * @param {number} options.offset - Offset from edges in pixels
 * @param {number} options.durationMs - Duration for each watermark in milliseconds
 * @param {number} options.opacity - Opacity (0-100)
 * @param {string} options.watermarkUri - S3 URI of the watermark image
 * @returns {Array} Array of watermark insertable images
 */
function generateWatermarkSequence({
  videoWidth = 1920,
  videoHeight = 1080,
  videoDurationMs = 15000,
  watermarkSize = 100,
  offset = 50,
  durationMs = 2000,
  opacity = 80,
  watermarkUri = `s3://${config.s3.bucket}/assets/watermark.png`,
}) {
  const corners = [
    { name: 'top-left', x: offset, y: offset },
    { name: 'top-right', x: videoWidth - watermarkSize - offset, y: offset },
    { name: 'bottom-left', x: offset, y: videoHeight - watermarkSize - offset },
    { name: 'bottom-right', x: videoWidth - watermarkSize - offset, y: videoHeight - watermarkSize - offset },
  ];

  const sequenceDurationMs = durationMs * corners.length; // Total time for one complete sequence
  const numberOfSequences = Math.ceil(videoDurationMs / sequenceDurationMs);
  const watermarks = [];
  
  let layerIndex = 0;
  
  // Generate multiple sequences to cover the entire video
  for (let sequenceIndex = 0; sequenceIndex < numberOfSequences; sequenceIndex++) {
    const sequenceStartMs = sequenceIndex * sequenceDurationMs;
    
    corners.forEach((corner, cornerIndex) => {
      const watermarkStartMs = sequenceStartMs + (cornerIndex * durationMs);
      
      // Only add if it starts before the video ends
      if (watermarkStartMs < videoDurationMs) {
        // Calculate remaining duration if this is the last sequence
        let watermarkDuration = durationMs;
        if (watermarkStartMs + durationMs > videoDurationMs) {
          watermarkDuration = videoDurationMs - watermarkStartMs;
        }
        
        watermarks.push({
          ImageInserterInput: watermarkUri,
          Layer: layerIndex++,
          Opacity: opacity,
          Width: watermarkSize,
          Height: watermarkSize,
          Duration: watermarkDuration,
          StartTime: secondsToTimecode(watermarkStartMs / 1000),
          ImageX: corner.x,
          ImageY: corner.y,
        });
      }
    });
  }
  
  return watermarks;
}

/**
 * Calculate optimal watermark size based on video dimensions
 * @param {number} videoWidth - Video width in pixels
 * @param {number} videoHeight - Video height in pixels
 * @param {number} percentSize - Percentage of video height (default: 8%)
 * @param {number} minSize - Minimum watermark size in pixels (default: 60)
 * @returns {number} Calculated watermark size
 */
function calculateWatermarkSize(videoWidth, videoHeight, percentSize = 10, minSize = 80) {
  // Use the smaller dimension to ensure watermark fits both orientations
  const smallerDimension = Math.min(videoWidth, videoHeight);
  const calculatedSize = (smallerDimension * percentSize) / 100;
  const finalSize = Math.max(calculatedSize, minSize);
  
  return Math.floor(finalSize);
}

/**
 * Calculate watermark offset based on video dimensions
 * @param {number} videoWidth - Video width in pixels
 * @param {number} videoHeight - Video height in pixels
 * @returns {number} Offset in pixels
 */
function calculateWatermarkOffset(videoWidth, videoHeight) {
  // Use 3-5% of the smaller dimension, minimum 30px
  const smallerDimension = Math.min(videoWidth, videoHeight);
  const percentOffset = Math.max(3, Math.min(5, smallerDimension / 400));
  const offset = (smallerDimension * percentOffset) / 100;
  return Math.max(Math.floor(offset), 20);
}

/**
 * Calculate output resolution, scaling down if long edge exceeds maxLongEdge
 * @param {number} width - Original video width in pixels
 * @param {number} height - Original video height in pixels
 * @param {number} maxLongEdge - Maximum allowed long edge dimension (default: 1920)
 * @returns {Object} Output dimensions {width, height}
 */
function calculateOutputResolution(width, height, maxLongEdge = 1920) {
  const longEdge = Math.max(width, height);
  
  // If long edge is already <= maxLongEdge, return original dimensions
  if (longEdge <= maxLongEdge) {
    return { width, height };
  }
  
  // Calculate scaling factor
  const scaleFactor = maxLongEdge / longEdge;
  
  // Scale both dimensions proportionally
  const newWidth = Math.round(width * scaleFactor);
  const newHeight = Math.round(height * scaleFactor);
  
  console.log(`📐 Resolution scaling: ${width}x${height} → ${newWidth}x${newHeight} (scale factor: ${scaleFactor.toFixed(3)})`);
  
  return { 
    width: newWidth, 
    height: newHeight 
  };
}

/**
 * Get video metadata (duration and dimensions) using ffprobe
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<Object>} Video metadata with durationMs, width, height
 */
async function getVideoMetadata(videoPath) {
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
      
      const durationMs = metadata.format.duration * 1000;
      const width = videoStream.width;
      const height = videoStream.height;
      
      console.log(`Video metadata detected:`);
      console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`);
      console.log(`  Dimensions: ${width}x${height}`);
      
      resolve({
        durationMs: Math.floor(durationMs),
        width,
        height,
      });
    });
  });
}

/**
 * Create a MediaConvert job to convert video to MP4
 * @param {string} inputUri - S3 URI of the input video
 * @param {string} localFilePath - Local path to the video file (optional)
 * @returns {Promise<string>} Job ID
 */
export async function createMediaConvertJob(inputUri, localFilePath = null) {
  try {
    const fileName = path.basename(inputUri);
    const outputKey = `${config.s3.outputFolder}/${fileName}`;
    const outputUri = `s3://${config.s3.bucket}/${outputKey}`;

    console.log(`Creating MediaConvert job...`);
    console.log(`Input: ${inputUri}`);
    console.log(`Output: ${outputUri}`);

    // Get video metadata if local file is provided
    let videoMetadata = { durationMs: 15000, width: 1920, height: 1080 };
    if (localFilePath) {
      try {
        videoMetadata = await getVideoMetadata(localFilePath);
      } catch (error) {
        console.warn(`Could not read video metadata: ${error.message}. Using defaults.`);
      }
    }

    // Calculate output resolution (scale down if long edge > 1920)
    const outputResolution = calculateOutputResolution(videoMetadata.width, videoMetadata.height, 1920);

    // Calculate optimal watermark size and offset based on output resolution
    const watermarkSize = calculateWatermarkSize(outputResolution.width, outputResolution.height, 10, 80);
    const watermarkOffset = calculateWatermarkOffset(outputResolution.width, outputResolution.height);

    console.log(`\n💧 Watermark Configuration:`);
    console.log(`  Size: ${watermarkSize}x${watermarkSize}px`);
    console.log(`  Offset: ${watermarkOffset}px from edges`);
    console.log(`  Opacity: 80%`);
    console.log(`  Animation: Looping corner sequence (2s per corner)`);
    console.log(`\n📐 Output Resolution: ${outputResolution.width}x${outputResolution.height}\n`);

    const jobSettings = {
      Role: config.mediaconvert.roleArn,
      ...(config.mediaconvert.queueArn && { Queue: config.mediaconvert.queueArn }),
      Settings: {
        Inputs: [
          {
            FileInput: inputUri,
            VideoSelector: {},
            AudioSelectors: {
              'Audio Selector 1': {
                DefaultSelection: 'DEFAULT',
              },
            },
          },
        ],
        OutputGroups: [
          {
            Name: 'File Group',
            OutputGroupSettings: {
              Type: 'FILE_GROUP_SETTINGS',
              FileGroupSettings: {
                Destination: `s3://${config.s3.bucket}/${config.s3.outputFolder}/`,
              },
            },
            Outputs: [
              {
                VideoDescription: {
                  Width: outputResolution.width,
                  Height: outputResolution.height,
                  CodecSettings: {
                    Codec: 'H_264',
                    H264Settings: {
                      MaxBitrate: 5000000,
                      RateControlMode: 'QVBR',
                      QualityTuningLevel: 'SINGLE_PASS_HQ',
                      SceneChangeDetect: 'TRANSITION_DETECTION',
                    },
                  },
                  VideoPreprocessors: {
                    ImageInserter: {
                      InsertableImages: generateWatermarkSequence({
                        videoWidth: outputResolution.width,
                        videoHeight: outputResolution.height,
                        videoDurationMs: videoMetadata.durationMs,
                        watermarkSize,
                        offset: watermarkOffset,
                        durationMs: 2000,
                        opacity: 80,
                        watermarkUri: `s3://${config.s3.bucket}/assets/watermark.png`,
                      }),
                    },
                  },
                },
                AudioDescriptions: [
                  {
                    AudioSourceName: 'Audio Selector 1',
                    CodecSettings: {
                      Codec: 'AAC',
                      AacSettings: {
                        Bitrate: 128000,
                        CodingMode: 'CODING_MODE_2_0',
                        SampleRate: 48000,
                      },
                    },
                  },
                ],
                ContainerSettings: {
                  Container: 'MP4',
                  Mp4Settings: {},
                },
                NameModifier: `_${Date.now()}`,
              },
            ],
          },
        ],
        TimecodeConfig: {
          Source: 'ZEROBASED',
        },
      },
    };

    const command = new CreateJobCommand(jobSettings);
    const response = await mediaConvertClient.send(command);

    console.log(`MediaConvert job created: ${response.Job.Id}`);
    return response.Job.Id;

  } catch (error) {
    console.error('Error creating MediaConvert job:', error.message);
    throw error;
  }
}

/**
 * Get the status of a MediaConvert job
 * @param {string} jobId - The job ID to check
 * @returns {Promise<Object>} Job status information
 */
export async function getJobStatus(jobId) {
  try {
    const command = new GetJobCommand({ Id: jobId });
    const response = await mediaConvertClient.send(command);
    return response.Job;
  } catch (error) {
    console.error('Error getting job status:', error.message);
    throw error;
  }
}

/**
 * Monitor job progress and display updates in the terminal
 * @param {string} jobId - The job ID to monitor
 * @returns {Promise<Object>} Final job status
 */
export async function monitorJobProgress(jobId) {
  const pollIntervalMs = config.mediaconvert.pollIntervalMs;
  const startTime = Date.now();
  let previousStatus = null;
  let lastProgressUpdate = 0;
  
  console.log('\n📊 Monitoring transcoding progress...\n');
  
  while (true) {
    try {
      const job = await getJobStatus(jobId);
      const status = job.Status;
      const currentTime = Date.now();
      const elapsedSeconds = Math.floor((currentTime - startTime) / 1000);
      const timestamp = new Date().toLocaleTimeString();
      
      // Always log on status change
      if (status !== previousStatus) {
        switch (status) {
          case JobStatus.SUBMITTED:
            console.log(`[${timestamp}] ⏳ Job submitted (${elapsedSeconds}s elapsed)`);
            break;
          case JobStatus.PROGRESSING:
            console.log(`[${timestamp}] 🎬 Job progressing... (${elapsedSeconds}s elapsed)`);
            if (job.CurrentPhase) {
              console.log(`     Current phase: ${job.CurrentPhase}`);
            }
            break;
          case JobStatus.COMPLETE:
            console.log(`[${timestamp}] ✅ Job completed successfully! (${elapsedSeconds}s total)`);
            if (job.Settings && job.Settings.OutputGroups) {
              const outputs = job.Settings.OutputGroups.flatMap(og => og.Outputs || []);
              console.log(`     Output file: ${job.Settings.OutputGroups[0].OutputGroupSettings.FileGroupSettings.Destination}`);
            }
            return job;
          case JobStatus.CANCELED:
            console.log(`[${timestamp}] ❌ Job was canceled`);
            throw new Error('MediaConvert job was canceled');
          case JobStatus.ERROR:
            console.log(`[${timestamp}] ❌ Job failed`);
            if (job.ErrorMessage) {
              console.log(`     Error: ${job.ErrorMessage}`);
            }
            if (job.ErrorCode) {
              console.log(`     Error code: ${job.ErrorCode}`);
            }
            throw new Error(`MediaConvert job failed: ${job.ErrorMessage || 'Unknown error'}`);
          default:
            console.log(`[${timestamp}] 📋 Status: ${status} (${elapsedSeconds}s elapsed)`);
        }
        previousStatus = status;
      }
      // Show periodic progress updates every 20 seconds (or when % complete changes)
      else if (status === JobStatus.PROGRESSING && (elapsedSeconds - lastProgressUpdate) >= 20) {
        let progressInfo = `[${timestamp}] 🎬 Still processing... (${elapsedSeconds}s elapsed)`;
        
        // Show current phase if available
        if (job.CurrentPhase) {
          progressInfo += `\n     Current phase: ${job.CurrentPhase}`;
        }
        
        // Show percent complete if available
        if (job.JobPercentComplete) {
          progressInfo += `\n     Progress: ${job.JobPercentComplete}% complete`;
        }
        
        console.log(progressInfo);
        lastProgressUpdate = elapsedSeconds;
      }
      
      // Break the loop if job is in terminal state
      if ([JobStatus.COMPLETE, JobStatus.ERROR, JobStatus.CANCELED].includes(status)) {
        break;
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      
    } catch (error) {
      if (error.message.includes('MediaConvert job')) {
        throw error;
      }
      console.error(`Error monitoring job: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }
}

