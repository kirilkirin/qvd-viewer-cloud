# QVD Viewer for Qlik Cloud

QVD Viewer for Qlik Cloud is a visualization extension that lets you look inside QVD (QlikView Data) files stored in Qlik Cloud spaces. You pick the files in the extension, the host app reloads them, and the extension shows their records and header metadata.

> Internal tool created by Kiril Kirin, Qlik Professional Services. It is not an official Qlik product.

## Install

1. Download `dist/qvd-viewer-cloud-v1.3.0.zip` from this repository.
2. In the Administration activity center, go to **Extensions** and upload the zip. You need an admin role or the Manage extensions permission.
3. Create a new, empty app and add **QVD Viewer** to a sheet from **Custom objects**.
4. Select **Install load script** in the extension. It adds the viewer's load script as a new script section and saves the app.

## Use it

1. Choose a space and select up to 18 QVD files. You can select files from several spaces.
2. Choose how many rows to load per file.
3. Select **Load**. The app reloads in your session and each file gets its own tab.

## What you can see

- **Records:** browse the loaded rows, 50 per page. Search one field (wildcards `*` and `?` work).
- **Fields:** number format, tags, distinct values, bit layout and comment of each field.
- **Header:** every element of the QVD XML header. Show or copy the raw XML.
- **Lineage:** the app that created the file and the apps that use it, from the Qlik Cloud lineage service. Lineage entries stored in the QVD header are shown when the file has them.

## Limits

- Use a dedicated app. In an app that already has its own load script, installing replaces that script. Earlier versions stay in the app's script history.
- You need edit rights to the host app to install the script and to reload.
- QVDs stored by Qlik Cloud apps have an empty lineage element in their header. Use the platform lineage on the Lineage tab instead.
- A file path cannot contain an apostrophe or a closing bracket, and must be 256 characters or shorter.

## Files

| File | Purpose |
|---|---|
| `dist/qvd-viewer-cloud-v1.3.0.zip` | Extension package to upload |
| `qvd-viewer-cloud/` | Extension source (`.qext` and `.js`) |
| `load_script.qvs` | Load script that the extension installs (version 1.2) |

## Versions

See [CHANGELOG.md](CHANGELOG.md).
