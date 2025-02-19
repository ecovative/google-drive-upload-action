const fs = require('fs');
const path = require('path');
const actions = require('@actions/core');
const { google } = require('googleapis');
const { Buffer } = require('buffer');

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

    if (overwrite) {
        fileId = await getFileId(drive, filename, uploadFolderId);
    }

    const fileData = {
        body: fs.createReadStream(target),
    };

    if (fileId === null) {
        actions.info(`Creating file ${filename}.`);

        const fileMetadata = {
            name: filename,
            parents: [uploadFolderId],
        };

        return drive.files.create({
            resource: fileMetadata,
            media: fileData,
            uploadType: 'multipart',
            fields: 'id',
            supportsAllDrives: true,
        });

    } else {
        if(!overwrite) {
            throw new Error(`File ${filename} already exists. Set 'overwrite' to 'true' to update it.`);
        }
        actions.info(`File ${filename} already exists. Updating it.`);
        return drive.files.update({
            fileId,
            media: fileData,
            uploadType: 'multipart',
            fields: 'id',
            supportsAllDrives: true,
        });
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
    const credentials = actions.getInput('credentials', { required: true });
    const parentFolderId = actions.getInput('parent_folder_id', { required: true });
    const targets = actions.getMultilineInput('targets', { required: true });
    const overwrite = actions.getInput('overwrite', { required: false }) === 'true';

    const credentialsJSON = JSON.parse(Buffer.from(credentials, 'base64').toString());
    const scopes = ['https://www.googleapis.com/auth/drive.file'];
    const auth = new google.auth.JWT(credentialsJSON.client_email, null, credentialsJSON.private_key, scopes);
    const drive = google.drive({ version: 'v3', auth });

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        await uploadFile(drive, target, parentFolderId, overwrite);
    }
}

main().catch((error) => actions.setFailed(error));
