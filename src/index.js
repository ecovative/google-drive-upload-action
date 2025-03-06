const fs = require('fs');
const path = require('path');
const actions = require('@actions/core');
const { google } = require('googleapis');
const { Buffer } = require('buffer');
const mime = require('mime-types');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Maximum number of retries for failed uploads
const MAX_RETRIES = 3;
// Delay between retries (in milliseconds)
const RETRY_DELAY = 1000;
// Maximum concurrent uploads
const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Validates that all required files exist and are accessible
 * @param {string[]} targets - Array of file paths to validate
 * @throws {Error} If any file is invalid or inaccessible
 */
function validateFiles(targets) {
    for (const target of targets) {
        if (!fs.existsSync(target)) {
            throw new Error(`File not found: ${target}`);
        }
        try {
            fs.accessSync(target, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`File not readable: ${target}`);
        }
    }
}

/**
 * Implements exponential backoff for retrying failed operations
 * @param {Function} operation - The async operation to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise<any>} Result of the operation
 */
async function withRetry(operation, maxRetries = MAX_RETRIES, initialDelay = RETRY_DELAY) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries - 1) {
                const delay = initialDelay * Math.pow(2, attempt);
                actions.warning(`Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error.message}`);
                await sleep(delay);
            }
        }
    }
    throw lastError;
}

/**
 * Creates a progress bar for file upload
 * @param {string} filename - Name of the file being uploaded
 * @param {number} fileSize - Size of the file in bytes
 * @returns {Object} Progress bar methods
 */
function createProgressBar(filename, fileSize) {
    let lastProgress = 0;
    const totalSteps = 20;
    
    return {
        update: (bytesUploaded) => {
            const progress = Math.floor((bytesUploaded / fileSize) * 100);
            if (progress > lastProgress + 4) {  // Update every 5% progress
                const bars = '='.repeat(Math.floor(progress / 5)) + '-'.repeat(totalSteps - Math.floor(progress / 5));
                actions.info(`Uploading ${filename}: [${bars}] ${progress}%`);
                lastProgress = progress;
            }
        },
        complete: () => {
            actions.info(`Upload complete for ${filename}`);
        }
    };
}

/**
 * Retrieves the file ID of a specified file in a Google Drive folder.
 *
 * @param {object} drive - The Google Drive API client instance.
 * @param {string} targetFilename - The name of the target file to search for.
 * @param {string} folderId - The ID of the folder to search within.
 * @returns {Promise<string|null>} - A promise that resolves to the file ID if found, or null if not found.
 * @throws {Error} - Throws an error if more than one file matches the target filename.
 */
async function getFileId(drive, targetFilename, folderId) {
    const { data: { files } } = await drive.files.list({
        q: `name='${targetFilename}' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
    });

    if (files.length > 1) {
        throw new Error('More than one entry match the file name');
    }
    if (files.length === 1) {
        return files[0].id;
    }

    return null;
}

/**
 * Uploads or updates a file to Google Drive.
 *
 * @param {object} drive - The Google Drive API client.
 * @param {string} target - The path to the file to be uploaded.
 * @param {string} uploadFolderId - The ID of the folder in Google Drive where the file will be uploaded.
 * @param {boolean} overwrite - Whether to overwrite the file if it already exists.
 * @returns {Promise<object>} - A promise that resolves to the response from the Google Drive API.
 * @throws {Error} - Throws an error if the file already exists and overwrite is set to false.
 */
async function uploadFile(drive, target, uploadFolderId, overwrite) {
    let fileId = null;
    const filename = path.basename(target);
    const fileStats = fs.statSync(target);
    const mimeType = mime.lookup(target) || 'application/octet-stream';
    const progressBar = createProgressBar(filename, fileStats.size);

    if (overwrite) {
        fileId = await withRetry(() => getFileId(drive, filename, uploadFolderId));
    }

    const fileStream = fs.createReadStream(target);
    let bytesUploaded = 0;

    fileStream.on('data', chunk => {
        bytesUploaded += chunk.length;
        progressBar.update(bytesUploaded);
    });

    const fileData = {
        body: fileStream,
        mimeType: mimeType,
    };

    if (fileId === null) {
        actions.info(`Creating file ${filename} (${mimeType}).`);

        const fileMetadata = {
            name: filename,
            parents: [uploadFolderId],
            mimeType: mimeType,
        };

        const result = await withRetry(() => 
            drive.files.create({
                resource: fileMetadata,
                media: fileData,
                uploadType: 'multipart',
                fields: 'id',
                supportsAllDrives: true,
            })
        );

        progressBar.complete();
        return result;

    } else {
        if(!overwrite) {
            throw new Error(`File ${filename} already exists. Set 'overwrite' to 'true' to update it.`);
        }
        actions.info(`File ${filename} already exists. Updating it.`);
        
        const result = await withRetry(() =>
            drive.files.update({
                fileId,
                media: fileData,
                uploadType: 'multipart',
                fields: 'id',
                supportsAllDrives: true,
            })
        );

        progressBar.complete();
        return result;
    }
}

/**
 * Processes uploads in concurrent batches
 * @param {object} drive - Google Drive API client
 * @param {string[]} targets - Array of file paths to upload
 * @param {string} parentFolderId - Target folder ID
 * @param {boolean} overwrite - Whether to overwrite existing files
 */
async function processBatchUploads(drive, targets, parentFolderId, overwrite) {
    for (let i = 0; i < targets.length; i += MAX_CONCURRENT_UPLOADS) {
        const batch = targets.slice(i, i + MAX_CONCURRENT_UPLOADS);
        const uploadPromises = batch.map(target => 
            uploadFile(drive, target, parentFolderId, overwrite)
                .catch(error => {
                    actions.error(`Failed to upload ${target}: ${error.message}`);
                    throw error;
                })
        );
        await Promise.all(uploadPromises);
    }
}

/**
 * Main function to upload files to Google Drive.
 * 
 * This function retrieves the necessary inputs, authenticates with Google Drive API,
 * and uploads the specified files to the target folder.
 * 
 * @async
 * @function main
 * @returns {Promise<void>} A promise that resolves when the upload process is complete.
 * @throws Will throw an error if any of the required inputs are missing or invalid.
 */
async function main() {
    try {
        // Get and validate inputs
        const credentials = actions.getInput('credentials', { required: true });
        const parentFolderId = actions.getInput('parent_folder_id', { required: true });
        const targets = actions.getMultilineInput('targets', { required: true });
        const overwrite = actions.getInput('overwrite', { required: false }) === 'true';
        
        // Validate credentials format
        let credentialsJSON;
        try {
            credentialsJSON = JSON.parse(Buffer.from(credentials, 'base64').toString());
            if (!credentialsJSON.client_email || !credentialsJSON.private_key) {
                throw new Error('Invalid credentials format');
            }
        } catch (error) {
            throw new Error(`Invalid credentials: ${error.message}`);
        }

        // Validate files before starting any uploads
        validateFiles(targets);

        // Initialize Google Drive client
        const scopes = ['https://www.googleapis.com/auth/drive.file'];
        const auth = new google.auth.JWT(
            credentialsJSON.client_email,
            null,
            credentialsJSON.private_key,
            scopes
        );
        const drive = google.drive({ version: 'v3', auth });

        // Verify folder exists and is accessible
        try {
            await drive.files.get({
                fileId: parentFolderId,
                fields: 'id,name',
                supportsAllDrives: true
            });
        } catch (error) {
            throw new Error(`Cannot access target folder: ${error.message}`);
        }

        actions.info(`Starting upload of ${targets.length} file(s) to Google Drive`);
        await processBatchUploads(drive, targets, parentFolderId, overwrite);
        actions.info('All uploads completed successfully');

    } catch (error) {
        actions.setFailed(error.message);
    }
}

main();
