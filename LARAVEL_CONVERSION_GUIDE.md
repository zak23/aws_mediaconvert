# Laravel Conversion Guide - Quick Start

This guide provides a quick-start checklist for converting the AWS MediaConvert Node.js application to Laravel.

## Prerequisites

- [ ] PHP 8.1+ installed
- [ ] Composer installed
- [ ] Laravel 10+ installed
- [ ] FFmpeg and FFprobe installed
- [ ] AWS SDK for PHP (via Composer)
- [ ] AWS credentials configured

## Quick Checklist

### 1. Set Up Laravel Project

```bash
# Create new Laravel project
composer create-project laravel/laravel awmediaconvert

# Install AWS SDK
composer require aws/aws-sdk-php

# Navigate to project
cd awmediaconvert
```

### 2. Copy Dependencies

Reference the Node.js `package.json` to install these Composer packages:

```json
{
  "@aws-sdk/client-mediaconvert": "^3.676.0",  → aws/aws-sdk-php
  "@aws-sdk/client-s3": "^3.676.0",            → aws/aws-sdk-php
  "@aws-sdk/lib-storage": "^3.676.0",          → aws/aws-sdk-php
  "dotenv": "^16.4.7",                         → vlucas/phpdotenv (built-in)
  "fluent-ffmpeg": "^2.1.3"                   → Required: FFmpeg binaries
}
```

Install command:
```bash
composer require aws/aws-sdk-php
```

For FFmpeg in PHP, use Symfony Process component (built-in with Laravel):
```bash
# No Composer package needed, just install FFmpeg system-wide
sudo apt install ffmpeg  # Ubuntu/Debian
brew install ffmpeg      # macOS
```

### 3. Create Service Classes

Copy the service classes from `ARCHITECTURE.md` into these files:

```
app/Services/
├── S3Service.php
├── MediaConvertService.php
├── FFprobeService.php
├── WatermarkService.php
└── VideoHelperService.php
```

### 4. Configure Environment

Copy `.env.example` from Node.js project and adjust for Laravel:

```env
# .env (Laravel)

AWS_ACCESS_KEY_ID=your_key_here
AWS_SECRET_ACCESS_KEY=your_secret_here
AWS_REGION=us-east-1

S3_BUCKET=your-bucket-name
S3_INPUT_FOLDER=input
S3_OUTPUT_FOLDER=output

MEDIACONVERT_ENDPOINT=https://mediaconvert.us-east-1.amazonaws.com
MEDIACONVERT_ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/service-role/MediaConvert_Default_Role
MEDIACONVERT_QUEUE_ARN=arn:aws:mediaconvert:us-east-1:ACCOUNT_ID:queues/Default
MEDIACONVERT_POLL_INTERVAL_MS=5000
```

### 5. Create Config File

Create `config/mediaconvert.php`:

```php
<?php

return [
    's3_bucket' => env('S3_BUCKET'),
    'input_folder' => env('S3_INPUT_FOLDER', 'input'),
    'output_folder' => env('S3_OUTPUT_FOLDER', 'output'),
    'endpoint' => env('MEDIACONVERT_ENDPOINT'),
    'role_arn' => env('MEDIACONVERT_ROLE_ARN'),
    'queue_arn' => env('MEDIACONVERT_QUEUE_ARN'),
    'poll_interval_ms' => env('MEDIACONVERT_POLL_INTERVAL_MS', 5000),
];
```

Update `config/services.php`:

```php
'aws' => [
    'key' => env('AWS_ACCESS_KEY_ID'),
    'secret' => env('AWS_SECRET_ACCESS_KEY'),
    'region' => env('AWS_REGION', 'us-east-1'),
],
```

### 6. Create Console Command

Create `app/Console/Commands/ProcessVideoCommand.php`:

Reference the complete implementation in `ARCHITECTURE.md`.

Register the command in `app/Console/Kernel.php`:

```php
protected $commands = [
    Commands\ProcessVideoCommand::class,
];
```

### 7. Run Tests

Test the conversion:

```bash
# Run a test video
php artisan video:process /path/to/test-video.mp4
```

### 8. Optional: Database Integration

If you need to track jobs in database:

1. Create migration:
```bash
php artisan make:migration create_video_jobs_table
```

2. Reference schema in `ARCHITECTURE.md`

3. Create model:
```bash
php artisan make:model VideoJob
```

### 9. Optional: Queue Jobs

For background processing:

1. Configure queue driver in `.env`:
```env
QUEUE_CONNECTION=redis  # or 'database'
```

2. Create job:
```bash
php artisan make:job ProcessVideoJob
```

3. Dispatch job:
```php
ProcessVideoJob::dispatch($videoPath);
```

## Key Differences: Node.js vs Laravel

| Node.js | Laravel PHP |
|---------|-------------|
| `import/export` | `use` statements |
| `async/await` | Promises/async |
| `.env` with `dotenv` | `.env` with built-in loader |
| ES modules | PSR-4 autoloading |
| `fs` module | `Storage` facade |
| `path` module | `Path` helper |
| `process.argv[2]` | `$this->argument('path')` |
| AWS SDK v3 | AWS SDK v3 for PHP |
| FFmpeg via `fluent-ffmpeg` | FFmpeg via Symfony Process |

## Testing

### Unit Tests

Create tests in `tests/Unit/`:

```php
public function test_watermark_size_calculation()
{
    $service = new WatermarkService();
    $size = $service->calculateSize(1920, 1080);
    
    $this->assertEquals(108, $size); // 10% of 1080
}
```

### Feature Tests

Create tests in `tests/Feature/`:

```php
public function test_video_processing_workflow()
{
    $this->artisan('video:process', ['path' => 'tests/fixtures/test-video.mp4'])
         ->expectsOutput('MediaConvert job created')
         ->assertExitCode(0);
}
```

## Deployment

### Production Checklist

- [ ] Set up queue workers
- [ ] Configure Redis for queue backend
- [ ] Set up job retry logic
- [ ] Add logging for all operations
- [ ] Configure upload file size limits
- [ ] Set up monitoring/alerting
- [ ] Test with production AWS account
- [ ] Set up S3 lifecycle policies

### Docker Deployment

Create `Dockerfile`:

```dockerfile
FROM php:8.1-fpm

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Install Composer dependencies
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader

# Copy application code
COPY . .

# Set permissions
RUN chown -R www-data:www-data storage bootstrap/cache

CMD ["php", "artisan", "serve"]
```

## Troubleshooting

### Common Issues

**FFmpeg not found**
```bash
# Check if FFmpeg is installed
ffmpeg -version

# Install if missing
sudo apt install ffmpeg
```

**AWS Credentials Error**
```bash
# Verify credentials in .env
php artisan tinker
>>> config('services.aws.key')  # Should return your key
```

**MediaConvert Job Fails**
- Check IAM role has correct permissions
- Verify S3 bucket access
- Check MediaConvert endpoint matches region

## Next Steps

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) for complete technical details
2. Review service implementations
3. Add database tracking (optional)
4. Implement queue processing (optional)
5. Add API endpoints (optional)
6. Set up monitoring
7. Deploy to production

## Resources

- [Laravel Documentation](https://laravel.com/docs)
- [AWS SDK for PHP](https://docs.aws.amazon.com/sdk-for-php/)
- [AWS MediaConvert Guide](https://docs.aws.amazon.com/mediaconvert/)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)

