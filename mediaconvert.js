/**
 * MediaConvert Module - Video Processing and Job Management
 * 
 * This module handles all AWS MediaConvert operations including:
 * - Creating MediaConvert jobs with intelligent video settings
 * - Monitoring job progress in real-time
 * - Extracting video metadata using FFprobe
 * - Generating watermark sequences with animation
 * - Calculating optimal resolution and bitrate settings
 * 
 * Key Features:
 * - Automatic resolution scaling (max 1920px long edge)
 * - Even dimension enforcement (MediaConvert requirement)
 * - Dynamic watermark animation (looping sequence)
 * - Smart bitrate calculation based on resolution scaling
 * - Real-time progress monitoring with status updates
 * 
 * Dependencies:
 * - @aws-sdk/client-mediaconvert: MediaConvert API client
 * - fluent-ffmpeg: Video metadata via FFprobe
 * - path: Path utilities
 */

import { MediaConvertClient, CreateJobCommand, GetJobCommand, JobStatus } from '@aws-sdk/client-mediaconvert';
import { config } from './config.js';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { execSync } from 'child_process';

/**
 * MediaConvert Client Instance
 * 
 * Initialized with AWS credentials, region, and custom endpoint.
 * Used for all MediaConvert operations (create job, get status).
 */
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
 * 
 * MediaConvert uses a specific timecode format for watermark timing.
 * Format: Hours:Minutes:Seconds:Frames
 * 
 * @param {number} totalSeconds - Total seconds (can include fractional seconds)
 * @param {number} frames - Frame number (default: 0)
 * @returns {string} Timecode string in format HH:MM:SS:FF
 * 
 * Example: 125.5 seconds → "00:02:05:00"
 */
function secondsToTimecode(totalSeconds, frames = 0) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Generate looping watermark sequence for entire video duration
 * 
 * This function creates an animated watermark sequence that loops throughout the video.
 * The watermark alternates between top-left and bottom-right corners, creating a
 * continuous loop effect.
 * 
 * How it works:
 * 1. Define corner positions (top-left and bottom-right)
 * 2. Calculate how many complete sequences are needed for the video duration
 * 3. Generate watermark objects for each corner in each sequence
 * 4. Adjust duration for the final watermark if it extends beyond video end
 * 
 * @param {Object} options - Watermark configuration options
 * @param {number} options.videoWidth - Video width in pixels
 * @param {number} options.videoHeight - Video height in pixels
 * @param {number} options.videoDurationMs - Video duration in milliseconds
 * @param {number} options.watermarkSize - Watermark size in pixels (square, width and height)
 * @param {number} options.offset - Offset from edges in pixels
 * @param {number} options.durationMs - Duration for each watermark in milliseconds (default: 5000)
 * @param {number} options.opacity - Opacity (0-100, where 100 is fully opaque)
 * @param {string} options.watermarkUri - S3 URI of the watermark image (e.g., 's3://bucket/assets/logo.png')
 * @returns {Array} Array of watermark objects ready for MediaConvert InsertableImages
 * 
 * Example for 30-second video:
 * - Sequence duration: 5s per corner × 2 corners = 10s
 * - Number of sequences: ceil(30000ms / 10000ms) = 3 sequences
 * - Total watermarks: 3 sequences × 2 corners = 6 watermarks
 */
function generateWatermarkSequence({
  videoWidth = 1920,
  videoHeight = 1080,
  videoDurationMs = 15000,
  watermarkSize = 100,
  offset = 50,
  durationMs = 5000,
  opacity = 80,
  watermarkUri = `s3://${config.s3.bucket}/assets/watermark.png`,
}) {
  // Define corner positions where watermarks will appear
  // Top-left: near top-left corner
  // Bottom-right: near bottom-right corner
  const corners = [
    { name: 'top-left', x: offset, y: offset },
    { name: 'bottom-right', x: videoWidth - watermarkSize - offset, y: videoHeight - watermarkSize - offset },
  ];

  // Calculate timing information
  const sequenceDurationMs = durationMs * corners.length; // Total time for one complete sequence
  const numberOfSequences = Math.ceil(videoDurationMs / sequenceDurationMs); // How many sequences needed
  const watermarks = []; // Array to hold all watermark objects
  
  let layerIndex = 0; // Track layer number for each watermark (MediaConvert requirement)
  
  // Generate multiple sequences to cover the entire video duration
  for (let sequenceIndex = 0; sequenceIndex < numberOfSequences; sequenceIndex++) {
    const sequenceStartMs = sequenceIndex * sequenceDurationMs;
    
    corners.forEach((corner, cornerIndex) => {
      const watermarkStartMs = sequenceStartMs + (cornerIndex * durationMs);
      
      // Only add if it starts before the video ends
      if (watermarkStartMs < videoDurationMs) {
        // Calculate remaining duration if this is the last sequence
        // Duration MUST be integer milliseconds (not timecode string)
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
          Duration: Math.floor(watermarkDuration), // Integer milliseconds - CRITICAL for watermark to show
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
 * Generate static watermarks for videos (no animation)
 * 
 * This function creates two static watermarks that persist throughout the entire video:
 * - Top-left corner
 * - Bottom-right corner
 * 
 * Used for videos with yuvj420p color space to avoid ImageInserter preprocessor failures
 * when using animated watermarks.
 * 
 * @param {Object} options - Watermark configuration options
 * @param {number} options.videoWidth - Video width in pixels
 * @param {number} options.videoHeight - Video height in pixels
 * @param {number} options.watermarkSize - Watermark size in pixels (square, width and height)
 * @param {number} options.offset - Offset from edges in pixels
 * @param {number} options.opacity - Opacity (0-100, where 100 is fully opaque)
 * @param {string} options.watermarkUri - S3 URI of the watermark image
 * @returns {Array} Array of 2 watermark objects (top-left, bottom-right)
 */
function generateStaticWatermarks({
  videoWidth = 1920,
  videoHeight = 1080,
  watermarkSize = 100,
  offset = 50,
  opacity = 80,
  watermarkUri = `s3://${config.s3.bucket}/assets/watermark.png`,
}) {
  return [
    {
      ImageInserterInput: watermarkUri,
      Layer: 0,
      Opacity: opacity,
      Width: watermarkSize,
      Height: watermarkSize,
      ImageX: offset,
      ImageY: offset,
    },
    {
      ImageInserterInput: watermarkUri,
      Layer: 1,
      Opacity: opacity,
      Width: watermarkSize,
      Height: watermarkSize,
      ImageX: videoWidth - watermarkSize - offset,
      ImageY: videoHeight - watermarkSize - offset,
    }
  ];
}

/**
 * Calculate optimal watermark size based on video dimensions
 * 
 * This function determines the appropriate watermark size based on video dimensions.
 * It uses the smaller dimension (width or height) to ensure the watermark fits
 * properly in both landscape and portrait orientations.
 * 
 * Formula: Smaller dimension × percentage, with a minimum size enforced.
 * 
 * Why use smaller dimension?
 * - Landscape videos: smaller dimension = height, watermark fits vertically
 * - Portrait videos: smaller dimension = width, watermark fits horizontally
 * - Ensures watermark is always visible and proportional
 * 
 * @param {number} videoWidth - Video width in pixels
 * @param {number} videoHeight - Video height in pixels
 * @param {number} percentSize - Percentage of smaller dimension (default: 10%)
 * @param {number} minSize - Minimum watermark size in pixels (default: 80)
 * @returns {number} Calculated watermark size (rounded down to integer)
 * 
 * Examples:
 * - 1920×1080 → uses 1080px → 10% = 108px → returns 108px
 * - 3840×2160 → uses 2160px → 10% = 216px → returns 216px
 * - 720×480 → uses 480px → 10% = 48px → min 80px → returns 80px
 */
function calculateWatermarkSize(videoWidth, videoHeight, percentSize = 10, minSize = 80) {
  // Use the smaller dimension to ensure watermark fits both orientations
  const smallerDimension = Math.min(videoWidth, videoHeight);
  // Calculate size as percentage of smaller dimension
  const calculatedSize = (smallerDimension * percentSize) / 100;
  // Apply minimum size requirement
  const finalSize = Math.max(calculatedSize, minSize);
  
  // Round down to integer (pixels must be whole numbers)
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
 * Ensure dimensions are even numbers (MediaConvert requirement)
 * 
 * AWS MediaConvert requires all video dimensions (width and height) to be even numbers.
 * This function rounds a dimension down to the nearest even number.
 * 
 * Why even numbers?
 * - H.264 encoding standards require even dimensions for certain optimizations
 * - Prevents encoding errors and quality issues
 * - Ensures compatibility across all devices
 * 
 * Formula: Round down to nearest even (e.g., 1921 → 1920, 1081 → 1080)
 * 
 * @param {number} dimension - Dimension to make even (width or height)
 * @returns {number} Even dimension (always ≤ original dimension)
 * 
 * Examples:
 * - 1921 → 1920
 * - 1080 → 1080 (already even)
 * - 99 → 98
 * - 100 → 100 (already even)
 */
function ensureEven(dimension) {
  // Round down to nearest even number
  // Example: 1921 / 2 = 960.5, floor = 960, * 2 = 1920
  return Math.floor(dimension / 2) * 2;
}

/**
 * Calculate output resolution with automatic scaling
 * 
 * This function determines the output video dimensions, scaling down if necessary.
 * It ensures the long edge (max of width/height) doesn't exceed maxLongEdge (1920px).
 * All dimensions are guaranteed to be even numbers (MediaConvert requirement).
 * 
 * Scaling logic:
 * 1. If long edge ≤ 1920px: Keep original dimensions (with even adjustment)
 * 2. If long edge > 1920px: Scale proportionally to fit within 1920px
 * 3. Always ensure both width and height are even numbers
 * 
 * Why 1920px limit?
 * - 1920×1080 is standard HD resolution
 * - Reduces file size and processing time
 * - Maintains good quality for web streaming
 * - Most devices display well at this resolution
 * 
 * @param {number} width - Original video width in pixels
 * @param {number} height - Original video height in pixels
 * @param {number} maxLongEdge - Maximum allowed long edge dimension (default: 1920)
 * @returns {Object} Output dimensions {width, height} (both even numbers)
 * 
 * Examples:
 * - 3840×2160 → 1920×1080 (scale factor: 0.5)
 * - 2560×1440 → 1920×1080 (scale factor: 0.75)
 * - 1920×1080 → 1920×1080 (no scaling, already optimal)
 * - 1280×720 → 1280×720 (no scaling, already below limit)
 */
function calculateOutputResolution(width, height, maxLongEdge = 1920) {
  const longEdge = Math.max(width, height);
  
  // Case 1: Resolution is already within limits, just ensure even dimensions
  if (longEdge <= maxLongEdge) {
    const evenWidth = ensureEven(width);
    const evenHeight = ensureEven(height);
    
    // Log if dimensions were adjusted to be even
    if (evenWidth !== width || evenHeight !== height) {
      console.log(`📐 Even dimension adjustment: ${width}x${height} → ${evenWidth}x${evenHeight}`);
    }
    
    return { width: evenWidth, height: evenHeight };
  }
  
  // Case 2: Resolution exceeds limit, need to scale down
  // Calculate scale factor to bring long edge down to maxLongEdge
  const scaleFactor = maxLongEdge / longEdge;
  
  // Scale both dimensions proportionally (maintains aspect ratio)
  const newWidth = Math.round(width * scaleFactor);
  const newHeight = Math.round(height * scaleFactor);
  
  // Ensure both dimensions are even numbers (MediaConvert requirement)
  const evenWidth = ensureEven(newWidth);
  const evenHeight = ensureEven(newHeight);
  
  // Log the scaling operation
  console.log(`📐 Resolution scaling: ${width}x${height} → ${evenWidth}x${evenHeight} (scale factor: ${scaleFactor.toFixed(3)})`);
  
  return { 
    width: evenWidth, 
    height: evenHeight 
  };
}


/**
 * Get video metadata (duration, dimensions, bitrate, and color space) using ffprobe
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<Object>} Video metadata with durationMs, width, height, bitrate, colorSpace
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
      let width = videoStream.width;
      let height = videoStream.height;
      
      // Check for rotation metadata using direct ffprobe call
      let rotation = 0;
      try {
        const rotationOutput = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation -of json "${videoPath}"`,
          { encoding: 'utf8' }
        );
        const rotationData = JSON.parse(rotationOutput);
        if (rotationData.streams && rotationData.streams.length > 0) {
          const stream = rotationData.streams[0];
          if (stream.side_data_list && stream.side_data_list.length > 0) {
            for (const sideData of stream.side_data_list) {
              if (sideData.rotation !== undefined) {
                rotation = sideData.rotation;
                console.log(`📱 Rotation detected: ${rotation}°`);
                break;
              }
            }
          }
        }
      } catch (error) {
        // Rotation detection failed, continue without it
        console.log(`⚠️  Could not detect rotation: ${error.message}`);
      }
      
      // If rotation is 90 or -90 degrees (or 270 degrees), swap width and height
      // This accounts for portrait videos that need to be rotated
      if (rotation === 90 || rotation === -90 || rotation === 270 || rotation === -270) {
        console.log(`   ↻ Swapping dimensions: ${width}x${height} → ${height}x${width}`);
        [width, height] = [height, width];
      }
      
      // Get bitrate from video stream or format, preferring video stream bitrate
      const bitrate = videoStream.bit_rate || metadata.format.bit_rate || 0;
      
      // Detect color space (pixel format) using direct ffprobe call
      let colorSpace = 'unknown';
      try {
        const colorSpaceOutput = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
          { encoding: 'utf8' }
        );
        colorSpace = colorSpaceOutput.trim();
      } catch (error) {
        console.log(`⚠️  Could not detect color space: ${error.message}`);
      }
      
      console.log(`Video metadata detected:`);
      console.log(`  Duration: ${(durationMs / 1000).toFixed(2)}s`);
      console.log(`  Dimensions: ${width}x${height}`);
      console.log(`  Bitrate: ${(bitrate / 1000000).toFixed(2)} Mbps`);
      console.log(`  Color space: ${colorSpace}`);
      
      resolve({
        durationMs: Math.floor(durationMs),
        width,
        height,
        bitrate,
        colorSpace,
      });
    });
  });
}

/**
 * Create a MediaConvert job to convert video to MP4
 * 
 * VideoSelector configuration:
 * - ColorSpace: REC_709 (standard HD color space)
 * - Rotate: AUTO (handles mobile video rotation automatically)
 * - ColorSpaceUsage: FORCE (ensures consistent color space across all inputs)
 * 
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
    let videoMetadata = { durationMs: 15000, width: 1920, height: 1080, bitrate: 5000000 };
    if (localFilePath) {
      try {
        videoMetadata = await getVideoMetadata(localFilePath);
      } catch (error) {
        console.warn(`Could not read video metadata: ${error.message}. Using defaults.`);
      }
    }

    // Calculate output resolution (scale down if long edge > 1920)
    // MediaConvert applies rotation FIRST, then inserts watermarks on the rotated output
    // So we use the post-rotation dimensions for both output and watermark calculations
    const outputResolution = calculateOutputResolution(videoMetadata.width, videoMetadata.height, 1920);

    // Calculate output bitrate with 5 Mbps maximum
    const scaleFactor = Math.min(outputResolution.width / videoMetadata.width, outputResolution.height / videoMetadata.height);
    const scaledBitrate = Math.floor(videoMetadata.bitrate * scaleFactor);
    const maxBitrate = 10000000; // 10 Mbps in bps
    const outputBitrate = Math.min(scaledBitrate, maxBitrate);
    
    console.log(`\n📊 Bitrate Settings:`);
    console.log(`  Original: ${(videoMetadata.bitrate / 1000000).toFixed(2)} Mbps`);
    console.log(`  Scaled: ${(scaledBitrate / 1000000).toFixed(2)} Mbps (scale factor: ${scaleFactor.toFixed(3)})`);
    console.log(`  Output: ${(outputBitrate / 1000000).toFixed(2)} Mbps (max: 10 Mbps)`);

    // Calculate optimal watermark size and offset based on OUTPUT resolution
    // MediaConvert applies rotation FIRST, then inserts watermarks on rotated video
    const watermarkSize = calculateWatermarkSize(outputResolution.width, outputResolution.height, 10, 80);
    const watermarkOffset = calculateWatermarkOffset(outputResolution.width, outputResolution.height);

    // Detect problem color spaces and choose appropriate watermark strategy
    // These color spaces don't work with animated watermarks: yuv420p10le, yuv420p, yuvj420p
    const problematicColorSpaces = ['yuv420p10le', 'yuv420p', 'yuvj420p'];
    const needsStaticWatermark = problematicColorSpaces.includes(videoMetadata.colorSpace);
    
    console.log(`\n💧 Watermark Configuration:`);
    console.log(`  Strategy: ${needsStaticWatermark ? 'Static (color space compatibility)' : 'Animated looping'}`);
    console.log(`  Output Resolution: ${outputResolution.width}x${outputResolution.height}`);
    console.log(`  Watermark Size: ${watermarkSize}x${watermarkSize}px`);
    console.log(`  Positions: Top-left + Bottom-right`);
    console.log(`  Offset: ${watermarkOffset}px from edges`);
    console.log(`  Opacity: 80%\n`);

    // Generate watermark sequence based on color space
    let watermarkSequence;
    if (needsStaticWatermark) {
      console.log(`⚠️  ${videoMetadata.colorSpace} color space detected - using static watermarks for compatibility`);
      watermarkSequence = generateStaticWatermarks({
        videoWidth: outputResolution.width,
        videoHeight: outputResolution.height,
        watermarkSize,
        offset: watermarkOffset,
        opacity: 80,
        watermarkUri: `s3://${config.s3.bucket}/assets/watermark.png`,
      });
    } else {
      console.log(`✓ Compatible color space detected - using animated watermarks`);
      watermarkSequence = generateWatermarkSequence({
        videoWidth: outputResolution.width,
        videoHeight: outputResolution.height,
        videoDurationMs: videoMetadata.durationMs,
        watermarkSize,
        offset: watermarkOffset,
        durationMs: 5000,
        opacity: 80,
        watermarkUri: `s3://${config.s3.bucket}/assets/watermark.png`,
      });
    }
    

    const jobSettings = {
      Role: config.mediaconvert.roleArn,
      ...(config.mediaconvert.queueArn && { Queue: config.mediaconvert.queueArn }),
      StatusUpdateInterval: 'SECONDS_10', // Update status every 10 seconds - 10 seconds is the minimum
      Settings: {
        Inputs: [
          {
            FileInput: inputUri,
            VideoSelector: {
              ColorSpace: 'REC_709',
              Rotate: 'AUTO',
              ColorSpaceUsage: 'FORCE'
            },
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
                      MaxBitrate: outputBitrate,
                      RateControlMode: 'QVBR',
                      QualityTuningLevel: 'SINGLE_PASS_HQ',
                      SceneChangeDetect: 'TRANSITION_DETECTION',
                    },
                  },
                  VideoPreprocessors: {
                    ImageInserter: {
                      InsertableImages: watermarkSequence,
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
            
            // Extract output file URI from completed job
            let outputUri = null;
            try {
              if (job.Settings && job.Settings.OutputGroups && job.Settings.OutputGroups.length > 0 && 
                  job.Settings.Inputs && job.Settings.Inputs.length > 0) {
                const outputGroup = job.Settings.OutputGroups[0];
                const destination = outputGroup.OutputGroupSettings?.FileGroupSettings?.Destination;
                
                const fileName = path.basename(job.Settings.Inputs[0].FileInput);
                const baseName = path.basename(fileName, path.extname(fileName));
                
                // Try to get nameModifier from output settings
                let nameModifier = '';
                if (outputGroup.Outputs && outputGroup.Outputs.length > 0 && outputGroup.Outputs[0].NameModifier) {
                  nameModifier = outputGroup.Outputs[0].NameModifier;
                } else if (outputGroup.Outputs && outputGroup.Outputs[0].NameModifier === undefined) {
                  nameModifier = '_' + Date.now();
                }
                
                // Determine output extension from container settings
                let extension = '.mp4'; // Default to MP4
                if (outputGroup.Outputs && outputGroup.Outputs.length > 0) {
                  const container = outputGroup.Outputs[0].ContainerSettings?.Container;
                  if (container === 'MP4') {
                    extension = '.mp4';
                  } else if (container === 'MOV') {
                    extension = '.mov';
                  }
                }
                
                // Remove trailing slash from destination
                const cleanDestination = destination.endsWith('/') ? destination.slice(0, -1) : destination;
                outputUri = `${cleanDestination}/${baseName}${nameModifier}${extension}`;
                
                console.log(`     Output file: ${outputUri}`);
              } else {
                console.log(`     Output location: s3://${config.s3.bucket}/${config.s3.outputFolder}/`);
              }
            } catch (error) {
              // Silently handle output URI extraction errors - job is still complete
              console.log(`     Output location: s3://${config.s3.bucket}/${config.s3.outputFolder}/`);
            }
            
            return { job, outputUri };
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
      // Show progress updates for PROGRESSING status
      else if (status === JobStatus.PROGRESSING) {
        // Show updates every 10 seconds or when percent complete changes
        const shouldShowUpdate = 
          (elapsedSeconds - lastProgressUpdate) >= 10 ||
          job.JobPercentComplete !== undefined;
        
        if (shouldShowUpdate) {
          let progressInfo = `[${timestamp}] 🎬 Processing... (${elapsedSeconds}s elapsed)`;
          
          // Show current phase if available
          if (job.CurrentPhase) {
            progressInfo += `\n     Phase: ${job.CurrentPhase}`;
          }
          
          // Show percent complete if available
          if (job.JobPercentComplete !== undefined) {
            progressInfo += ` - ${job.JobPercentComplete}% complete`;
          }
          
          console.log(progressInfo);
          lastProgressUpdate = elapsedSeconds;
        }
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
      
      // Break loop on repeated errors to avoid infinite loop
      if (previousStatus === JobStatus.COMPLETE) {
        // Get the final job status to return outputUri
        const finalJob = await getJobStatus(jobId);
        let outputUri = null;
        
        try {
          if (finalJob.Settings && finalJob.Settings.OutputGroups && finalJob.Settings.OutputGroups.length > 0 && 
              finalJob.Settings.Inputs && finalJob.Settings.Inputs.length > 0) {
            const outputGroup = finalJob.Settings.OutputGroups[0];
            const destination = outputGroup.OutputGroupSettings?.FileGroupSettings?.Destination;
            
            const fileName = path.basename(finalJob.Settings.Inputs[0].FileInput);
            const baseName = path.basename(fileName, path.extname(fileName));
            
            let nameModifier = '';
            if (outputGroup.Outputs && outputGroup.Outputs.length > 0 && outputGroup.Outputs[0].NameModifier) {
              nameModifier = outputGroup.Outputs[0].NameModifier;
            }
            
            // Determine output extension from container settings
            let extension = '.mp4'; // Default to MP4
            if (outputGroup.Outputs && outputGroup.Outputs.length > 0) {
              const container = outputGroup.Outputs[0].ContainerSettings?.Container;
              if (container === 'MP4') {
                extension = '.mp4';
              } else if (container === 'MOV') {
                extension = '.mov';
              }
            }
            
            const cleanDestination = destination.endsWith('/') ? destination.slice(0, -1) : destination;
            outputUri = `${cleanDestination}/${baseName}${nameModifier}${extension}`;
          }
        } catch (e) {
          // Silently handle
        }
        
        return { job: finalJob, outputUri };
      }
      
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }
}

