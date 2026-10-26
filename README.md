# QVD Viewer for Qlik Cloud

QVD Viewer for Qlik Cloud is a visualization extension that lets you look inside QVD (QlikView Data) files stored in Qlik Cloud spaces. You pick the files in the extension, the host app reloads them, and the extension shows their records and header metadata.

> Internal tool created by Kiril Kirin, Qlik Professional Services. It is not an official Qlik product.

## Install

1. Open **Releases** on the right side of this page and download the zip from the latest release (for example `qvd-viewer-cloud-v1.4.2.zip`).
2. In the Administration activity center, go to **Extensions** and upload the zip. You need an admin role or the Manage extensions permission. To update, delete the old version first or upload the new zip over it.
3. Create a new, empty app. Open the **Data load editor** and select **Load data**. This loads the default script, so you can create a sheet.
4. Go to **Overview**, create a sheet and add **QVD Viewer** from **Custom objects**.
5. Select **Install load script** in the extension. It adds the viewer's load script as a new script section and saves the app.

## Use it

1. Choose a space and select up to 18 QVD files. You can select files from several spaces.
2. Choose how many rows to load per file.
3. Select **Load**. The app reloads in your session and each file gets its own tab.

## What you can see

- **Records:** browse the loaded rows, 50 per page. Search one field (wildcards `*` and `?` work). Select a column header to sort (ascending, descending, off). Copy the page for Excel, or export the loaded rows to an `.xlsx` file.
- **Profile:** for each field, the type (numeric, text or mixed), non-null and null counts, null %, distinct values, unique %, minimum, maximum and average. Select a field to see its value distribution, most frequent first.
- **Fields:** number format, tags, distinct values, bit layout and comment of each field.
- **Header:** every element of the QVD XML header. Show or copy the raw XML.
- **Lineage:** a tree of where the data comes from and what uses it, up to 5 levels each way, from the Qlik Cloud lineage service. Lineage entries stored in the QVD header are shown when the file has them.
- **Catalog:** the summary cards above the tabs link to the file's dataset page in the Qlik Cloud Catalog. The Lineage tab links to the lineage view there.

## Compared with the dataset page

Each QVD in the Qlik Cloud Catalog has a dataset page. The extension adds:

- **Full QVD header:** the raw XML header and every element in it, including each field's bit layout (offset, width, bias), symbol count, number format and tags.
- **Several files at once:** up to 18 QVDs from one or more spaces, each in its own tab.
- **Your choice of rows:** load a sample or every row. Search any field with wildcards, sort, and export up to 100,000 rows to Excel.
- **Errors per file:** a file that cannot be read is flagged, and the other files still load.
- **Data in an app:** the loaded data is in an ordinary Qlik app, so you can add your own charts next to the viewer.

The dataset page is the better choice when you need:

- Nothing to install and no reload.
- Trust score, data quality and other Catalog metadata.
- An interactive lineage graph. The extension shows lineage as a tree and links to the Catalog graph.

## Limits

- Use a dedicated app. In an app that already has its own load script, installing replaces that script. Earlier versions stay in the app's script history.
- You need edit rights to the host app to install the script and to reload.
- QVDs stored by Qlik Cloud apps have an empty lineage element in their header. Use the platform lineage on the Lineage tab instead.
- The profile, distribution and export use the loaded rows only. To profile a whole file, set rows per file to **All rows**.
- Export to Excel is limited to 100,000 rows and 2,000,000 cells.
- The Catalog link shows only when the file has a dataset page in the Catalog.
- A file path cannot contain an apostrophe or a closing bracket, and must be 256 characters or shorter.

## Files

| File | Purpose |
|---|---|
| `src/` | Extension source (`.qext` and `.js`). The zip on the Releases page contains these two files in a folder named `qvd-viewer-cloud`, which is the name Qlik Cloud expects. |
| `load_script.qvs` | Load script that the extension installs (version 1.2) |

## Versions

See [CHANGELOG.md](CHANGELOG.md).
