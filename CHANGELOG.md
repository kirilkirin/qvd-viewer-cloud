# Changelog

## v1.4.1 — October 2026

### Fixes
- The Catalog link now opens the file's dataset page. Before, it always showed "Not found in the Catalog", because dataset items in the items API have no open link.
- The Catalog link matches the file by its path in the space, so files with the same name in different folders get the right page.

### Changes
- Colored summary tiles: Records, Fields, Rows loaded and Table name have solid Qlik colors. The other tiles have a light green background.

## v1.4.0 — October 2026

### Features
- Profile tab: type, non-null and null counts, null %, distinct values, unique %, minimum, maximum and average for each field.
- Value distribution: select a field on the Profile tab to see its values and row counts, most frequent first, 100 values per page.
- Records tab: sort by any column, copy the current page for Excel, and export the loaded rows to an `.xlsx` file.
- Lineage tab: upstream and downstream lineage as a tree, up to 5 levels each way.
- Links to the file's dataset page and lineage view in the Qlik Cloud Catalog.

### Changes
- The load script is unchanged (version 1.2). Apps that already have it do not need an update.

## v1.3.0 — October 2026

First shared version.

### Features
- Lists the spaces you can access and the QVD files in each space.
- Loads up to 18 QVD files at once, from one or more spaces, with a choice of rows per file.
- Records tab with paging and field search.
- Fields tab with number formats, tags, distinct values, bit layout and comments.
- Header tab with every XML header element and the raw XML.
- Lineage tab with platform lineage (created by, used by) and any lineage entries in the QVD header.
- Installs or updates its own load script in the host app.

### Reliability
- Reloads in the open session, so the new data shows at once. Falls back to the Qlik Cloud reload service if a session reload is not allowed.
- Uses a unique selection state per object, so redrawing the object does not cause an engine error.
- A file that cannot be read is marked with an error. The other files still load.
