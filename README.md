# google-drive-upload-action
Github action to upload a file to Google Drive using a service account.

## Usage
#### Simple example:
```
steps:
    - uses: actions/checkout@v4

    - name: Upload a file to Google Drive
      uses: ecovative/google-drive-upload-action@v2
      with:
        target:
          - my_file.pdf
          - your_file.png
        credentials: ${{ secrets.<YOUR_SERVICE_ACCOUNT_CREDENTIALS> }}
        parent_folder_id: <YOUR_DRIVE_FOLDER_ID>
```

### Inputs
#### `target` (Required):
List of local paths to the file to upload, can be relative from github runner current directory.

#### `credentials` (Required):
A service account public/private key pair encoded in base64.

[Generate and download your credentials in JSON format](https://cloud.google.com/iam/docs/creating-managing-service-account-keys#creating_service_account_keys)

Run `base64 my_service_account_key.json > encoded.txt` and paste the encoded string into a github secret.

#### `parent_folder_id` (Required):
The id of the drive folder where you want to upload your file. It is the string of characters after the last `/` when browsing to your folder URL. You must share the folder with the service account (using its email address) unless you specify a `owner`.
