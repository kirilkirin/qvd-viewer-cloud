# Changelog

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
