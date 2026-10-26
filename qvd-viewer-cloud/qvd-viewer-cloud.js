/*
 * QVD Viewer for Qlik Cloud - nebula.js visualization extension (version 1.3.0)
 *
 * How it works
 * 1. Lists the spaces you can access and the QVD files in each space
 *    (REST: /api/v1/spaces, /api/v1/data-files/connections, /api/v1/data-files).
 * 2. Reloads the host app with the selected files as variables: first in the open
 *    engine session (app variables + DoReloadEx + DoSave), and if that is not
 *    allowed, through the reload service (REST: POST /api/v1/reloads).
 *    The host app's load script reads each QVD, its XML header and its field headers.
 * 3. Reads the loaded tables from the engine (session hypercubes in a session
 *    alternate state) and shows them as a dashboard. Parses the raw XML header
 *    (table QvdHeaderXml) in the browser to show every header element.
 * 4. Reads platform lineage for each file from the Qlik Cloud lineage service
 *    (REST: /api/v1/lineage-graphs/nodes/{qri} and /impact/{qri}/overview).
 *
 * The extension carries the load script (version 1.2) and can install it in any app
 * it is added to (Engine API: GetScript, SetScript, DoSave).
 */
define(['@nebula.js/stardust'], function (stardust) {
  'use strict';

  var useElement = stardust.useElement;
  var useApp = stardust.useApp;
  var useEffect = stardust.useEffect;

  var VERSION = '1.3.0';
  var MAX_FILES = 18;          // 20 reload variables minus vQvdCount and vQvdRowLimit
  var MAX_VAR_LENGTH = 256;    // maximum length of a reload variable value
  var PAGE_ROWS = 50;          // records per page
  var MAX_CELLS = 10000;       // engine limit for one hypercube data page
  var STATE = 'QvdViewerState';
  var END_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXCEEDED_LIMIT'];
  var ROW_LIMITS = [
    { value: 100, label: '100 rows' },
    { value: 1000, label: '1,000 rows' },
    { value: 10000, label: '10,000 rows' },
    { value: 100000, label: '100,000 rows' },
    { value: 0, label: 'All rows' }
  ];

  var FILE_FIELDS = ['QvdKey', 'File Path', 'File Name', 'Space', 'Table Name', 'Record Count', 'Field Count', 'Create Time'];
  var HEADER_FIELDS = ['QvdKey', 'Qlik Build Number', 'Creator App', 'Create Time UTC', 'Source File Size',
    'Header Table Name', 'Record Byte Size', 'Header Record Count', 'Table Comment'];
  var STATUS_FIELDS = ['QvdKey', 'Load Status', 'Load Error'];
  var FIELD_FIELDS = ['QvdKey', 'Field Position', 'Field Name', 'Distinct Values', 'Bit Offset', 'Bit Width', 'Bias',
    'Symbol Offset', 'Symbol Length', 'Field Comment', 'Number Format Type', 'Number Format Pattern',
    'Number Format Decimals', 'Decimal Separator', 'Thousands Separator'];
  var LINEAGE_FIELDS = ['QvdKey', 'Lineage Position', 'Lineage Source', 'Lineage Statement'];
  var RUN_FIELDS = ['Run Time', 'Run File Count', 'Run Row Limit'];
  var XML_FIELDS = ['QvdKey', 'Header Line No', 'Header Line'];
  var XML_LABELS = {
    QvBuildNo: 'Qlik build number', CreatorDoc: 'Creator app', CreateUtcTime: 'Created (UTC)',
    SourceCreateUtcTime: 'Source created (UTC)', SourceFileUtcTime: 'Source file time (UTC)', SourceFileSize: 'Source file size',
    StaleUtcTime: 'Stale after (UTC)', TableName: 'Table name', Compression: 'Compression', RecordByteSize: 'Record byte size',
    NoOfRecords: 'Number of records', Offset: 'Data offset', Length: 'Data length', Comment: 'Table comment',
    EncryptionInfo: 'Encryption info', TableTags: 'Table tags', ProfilingData: 'Profiling data'
  };


  // ---------------------------------------------------------------- embedded load script
  // Written to the host app by "Install load script". Keep in sync with load_script.qvs.
  var SCRIPT_VERSION = '1.2';
  var SCRIPT_TAB = '///$tab QVD Viewer';
  var SCRIPT_MARKER = /QVD Viewer for Qlik Cloud - load script \(version ([0-9.]+)\)/;
  var LOAD_SCRIPT = SCRIPT_TAB + '\n' + String.raw`// =====================================================================
// QVD Viewer for Qlik Cloud - load script (version 1.2)
// The QVD Viewer extension sets these variables, as app variables before a reload in
// the open session, or as reload variables through POST /api/v1/reloads:
//   vQvdCount       number of QVD files selected (1 to 18)
//   vQvdRowLimit    rows to load per QVD (0 = all rows)
//   vQvdFile1..18   full library path of each QVD, for example
//                   lib://DataFiles/folder/file.qvd           (personal space)
//                   lib://Space name:DataFiles/folder/file.qvd (shared or managed space)
// If vQvdCount is missing, it defaults to 0 and only the QvdRun table loads.
// The script only reads these variables and never assigns them, so the extension can update them.
// =====================================================================

SET ErrorMode = 0;   // Continue when one file fails. Each failure is recorded in QvdStatus.

LET _vqCount = If(Len('$(vQvdCount)') = 0, 0, Num#('$(vQvdCount)'));
LET _vqLimit = If(Len('$(vQvdRowLimit)') = 0, 1000, Num#('$(vQvdRowLimit)'));
LET vQvdFirstN = If($(_vqLimit) > 0, $(_vqLimit), 2000000000);

QvdRun:
LOAD
    Timestamp(Now(1))  AS [Run Time],
    $(_vqCount)        AS [Run File Count],
    $(_vqLimit)        AS [Run Row Limit]
AUTOGENERATE 1;

FOR i = 1 TO $(_vqCount)

    LET vPath      = '$(vQvdFile$(i))';
    LET vErrBefore = ScriptErrorCount;

    // ---- File summary (Qvd* file functions) ----
    QvdFiles:
    LOAD
        $(i)                                        AS QvdKey,
        '$(vPath)'                                  AS [File Path],
        SubField('$(vPath)', '/', -1)               AS [File Name],
        If(Index('$(vPath)', ':DataFiles') > 0,
           TextBetween('$(vPath)', 'lib://', ':DataFiles'),
           'Personal')                              AS [Space],
        QvdTableName('$(vPath)')                    AS [Table Name],
        QvdNoOfRecords('$(vPath)')                  AS [Record Count],
        QvdNoOfFields('$(vPath)')                   AS [Field Count],
        QvdCreateTime('$(vPath)')                   AS [Create Time]
    AUTOGENERATE 1;

    // ---- Table header (XML header of the QVD) ----
    QvdHeader:
    LOAD
        $(i)              AS QvdKey,
        QvBuildNo         AS [Qlik Build Number],
        CreatorDoc        AS [Creator App],
        CreateUtcTime     AS [Create Time UTC],
        SourceFileSize    AS [Source File Size],
        TableName         AS [Header Table Name],
        RecordByteSize    AS [Record Byte Size],
        NoOfRecords       AS [Header Record Count],
        Comment           AS [Table Comment]
    FROM [$(vPath)] (XmlSimple, table is [QvdTableHeader]);

    // ---- Lineage ----
    QvdLineage:
    LOAD
        $(i)              AS QvdKey,
        RecNo()           AS [Lineage Position],
        Discriminator     AS [Lineage Source],
        Statement         AS [Lineage Statement]
    FROM [$(vPath)] (XmlSimple, table is [QvdTableHeader/Lineage/LineageInfo]);

    // ---- Field headers ----
    QvdFields:
    LOAD
        $(i)                    AS QvdKey,
        RecNo()                 AS [Field Position],
        FieldName               AS [Field Name],
        NoOfSymbols             AS [Distinct Values],
        BitOffset               AS [Bit Offset],
        BitWidth                AS [Bit Width],
        Bias                    AS [Bias],
        Offset                  AS [Symbol Offset],
        Length                  AS [Symbol Length],
        Comment                 AS [Field Comment],
        [NumberFormat/Type]     AS [Number Format Type],
        [NumberFormat/Fmt]      AS [Number Format Pattern],
        [NumberFormat/nDec]     AS [Number Format Decimals],
        [NumberFormat/Dec]      AS [Decimal Separator],
        [NumberFormat/Thou]     AS [Thousands Separator]
    FROM [$(vPath)] (XmlSimple, table is [QvdTableHeader/Fields/QvdFieldHeader]);

    // ---- Records: one table per QVD, fields prefixed with Q<n>. ----
    // __Row keeps duplicate records apart and keeps the load order.
    QUALIFY *;
    [Q$(i)]:
    FIRST $(vQvdFirstN) LOAD RecNo() AS __Row, * FROM [$(vPath)] (qvd);
    UNQUALIFY *;

    // ---- Raw XML header, one row per line, up to </QvdTableHeader> ----
    // The extension parses it to show every header element, including field tags.
    LET vHdrLines = Alt(QvdNoOfFields('$(vPath)'), 0) * 40 + 500;
    _HdrTmp:
    FIRST $(vHdrLines) LOAD RecNo() AS _LineNo, @1 AS _Line
    FROM [$(vPath)] (txt, utf8, no labels, delimiter is '\x01', no quotes);
    _HdrEnd:
    LOAD Min(_LineNo) AS _EndNo RESIDENT _HdrTmp WHERE Index(_Line, '</QvdTableHeader>') > 0;
    LET vHdrEnd = Alt(Peek('_EndNo', 0, '_HdrEnd'), 0);
    QvdHeaderXml:
    LOAD $(i) AS QvdKey, _LineNo AS [Header Line No], _Line AS [Header Line]
    RESIDENT _HdrTmp WHERE _LineNo <= $(vHdrEnd);
    DROP TABLES _HdrTmp, _HdrEnd;

    // ---- Load status ----
    LET vErrAfter = ScriptErrorCount;

    QvdStatus:
    LOAD
        $(i)                                                    AS QvdKey,
        If($(vErrAfter) > $(vErrBefore), 'Error', 'OK')         AS [Load Status],
        If($(vErrAfter) = $(vErrBefore), Null(),
           If(IsNull(QvdNoOfRecords('$(vPath)')),
              'File not found or not accessible',
              'Load error. See the reload log.'))               AS [Load Error]
    AUTOGENERATE 1;

NEXT i

SET ErrorMode = 1;

LET vPath = Null(); LET vErrBefore = Null(); LET vErrAfter = Null();
LET vQvdFirstN = Null(); LET vHdrLines = Null(); LET vHdrEnd = Null(); LET i = Null();
LET _vqCount = Null(); LET _vqLimit = Null();
`;

  // Classifies the app's current load script.
  function scriptStatus(current) {
    var m = SCRIPT_MARKER.exec(current || '');
    if (m) { return { status: m[1] === SCRIPT_VERSION ? 'ok' : 'outdated', version: m[1] }; }
    var meaningful = String(current || '').split(/\r?\n/).filter(function (line) {
      var t = line.trim();
      return t && !/^\/\//.test(t) && !/^(SET|LET)\s/i.test(t);
    });
    return { status: meaningful.length ? 'foreign' : 'missing', version: null };
  }

  // Builds the script to write: keeps default SET statements of a new app, replaces an older
  // QVD Viewer script, or replaces a foreign script entirely.
  function buildScript(current, status) {
    var cur = String(current || '');
    if (status === 'missing') { return (cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' : '') + LOAD_SCRIPT; }
    if (status === 'outdated') {
      var tabIdx = cur.indexOf(SCRIPT_TAB);
      var markIdx = cur.search(SCRIPT_MARKER);
      var start = tabIdx >= 0 ? tabIdx : cur.lastIndexOf('// =====', markIdx);
      if (start < 0) { start = 0; }
      return cur.slice(0, start) + LOAD_SCRIPT;
    }
    return LOAD_SCRIPT;
  }

  // Parses the raw QVD XML header into table elements, field headers and header lineage.
  function parseHeaderXml(raw) {
    if (!raw || !window.DOMParser) { return null; }
    var doc = new DOMParser().parseFromString(raw, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) { return null; }
    var root = doc.documentElement;
    if (!root || root.nodeName !== 'QvdTableHeader') { return null; }
    function childElements(el) {
      var out = [];
      for (var n = el.firstElementChild; n; n = n.nextElementSibling) { out.push(n); }
      return out;
    }
    function textOf(el) {
      var kids = childElements(el);
      if (!kids.length) { return el.textContent; }
      return kids.map(function (k) { return k.nodeName + ': ' + textOf(k); }).join('; ');
    }
    var result = { raw: raw, table: [], fields: [], lineage: [] };
    childElements(root).forEach(function (el) {
      if (el.nodeName === 'Fields') {
        childElements(el).forEach(function (fh) {
          var field = { tags: [], numberFormat: {} };
          childElements(fh).forEach(function (c) {
            if (c.nodeName === 'Tags') {
              field.tags = childElements(c).map(function (s) { return s.textContent; });
            } else if (c.nodeName === 'NumberFormat') {
              childElements(c).forEach(function (nf) { field.numberFormat[nf.nodeName] = nf.textContent; });
            } else {
              field[c.nodeName] = c.textContent;
            }
          });
          result.fields.push(field);
        });
      } else if (el.nodeName === 'Lineage') {
        childElements(el).forEach(function (li) {
          var d = li.getElementsByTagName('Discriminator')[0];
          var s = li.getElementsByTagName('Statement')[0];
          result.lineage.push({ source: d ? d.textContent : '', statement: s ? s.textContent : '' });
        });
      } else {
        result.table.push({ name: el.nodeName, value: textOf(el) });
      }
    });
    return result;
  }

  var CSS = [
    '.qvdv{--g:#009845;--g-dark:#007a37;--g-soft:#e6f5ec;--ink:#1f2328;--ink2:#595959;--ink3:#8a8f98;--line:#e3e5e8;--bg:#ffffff;--bg2:#f6f7f8;--red:#d6262b;--red-soft:#fdecec;',
    'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font-family:inherit;font-size:13px;line-height:1.4;overflow:hidden;box-sizing:border-box}',
    '.qvdv *,.qvdv *::before,.qvdv *::after{box-sizing:border-box}',
    '.qvdv-head{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line);flex:0 0 auto}',
    '.qvdv-logo{width:22px;height:22px;border-radius:5px;background:var(--g);color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center;letter-spacing:.3px}',
    '.qvdv-title{font-weight:600;font-size:15px}',
    '.qvdv-ver{color:var(--ink3);font-size:11px}',
    '.qvdv-status{margin-left:auto;font-size:12px;color:var(--ink2);display:flex;align-items:center;gap:8px;min-width:0}',
    '.qvdv-status span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.qvdv-spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--g);border-radius:50%;animation:qvdv-spin .8s linear infinite;flex:0 0 auto}',
    '@keyframes qvdv-spin{to{transform:rotate(360deg)}}',
    '.qvdv-body{flex:1 1 auto;display:flex;min-height:0}',
    '.qvdv-pick{width:320px;flex:0 0 320px;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;background:var(--bg2)}',
    '.qvdv-pick-sec{padding:10px 12px;border-bottom:1px solid var(--line)}',
    '.qvdv-label{display:block;font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}',
    '.qvdv select,.qvdv input[type=text]{width:100%;height:30px;border:1px solid #c9ccd1;border-radius:4px;padding:0 8px;font:inherit;color:var(--ink);background:#fff}',
    '.qvdv select:focus,.qvdv input[type=text]:focus{outline:2px solid var(--g);outline-offset:-1px;border-color:var(--g)}',
    '.qvdv-row{display:flex;gap:6px;align-items:center}',
    '.qvdv-files{flex:1 1 auto;overflow:auto;min-height:80px}',
    '.qvdv-file{display:flex;gap:8px;align-items:flex-start;padding:7px 12px;border-bottom:1px solid var(--line);cursor:pointer;background:#fff}',
    '.qvdv-file:hover{background:var(--g-soft)}',
    '.qvdv-file.is-disabled{opacity:.5;cursor:not-allowed}',
    '.qvdv-file input{margin-top:2px;accent-color:var(--g)}',
    '.qvdv-file-name{font-weight:600;word-break:break-all}',
    '.qvdv-file-meta{color:var(--ink3);font-size:11px;word-break:break-all}',
    '.qvdv-empty{padding:16px 12px;color:var(--ink3)}',
    '.qvdv-chips{display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow:auto}',
    '.qvdv-chip{display:inline-flex;align-items:center;gap:4px;background:var(--g-soft);color:var(--g-dark);border-radius:12px;padding:2px 4px 2px 8px;font-size:11px;max-width:100%}',
    '.qvdv-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.qvdv-chip button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0 3px}',
    '.qvdv-btn{height:30px;border-radius:4px;border:1px solid #c9ccd1;background:#fff;color:var(--ink);font:inherit;font-weight:600;padding:0 12px;cursor:pointer;white-space:nowrap}',
    '.qvdv-btn:hover{border-color:var(--ink3)}',
    '.qvdv-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.qvdv-btn-primary{background:var(--g);border-color:var(--g);color:#fff}',
    '.qvdv-btn-primary:hover{background:var(--g-dark);border-color:var(--g-dark)}',
    '.qvdv-link{border:0;background:none;color:var(--g-dark);cursor:pointer;font:inherit;font-size:11px;padding:0;text-decoration:underline}',
    '.qvdv-hint{font-size:11px;color:var(--ink3);margin-top:6px}',
    '.qvdv-main{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0}',
    '.qvdv-runbar{padding:8px 14px;font-size:12px;color:var(--ink2);border-bottom:1px solid var(--line);flex:0 0 auto}',
    '.qvdv-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--line);overflow-x:auto;flex:0 0 auto}',
    '.qvdv-tab{border:0;background:none;font:inherit;padding:7px 12px;cursor:pointer;color:var(--ink2);border-bottom:2px solid transparent;white-space:nowrap;display:flex;align-items:center;gap:6px}',
    '.qvdv-tab:hover{color:var(--ink)}',
    '.qvdv-tab.is-active{color:var(--ink);font-weight:600;border-bottom-color:var(--g)}',
    '.qvdv-dot{width:8px;height:8px;border-radius:50%;background:var(--g);flex:0 0 auto}',
    '.qvdv-dot.is-error{background:var(--red)}',
    '.qvdv-panel{flex:1 1 auto;overflow:auto;padding:12px 14px;min-height:0}',
    '.qvdv-alert{background:var(--red-soft);color:#8c1519;border:1px solid #f3c2c3;border-radius:4px;padding:8px 10px;margin-bottom:12px}',
    '.qvdv-alert.is-info{background:var(--g-soft);color:var(--g-dark);border-color:#bfe5cd}',
    '.qvdv-alert pre{white-space:pre-wrap;font-size:11px;margin:6px 0 0;max-height:160px;overflow:auto}',
    '.qvdv-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:12px}',
    '.qvdv-card{border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-width:0}',
    '.qvdv-card-k{font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.3px}',
    '.qvdv-card-v{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.qvdv-card-v.is-small{font-size:12px;font-weight:500;white-space:normal;word-break:break-all}',
    '.qvdv-card-v a{color:var(--g-dark)}',
    '.qvdv-sub{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}',
    '.qvdv-subtab{border:1px solid var(--line);background:#fff;border-radius:14px;padding:3px 12px;font:inherit;cursor:pointer;color:var(--ink2)}',
    '.qvdv-subtab.is-active{background:var(--ink);border-color:var(--ink);color:#fff}',
    '.qvdv-tools{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}',
    '.qvdv-tools select{width:auto;max-width:220px}',
    '.qvdv-tools input[type=text]{width:200px}',
    '.qvdv-tablewrap{overflow:auto;border:1px solid var(--line);border-radius:6px;max-width:100%}',
    '.qvdv-table{border-collapse:collapse;width:max-content;min-width:100%;font-size:12px}',
    '.qvdv-table th{position:sticky;top:0;background:var(--bg2);text-align:left;font-weight:600;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap;z-index:1}',
    '.qvdv-table td{padding:5px 10px;border-bottom:1px solid #f0f1f3;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;vertical-align:top}',
    '.qvdv-table td.is-num{text-align:right;font-variant-numeric:tabular-nums}',
    '.qvdv-table td.is-null{color:var(--ink3)}',
    '.qvdv-table td.is-wrap{white-space:pre-wrap;word-break:break-word}',
    '.qvdv-table tr:hover td{background:#fafbfb}',
    '.qvdv-table .qvdv-rowno{color:var(--ink3);text-align:right}',
    '.qvdv-pager{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--ink2)}',
    '.qvdv-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:12px}',
    '.qvdv-kv dt{color:var(--ink3)}',
    '.qvdv-kv dd{margin:0;word-break:break-all}',
    '.qvdv-welcome{margin:auto;max-width:420px;text-align:center;color:var(--ink2);padding:24px}',
    '.qvdv-welcome h3{color:var(--ink);font-size:15px;margin:0 0 6px}',
    '.qvdv-h4{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--ink2);margin:16px 0 8px}',
    '.qvdv-h4:first-child{margin-top:0}',
    '.qvdv-sublabel{font-weight:600;margin:4px 0 6px}',
    '.qvdv-tag{display:inline-block;background:var(--bg2);border:1px solid var(--line);border-radius:3px;padding:0 5px;font-size:11px;color:var(--ink2);margin:1px 0}',
    '.qvdv-xml{background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:10px;font-size:11px;max-height:420px;overflow:auto;white-space:pre;margin:0}',
    '.qvdv-nodes{list-style:none;margin:0 0 12px;padding:0}',
    '.qvdv-nodes li{border:1px solid var(--line);border-radius:6px;padding:7px 10px;margin-bottom:6px}',
    '.qvdv-nodes a{color:var(--g-dark);font-weight:600}',
    '.qvdv-node-type{display:inline-block;background:var(--g-soft);color:var(--g-dark);border-radius:3px;padding:0 6px;font-size:11px;margin-right:8px;text-transform:uppercase}',
    '.qvdv-node-rel{color:var(--ink3);font-size:11px;margin-left:6px}',
    '.qvdv.is-narrow .qvdv-body{flex-direction:column;overflow:auto}',
    '.qvdv.is-narrow .qvdv-pick{width:auto;flex:0 0 auto;border-right:0;border-bottom:1px solid var(--line)}',
    '.qvdv.is-narrow .qvdv-files{flex:0 0 auto;max-height:180px}',
    '.qvdv.is-narrow .qvdv-main{flex:0 0 auto;min-height:420px}',
    '.qvdv.is-narrow .qvdv-panel{overflow:visible}'
  ].join('\n');

  // ---------------------------------------------------------------- helpers

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtInt(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) { return ''; }
    return Number(n).toLocaleString();
  }

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n) || n < 0) { return ''; }
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
  }

  function fmtDate(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function text(cell) { return cell ? cell.t : ''; }
  function num(cell) { return cell && cell.n !== null ? cell.n : null; }

  function injectCss() {
    if (document.getElementById('qvdv-style')) { return; }
    var style = document.createElement('style');
    style.id = 'qvdv-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- REST

  var csrfToken = null;

  function getCsrfToken() {
    if (csrfToken !== null) { return Promise.resolve(csrfToken); }
    return fetch('/api/v1/csrf-token', { credentials: 'include' })
      .then(function (res) { csrfToken = res.headers.get('qlik-csrf-token') || ''; return csrfToken; })
      .catch(function () { csrfToken = ''; return csrfToken; });
  }

  function api(url, options) {
    var opts = options || {};
    var method = opts.method || 'GET';
    var headers = { Accept: 'application/json' };
    var ready = Promise.resolve();
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      ready = getCsrfToken().then(function (token) { if (token) { headers['qlik-csrf-token'] = token; } });
    }
    return ready.then(function () {
      return fetch(url, {
        method: method,
        credentials: 'include',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    }).then(function (res) {
      if (res.ok) { return res.status === 204 ? null : res.json(); }
      return res.text().then(function (body) {
        var detail = '';
        try {
          var json = JSON.parse(body);
          var first = json.errors && json.errors[0];
          detail = first ? (first.detail || first.title || first.code || '') : '';
        } catch (e) { detail = ''; }
        var error = new Error(res.status + ' ' + (res.statusText || 'Error') + (detail ? ': ' + detail : ''));
        error.status = res.status;
        throw error;
      });
    });
  }

  // Follows links.next.href until there are no more pages or max items.
  function apiAll(url, max) {
    var items = [];
    function next(pageUrl) {
      return api(pageUrl).then(function (json) {
        var data = Array.isArray(json) ? json : (json && json.data) || [];
        items = items.concat(data);
        var href = !Array.isArray(json) && json && json.links && json.links.next && json.links.next.href;
        if (href && href !== pageUrl && items.length < max && data.length) { return next(href); }
        return items;
      });
    }
    return next(url);
  }

  // ---------------------------------------------------------------- engine

  function cubeProps(fields, state) {
    return {
      qInfo: { qType: 'qvdviewer-cube' },
      qHyperCubeDef: {
        qStateName: state,
        qDimensions: fields.map(function (f) {
          return {
            qDef: { qFieldDefs: [f], qSortCriterias: [{ qSortByNumeric: 1, qSortByAscii: 1, qSortByLoadOrder: 1 }] },
            qNullSuppression: false
          };
        }),
        qMeasures: [],
        qInterColumnSortOrder: fields.map(function (f, i) { return i; }),
        qSuppressZero: false,
        qSuppressMissing: false,
        qMode: 'S',
        qInitialDataFetch: []
      }
    };
  }

  function toCell(c) {
    if (!c || c.qIsNull) { return null; }
    var n = typeof c.qNum === 'number' && !isNaN(c.qNum) ? c.qNum : null;
    return { t: c.qText === undefined ? (n === null ? '' : String(n)) : c.qText, n: n };
  }

  function getPage(obj, top, height, width) {
    return obj.getHyperCubeData('/qHyperCubeDef', [{ qTop: top, qLeft: 0, qWidth: width, qHeight: height }])
      .then(function (pages) { return (pages && pages[0] && pages[0].qMatrix) || []; });
  }

  // Reads every row of a small table into objects keyed by field name.
  function readTable(app, state, fields) {
    return app.createSessionObject(cubeProps(fields, state)).then(function (obj) {
      return obj.getLayout().then(function (layout) {
        var total = layout.qHyperCube.qSize.qcy;
        var width = fields.length;
        var height = Math.max(1, Math.floor(MAX_CELLS / width));
        var rows = [];
        var chain = Promise.resolve();
        for (var top = 0; top < total; top += height) {
          (function (t) {
            chain = chain.then(function () {
              return getPage(obj, t, Math.min(height, total - t), width).then(function (m) { rows = rows.concat(m); });
            });
          }(top));
        }
        return chain.then(function () {
          return rows.map(function (r) {
            var o = {};
            fields.forEach(function (f, i) { o[f] = toCell(r[i]); });
            return o;
          });
        });
      }).then(function (result) {
        return app.destroySessionObject(obj.id).catch(function () {}).then(function () { return result; });
      }, function (err) {
        return app.destroySessionObject(obj.id).catch(function () {}).then(function () { throw err; });
      });
    });
  }

  // Keeps only rows that have a value in at least one non-key field.
  function realRows(rows, fields) {
    return rows.filter(function (r) {
      return fields.some(function (f) { return f !== 'QvdKey' && r[f] !== null; });
    });
  }

  // ---------------------------------------------------------------- viewer

  function Viewer(element, app) {
    this.el = element;
    this.app = app;
    this.state = '$';
    this.spaces = [];
    this.spaceKey = 'personal';
    this.files = [];
    this.filesLoading = false;
    this.filter = '';
    this.selected = [];      // [{ path, name, spaceName }]
    this.rowLimit = 1000;
    this.busy = '';
    this.message = null;     // { kind: 'error' | 'info', text, detail, action }
    this.model = null;       // loaded data model
    this.activeKey = null;
    this.subTab = 'records';
    this.records = null;     // { key, obj, fields, total, top, loading, error }
    this.search = { field: '', text: '' };
    this.appNames = {};
    this.lineage = {};       // QvdKey -> { loading, error, qri, up, down }
    this.showXml = false;
    this.spacesReady = null;
    this.script = { status: 'unknown', version: null, confirm: false, busy: false };
    this.destroyed = false;
    this.token = 0;
  }

  Viewer.prototype.init = function () {
    var self = this;
    injectCss();
    this.el.innerHTML = '';
    this.root = document.createElement('div');
    this.root.className = 'qvdv';
    this.el.appendChild(this.root);
    this.root.innerHTML =
      '<div class="qvdv-head"><div class="qvdv-logo">QVD</div><div class="qvdv-title">QVD Viewer</div>' +
      '<div class="qvdv-ver">v' + VERSION + '</div><div class="qvdv-status" data-ref="status"></div></div>' +
      '<div class="qvdv-body"><aside class="qvdv-pick" data-ref="pick"></aside>' +
      '<section class="qvdv-main" data-ref="main"></section></div>';
    this.refs = {
      status: this.root.querySelector('[data-ref=status]'),
      pick: this.root.querySelector('[data-ref=pick]'),
      main: this.root.querySelector('[data-ref=main]')
    };
    this.onClick = function (e) { self.handleClick(e); };
    this.onChange = function (e) { self.handleChange(e); };
    this.onInput = function (e) { self.handleInput(e); };
    this.onKey = function (e) { self.handleKey(e); };
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('change', this.onChange);
    this.root.addEventListener('input', this.onInput);
    this.root.addEventListener('keydown', this.onKey);
    if (window.ResizeObserver) {
      this.resizer = new ResizeObserver(function () { self.applyWidth(); });
      this.resizer.observe(this.root);
    }
    this.applyWidth();
    this.renderPicker();
    this.renderMain();

    // A unique name per instance: the object can be mounted again in the same engine session
    // (edit mode, navigation), and adding an existing state name raises an engine error dialog.
    var stateName = STATE + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var stateReady = this.app.addSessionAlternateState
      ? this.app.addSessionAlternateState(stateName).then(function () {
        if (self.destroyed) { self.app.removeSessionAlternateState(stateName).catch(function () {}); return; }
        self.state = stateName;
      }).catch(function () { self.state = '$'; })
      : Promise.resolve();

    stateReady.then(function () {
      if (self.destroyed) { return null; }
      self.checkScript();
      self.spacesReady = self.loadSpaces();
      return Promise.all([self.spacesReady, self.loadModel()]);
    }).catch(function (err) { self.showError('Could not start the viewer.', err); });
  };

  Viewer.prototype.destroy = function () {
    this.destroyed = true;
    this.closeRecords();
    if (this.state !== '$' && this.app.removeSessionAlternateState) {
      this.app.removeSessionAlternateState(this.state).catch(function () {});
    }
    if (this.resizer) { this.resizer.disconnect(); }
    if (this.root) {
      this.root.removeEventListener('click', this.onClick);
      this.root.removeEventListener('change', this.onChange);
      this.root.removeEventListener('input', this.onInput);
      this.root.removeEventListener('keydown', this.onKey);
    }
    this.el.innerHTML = '';
  };

  Viewer.prototype.applyWidth = function () {
    if (!this.root) { return; }
    this.root.classList.toggle('is-narrow', this.root.clientWidth < 760);
  };

  Viewer.prototype.setBusy = function (text) {
    this.busy = text || '';
    this.renderStatus();
  };

  Viewer.prototype.showError = function (text, err, detail) {
    this.message = { kind: 'error', text: text + (err ? ' ' + (err.message || err) : ''), detail: detail || '' };
    this.busy = '';
    this.renderStatus();
    this.renderMain();
  };

  Viewer.prototype.renderStatus = function () {
    if (this.destroyed) { return; }
    this.refs.status.innerHTML = this.busy
      ? '<div class="qvdv-spin"></div><span>' + esc(this.busy) + '</span>'
      : '';
    var loadBtn = this.root.querySelector('[data-action=load]');
    if (loadBtn) {
      loadBtn.disabled = !!this.busy || !this.selected.length || this.script.status === 'missing' || this.script.status === 'foreign';
    }
  };

  // ---------------------------------------------------------------- spaces and files

  Viewer.prototype.loadSpaces = function () {
    var self = this;
    this.setBusy('Loading spaces…');
    return Promise.all([
      apiAll('/api/v1/spaces?limit=100', 5000).catch(function () { return []; }),
      apiAll('/api/v1/data-files/connections?limit=1000', 5000)
    ]).then(function (res) {
      var spaceById = {};
      res[0].forEach(function (s) { spaceById[s.id] = s; });
      var list = [];
      res[1].forEach(function (c) {
        if (!c.spaceId) { return; }
        var space = spaceById[c.spaceId];
        var name = space ? space.name : '';
        if (!name && c.connectStatement) {
          var m = /path=([^;"]+):datafiles/i.exec(c.connectStatement);
          name = m ? m[1] : '';
        }
        if (!name) { return; }
        list.push({
          key: c.id,
          name: name,
          type: space ? space.type : '',
          connectionId: c.id,
          lib: 'lib://' + name + ':DataFiles/'
        });
      });
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      list.unshift({ key: 'personal', name: 'Personal', type: 'personal', connectionId: null, lib: 'lib://DataFiles/' });
      self.spaces = list;
      self.renderPicker();
      return self.loadFiles();
    }).catch(function (err) {
      self.spaces = [{ key: 'personal', name: 'Personal', type: 'personal', connectionId: null, lib: 'lib://DataFiles/' }];
      self.renderPicker();
      self.showError('Could not list spaces.', err);
      return self.loadFiles();
    });
  };

  Viewer.prototype.currentSpace = function () {
    var key = this.spaceKey;
    return this.spaces.filter(function (s) { return s.key === key; })[0] || this.spaces[0];
  };

  Viewer.prototype.loadFiles = function () {
    var self = this;
    var space = this.currentSpace();
    if (!space) { return Promise.resolve(); }
    var token = ++this.token;
    this.filesLoading = true;
    this.files = [];
    this.renderFiles();
    this.setBusy('Loading files in ' + space.name + '…');
    var url = '/api/v1/data-files?limit=1000&sort=name' +
      (space.connectionId ? '&connectionId=' + encodeURIComponent(space.connectionId) : '');
    return apiAll(url, 20000).then(function (items) {
      if (token !== self.token) { return; }
      self.files = items.filter(function (f) {
        return !f.folder && /\.qvd$/i.test(f.name || '');
      }).map(function (f) {
        var path = space.lib + f.name;
        return {
          id: f.id,
          name: f.name,
          base: f.baseName || String(f.name).split('/').pop(),
          folder: f.folderPath || '',
          size: f.size,
          modified: f.contentUpdatedDate || f.modifiedDate || f.createdDate,
          path: path,
          spaceName: space.name,
          blocked: path.length > MAX_VAR_LENGTH
            ? 'The library path is longer than ' + MAX_VAR_LENGTH + ' characters.'
            : (/['\]]/.test(path) ? 'The path contains a quote or a closing bracket, which the load script cannot use.' : '')
        };
      });
      self.filesLoading = false;
      self.setBusy('');
      self.renderFiles();
    }).catch(function (err) {
      if (token !== self.token) { return; }
      self.filesLoading = false;
      self.renderFiles();
      self.showError('Could not list files in ' + space.name + '.', err);
    });
  };

  Viewer.prototype.isSelected = function (path) {
    return this.selected.some(function (s) { return s.path === path; });
  };

  Viewer.prototype.toggleFile = function (path) {
    var file = this.files.filter(function (f) { return f.path === path; })[0];
    if (this.isSelected(path)) {
      this.selected = this.selected.filter(function (s) { return s.path !== path; });
    } else if (file && !file.blocked && this.selected.length < MAX_FILES) {
      this.selected.push({ path: file.path, name: file.base, spaceName: file.spaceName });
    }
    this.renderFiles();
    this.renderSelected();
  };

  // ---------------------------------------------------------------- picker rendering

  Viewer.prototype.renderPicker = function () {
    if (this.destroyed) { return; }
    var self = this;
    var spaceOptions = this.spaces.map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (s.key === self.spaceKey ? ' selected' : '') + '>' +
        esc(s.name) + (s.type && s.type !== 'personal' ? ' (' + esc(s.type) + ')' : '') + '</option>';
    }).join('') || '<option>Loading…</option>';
    var limitOptions = ROW_LIMITS.map(function (r) {
      return '<option value="' + r.value + '"' + (r.value === self.rowLimit ? ' selected' : '') + '>' + r.label + '</option>';
    }).join('');
    this.refs.pick.innerHTML =
      '<div class="qvdv-pick-sec"><label class="qvdv-label" for="qvdv-space">Space</label>' +
      '<div class="qvdv-row"><select id="qvdv-space" data-ref="space">' + spaceOptions + '</select>' +
      '<button class="qvdv-btn" data-action="refresh-files" title="Refresh the file list">↻</button></div></div>' +
      '<div class="qvdv-pick-sec"><input type="text" data-ref="filter" placeholder="Filter by file or folder name" value="' + esc(this.filter) + '"></div>' +
      '<div class="qvdv-files" data-ref="files"></div>' +
      '<div class="qvdv-pick-sec" data-ref="selected"></div>' +
      '<div class="qvdv-pick-sec"><label class="qvdv-label" for="qvdv-limit">Rows to load per file</label>' +
      '<div class="qvdv-row"><select id="qvdv-limit" data-ref="limit">' + limitOptions + '</select>' +
      '<button class="qvdv-btn qvdv-btn-primary" data-action="load">Load</button></div>' +
      '<div class="qvdv-hint">Load reloads this app with the selected files. Header metadata always covers the whole file.</div></div>';
    this.renderFiles();
    this.renderSelected();
    this.renderStatus();
  };

  Viewer.prototype.renderFiles = function () {
    if (this.destroyed || !this.refs.pick) { return; }
    var box = this.refs.pick.querySelector('[data-ref=files]');
    if (!box) { return; }
    var self = this;
    if (this.filesLoading) { box.innerHTML = '<div class="qvdv-empty">Loading files…</div>'; return; }
    var q = this.filter.trim().toLowerCase();
    var list = this.files.filter(function (f) { return !q || f.name.toLowerCase().indexOf(q) >= 0; });
    if (!list.length) {
      box.innerHTML = '<div class="qvdv-empty">' + (this.files.length ? 'No files match the filter.' : 'No QVD files in this space.') + '</div>';
      return;
    }
    var full = this.selected.length >= MAX_FILES;
    box.innerHTML = list.map(function (f) {
      var checked = self.isSelected(f.path);
      var disabled = !!f.blocked || (!checked && full);
      var reason = f.blocked || (disabled ? 'You can load up to ' + MAX_FILES + ' files at a time.' : f.path);
      return '<div class="qvdv-file' + (disabled ? ' is-disabled' : '') + '" data-action="toggle-file" data-path="' + esc(f.path) + '" title="' + esc(reason) + '">' +
        '<input type="checkbox" tabindex="-1"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
        '<div><div class="qvdv-file-name">' + esc(f.base) + '</div>' +
        '<div class="qvdv-file-meta">' + (f.folder ? esc(f.folder) + ' · ' : '') + esc(fmtBytes(f.size)) +
        (f.modified ? ' · ' + esc(fmtDate(f.modified)) : '') + '</div></div></div>';
    }).join('');
  };

  Viewer.prototype.renderSelected = function () {
    if (this.destroyed || !this.refs.pick) { return; }
    var box = this.refs.pick.querySelector('[data-ref=selected]');
    if (!box) { return; }
    if (!this.selected.length) {
      box.innerHTML = '<span class="qvdv-label">Selected</span><div class="qvdv-hint" style="margin-top:0">No files selected. You can select files from several spaces.</div>';
    } else {
      box.innerHTML = '<div class="qvdv-row" style="justify-content:space-between;margin-bottom:4px">' +
        '<span class="qvdv-label" style="margin:0">Selected (' + this.selected.length + ' of ' + MAX_FILES + ')</span>' +
        '<button class="qvdv-link" data-action="clear-selected">Clear</button></div>' +
        '<div class="qvdv-chips">' + this.selected.map(function (s) {
          return '<span class="qvdv-chip" title="' + esc(s.path) + '"><span>' + esc(s.name) + '</span>' +
            '<button data-action="unselect" data-path="' + esc(s.path) + '" aria-label="Remove ' + esc(s.name) + '">×</button></span>';
        }).join('') + '</div>';
    }
    this.renderStatus();
  };

  // ---------------------------------------------------------------- data model

  Viewer.prototype.loadModel = function () {
    var self = this;
    var app = this.app;
    var st = this.state;
    this.setBusy('Reading loaded data…');
    return app.getTablesAndKeys({ qcx: 1000, qcy: 1000 }, { qcx: 0, qcy: 0 }, 30, false, false).then(function (res) {
      var qtr = (res && res.qtr) || res || [];
      var tables = {};
      qtr.forEach(function (t) {
        tables[t.qName] = { rows: t.qNoOfRows, fields: (t.qFields || []).map(function (f) { return f.qName; }) };
      });
      function read(name, fields) {
        return tables[name] ? readTable(app, st, fields).then(function (rows) { return realRows(rows, fields); }) : Promise.resolve([]);
      }
      return Promise.all([
        read('QvdRun', RUN_FIELDS),
        read('QvdFiles', FILE_FIELDS),
        read('QvdHeader', HEADER_FIELDS),
        read('QvdStatus', STATUS_FIELDS),
        read('QvdFields', FIELD_FIELDS),
        read('QvdLineage', LINEAGE_FIELDS),
        read('QvdHeaderXml', XML_FIELDS)
      ]).then(function (r) {
        var byKey = {};
        r[1].forEach(function (f) {
          var key = num(f.QvdKey);
          byKey[key] = { key: key, file: f, header: null, status: null, fields: [], lineage: [], table: tables['Q' + key] || null };
        });
        r[2].forEach(function (h) { var q = byKey[num(h.QvdKey)]; if (q) { q.header = h; } });
        r[3].forEach(function (s) { var q = byKey[num(s.QvdKey)]; if (q) { q.status = s; } });
        r[4].forEach(function (f) { var q = byKey[num(f.QvdKey)]; if (q) { q.fields.push(f); } });
        r[5].forEach(function (l) { var q = byKey[num(l.QvdKey)]; if (q) { q.lineage.push(l); } });
        var xmlLines = {};
        r[6].forEach(function (x) {
          var k = num(x.QvdKey);
          (xmlLines[k] = xmlLines[k] || []).push([num(x['Header Line No']), text(x['Header Line'])]);
        });
        var qvds = Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) { return a.key - b.key; });
        qvds.forEach(function (q) {
          q.fields.sort(function (a, b) { return num(a['Field Position']) - num(b['Field Position']); });
          q.lineage.sort(function (a, b) { return num(a['Lineage Position']) - num(b['Lineage Position']); });
          q.isError = text(q.status && q.status['Load Status']) === 'Error';
          var lines = (xmlLines[q.key] || []).sort(function (a, b) { return a[0] - b[0]; });
          q.xml = lines.length ? parseHeaderXml(lines.map(function (l) { return l[1]; }).join('\n')) : null;
        });
        self.model = { run: r[0][0] || null, qvds: qvds, tables: tables };
        self.lineage = {};
        if (!qvds.some(function (q) { return q.key === self.activeKey; })) {
          self.activeKey = qvds.length ? qvds[0].key : null;
        }
        self.closeRecords();
        self.setBusy('');
        self.renderMain();   // opens the records view when the Records tab is active
        self.resolveAppNames();
      });
    }).catch(function (err) {
      self.showError('Could not read the loaded data.', err);
    });
  };

  Viewer.prototype.runTime = function () {
    if (!this.model || !this.model.tables || !this.model.tables.QvdRun) { return Promise.resolve(null); }
    return readTable(this.app, this.state, ['Run Time']).then(function (rows) {
      var real = rows.filter(function (r) { return r['Run Time']; });
      return real.length ? num(real[0]['Run Time']) : null;
    }).catch(function () { return null; });
  };

  Viewer.prototype.resolveAppNames = function () {
    var self = this;
    if (!this.model) { return; }
    this.model.qvds.forEach(function (q) {
      var id = text(q.header && q.header['Creator App']);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || self.appNames[id] !== undefined) { return; }
      self.appNames[id] = null;
      api('/api/v1/apps/' + encodeURIComponent(id)).then(function (json) {
        self.appNames[id] = (json && json.attributes && json.attributes.name) || '';
      }).catch(function () {
        self.appNames[id] = '';
      }).then(function () {
        if (self.subTab !== 'records') { self.renderMain(); } else { self.renderCards(); }
      });
    });
  };

  // ---------------------------------------------------------------- reload

  Viewer.prototype.getAppId = function () {
    var app = this.app;
    return app.getAppLayout().then(function (layout) {
      return (layout && layout.qFileName) || app.id;
    }).catch(function () { return app.id; }).then(function (id) {
      if (id && /^[0-9a-f-]{36}$/i.test(id)) { return id; }
      var m = /\/app\/([0-9a-f-]{36})/i.exec(window.location.pathname);
      if (m) { return m[1]; }
      throw new Error('The app ID could not be found.');
    });
  };

  Viewer.prototype.startReload = function () {
    var self = this;
    if (this.busy || !this.selected.length) { return; }
    if (this.script.status === 'missing' || this.script.status === 'foreign') {
      this.message = { kind: 'error', text: 'Install the QVD Viewer load script in this app before loading files.' };
      this.renderPanel();
      return;
    }
    var variables = {
      vQvdCount: String(this.selected.length),
      vQvdRowLimit: String(this.rowLimit)
    };
    this.selected.forEach(function (s, i) { variables['vQvdFile' + (i + 1)] = s.path; });
    this.message = null;
    this.closeRecords();
    this.setBusy('Starting reload…');
    // 1. Reload in this engine session, like the data load editor. The new data shows at once.
    // 2. If the session reload is not allowed, use the reload service (REST).
    this.reloadInSession(variables).then(function (ok) {
      if (ok) { return self.loadModel(); }
      return null;
    }, function (err) {
      if (err && err.scriptFailed) { throw err; }
      self.setBusy('Session reload not available. Using the reload service…');
      return self.reloadViaService(variables);
    }).catch(function (err) {
      if (err && err.scriptFailed) {
        self.showError('The reload failed. Open the data load editor to see the script log.', null);
      } else if (err && err.status === 429) {
        self.showError('A reload of this app is already pending. Try again when it ends.', null);
      } else if (err && err.status === 403) {
        self.showError('You are not allowed to reload this app, or the reload quota is used up.', err);
      } else {
        self.showError('The reload could not be started.', err);
      }
    });
  };

  // Writes the reload parameters as app variables. The load script reads them at the start.
  Viewer.prototype.setAppVariables = function (variables) {
    var app = this.app;
    return app.createSessionObject({
      qInfo: { qType: 'qvdviewer-varlist' },
      qVariableListDef: { qType: 'variable', qShowReserved: false, qShowConfig: false, qData: {} }
    }).then(function (obj) {
      return obj.getLayout().then(function (layout) {
        var existing = {};
        ((layout.qVariableList && layout.qVariableList.qItems) || []).forEach(function (v) { existing[v.qName] = v.qInfo.qId; });
        var chain = Promise.resolve();
        Object.keys(variables).forEach(function (name) {
          chain = chain.then(function () {
            if (existing[name]) {
              return app.getVariableById(existing[name]).then(function (v) { return v.setStringValue(variables[name]); });
            }
            return app.createVariableEx({ qInfo: { qType: 'variable' }, qName: name, qDefinition: variables[name], qComment: 'Set by the QVD Viewer extension' });
          });
        });
        return chain;
      }).then(function () {
        return app.destroySessionObject(obj.id).catch(function () {});
      }, function (err) {
        return app.destroySessionObject(obj.id).catch(function () {}).then(function () { throw err; });
      });
    });
  };

  Viewer.prototype.reloadInSession = function (variables) {
    var self = this;
    var app = this.app;
    if (!app.doReloadEx || !app.createVariableEx) { return Promise.reject(new Error('Session reload is not supported.')); }
    var started = Date.now();
    var timer = null;
    return this.setAppVariables(variables).then(function () {
      self.setBusy('Reloading… 0 s');
      timer = setInterval(function () { self.setBusy('Reloading… ' + Math.round((Date.now() - started) / 1000) + ' s'); }, 1000);
      return app.doReloadEx({ qMode: 0, qPartial: false, qDebug: false });
    }).then(function (res) {
      clearInterval(timer);
      var result = (res && res.qResult) || res || {};
      if (!result.qSuccess) {
        var err = new Error('The reload failed.');
        err.scriptFailed = true;
        throw err;
      }
      self.setBusy('Saving the app…');
      return app.doSave().then(function () { return true; });
    }, function (err) {
      clearInterval(timer);
      throw err;
    });
  };

  Viewer.prototype.reloadViaService = function (variables) {
    var self = this;
    var before = null;
    var reloadId = null;
    return this.runTime().then(function (rt) {
      before = rt;
      return self.getAppId();
    }).then(function (appId) {
      return api('/api/v1/reloads', { method: 'POST', body: { appId: appId, partial: false, variables: variables } });
    }).then(function (reload) {
      reloadId = reload.id;
      var started = Date.now();
      function poll() {
        return sleep(2000).then(function () {
          return api('/api/v1/reloads/' + encodeURIComponent(reloadId));
        }).then(function (r) {
          if (END_STATUSES.indexOf(r.status) >= 0) { return r; }
          var secs = Math.round((Date.now() - started) / 1000);
          self.setBusy((r.status === 'QUEUED' ? 'Reload queued' : 'Reloading') + '… ' + secs + ' s');
          return poll();
        });
      }
      return poll();
    }).then(function (result) {
      if (result.status !== 'SUCCEEDED') {
        self.showError('The reload ended with status ' + result.status + '.' + (result.errorMessage ? ' ' + result.errorMessage : ''), null, result.log || '');
        return null;
      }
      self.setBusy('Reload finished. Waiting for the new data…');
      return self.waitForData(before);
    });
  };

  // The open session normally receives the reloaded data. If it does not, ask for a page refresh.
  Viewer.prototype.waitForData = function (before) {
    var self = this;
    var tries = 0;
    function check() {
      return self.runTime().then(function (now) {
        if (now !== null && now !== before) { return self.loadModel(); }
        tries += 1;
        if (tries >= 8) {
          self.message = { kind: 'info', text: 'The reload finished, but this session still shows the earlier data. Refresh the page to see the new data.', action: 'refresh-page' };
          self.setBusy('');
          self.renderMain();
          return null;
        }
        return sleep(1500).then(check);
      });
    }
    return check();
  };

  // ---------------------------------------------------------------- records

  Viewer.prototype.activeQvd = function () {
    var key = this.activeKey;
    return this.model ? this.model.qvds.filter(function (q) { return q.key === key; })[0] : null;
  };

  Viewer.prototype.recordFields = function (q) {
    if (!q || !q.table) { return []; }
    var prefix = 'Q' + q.key + '.';
    var inTable = q.table.fields.slice();
    var ordered = [prefix + '__Row'];
    q.fields.forEach(function (f) {
      var name = prefix + text(f['Field Name']);
      if (inTable.indexOf(name) >= 0 && ordered.indexOf(name) < 0) { ordered.push(name); }
    });
    inTable.forEach(function (name) { if (ordered.indexOf(name) < 0) { ordered.push(name); } });
    return ordered.filter(function (name) { return inTable.indexOf(name) >= 0; });
  };

  Viewer.prototype.closeRecords = function () {
    var rec = this.records;
    this.records = null;
    if (rec && rec.obj) { this.app.destroySessionObject(rec.obj.id).catch(function () {}); }
  };

  Viewer.prototype.openRecords = function () {
    var self = this;
    var q = this.activeQvd();
    this.closeRecords();
    if (!q || !q.table) { this.renderPanel(); return Promise.resolve(); }
    var fields = this.recordFields(q);
    var rec = { key: q.key, obj: null, fields: fields, total: 0, top: 0, rows: [], loading: true, error: '' };
    this.records = rec;
    this.search = { field: fields[1] || fields[0] || '', text: '' };
    this.renderPanel();
    var clear = this.state !== '$' ? this.app.clearAll(false, this.state).catch(function () {}) : Promise.resolve();
    return clear.then(function () {
      return self.app.createSessionObject(cubeProps(fields, self.state));
    }).then(function (obj) {
      if (self.records !== rec) { self.app.destroySessionObject(obj.id).catch(function () {}); return null; }
      rec.obj = obj;
      return self.fetchRecords(0);
    }).catch(function (err) {
      rec.loading = false;
      rec.error = 'Could not read the records. ' + (err.message || err);
      self.renderPanel();
    });
  };

  Viewer.prototype.pageSize = function () {
    var width = this.records ? this.records.fields.length : 1;
    return Math.max(1, Math.min(PAGE_ROWS, Math.floor(MAX_CELLS / width)));
  };

  Viewer.prototype.fetchRecords = function (top) {
    var self = this;
    var rec = this.records;
    if (!rec || !rec.obj) { return Promise.resolve(); }
    rec.loading = true;
    this.renderRecordsBody();
    return rec.obj.getLayout().then(function (layout) {
      rec.total = layout.qHyperCube.qSize.qcy;
      var start = Math.max(0, Math.min(top, Math.max(0, rec.total - 1)));
      var size = self.pageSize();
      if (!rec.total) { return []; }
      return getPage(rec.obj, start, Math.min(size, rec.total - start), rec.fields.length).then(function (m) {
        rec.top = start;
        return m;
      });
    }).then(function (matrix) {
      if (self.records !== rec) { return; }
      rec.rows = matrix.map(function (r) { return r.map(toCell); });
      rec.loading = false;
      rec.error = '';
      self.renderRecordsBody();
    }).catch(function (err) {
      if (self.records !== rec) { return; }
      rec.loading = false;
      rec.error = 'Could not read the records. ' + (err.message || err);
      self.renderRecordsBody();
    });
  };

  Viewer.prototype.applySearch = function () {
    var self = this;
    var rec = this.records;
    if (!rec || !rec.obj) { return; }
    var term = this.search.text.trim();
    var field = this.search.field;
    var clear = this.app.clearAll(false, this.state).catch(function () {});
    clear.then(function () {
      if (!term || !field) { return null; }
      return self.app.getField(field, self.state).then(function (f) {
        var pattern = /[*?]/.test(term) ? term : '*' + term + '*';
        return f.select(pattern, false, 0);
      });
    }).then(function () {
      return self.fetchRecords(0);
    }).catch(function (err) {
      rec.error = 'The search failed. ' + (err.message || err);
      self.renderRecordsBody();
    });
  };

  // ---------------------------------------------------------------- main rendering

  Viewer.prototype.renderMain = function () {
    if (this.destroyed) { return; }
    var m = this.model;
    var html = '';
    if (m && m.run) {
      var limit = num(m.run['Run Row Limit']);
      html += '<div class="qvdv-runbar">Last load: ' + esc(text(m.run['Run Time'])) + ' · ' +
        esc(fmtInt(num(m.run['Run File Count']))) + ' file(s) · ' + (limit ? esc(fmtInt(limit)) + ' rows per file' : 'all rows') + '</div>';
    }
    if (m && m.qvds.length) {
      var self = this;
      html += '<div class="qvdv-tabs" role="tablist">' + m.qvds.map(function (q) {
        return '<button class="qvdv-tab' + (q.key === self.activeKey ? ' is-active' : '') + '" data-action="tab" data-key="' + q.key + '" role="tab" title="' + esc(text(q.file['File Path'])) + '">' +
          '<span class="qvdv-dot' + (q.isError ? ' is-error' : '') + '"></span>' + esc(text(q.file['File Name'])) + '</button>';
      }).join('') + '</div>';
      html += '<div class="qvdv-panel" data-ref="panel"></div>';
    } else {
      html += '<div class="qvdv-panel" data-ref="panel"></div>';
    }
    this.refs.main.innerHTML = html;
    this.renderPanel();
  };

  Viewer.prototype.messageHtml = function () {
    var msg = this.message;
    if (!msg) { return ''; }
    return '<div class="qvdv-alert' + (msg.kind === 'info' ? ' is-info' : '') + '">' + esc(msg.text) +
      (msg.action === 'refresh-page' ? ' <button class="qvdv-btn" data-action="refresh-page" style="margin-left:8px;height:26px">Refresh page</button>' : '') +
      ' <button class="qvdv-link" data-action="dismiss">Dismiss</button>' +
      (msg.detail ? '<pre>' + esc(msg.detail) + '</pre>' : '') + '</div>';
  };

  Viewer.prototype.renderPanel = function () {
    if (this.destroyed) { return; }
    var panel = this.refs.main.querySelector('[data-ref=panel]');
    if (!panel) { return; }
    var q = this.activeQvd();
    if (!q) {
      panel.innerHTML = this.scriptBannerHtml() + this.messageHtml() +
        '<div class="qvdv-welcome"><h3>No QVD files loaded yet</h3>' +
        '<p>Pick one or more QVD files on the left, choose how many rows to load, and click Load. ' +
        'The app reloads with those files and the results show here.</p></div>';
      return;
    }
    var html = this.scriptBannerHtml() + this.messageHtml();
    if (q.isError) {
      html += '<div class="qvdv-alert">' + esc(text(q.status['Load Error']) || 'This file could not be loaded.') +
        '<br><small>' + esc(text(q.file['File Path'])) + '</small></div>';
    }
    html += '<div data-ref="cards"></div>';
    var tabs = [['records', 'Records'], ['fields', 'Fields (' + q.fields.length + ')'], ['header', 'Header'], ['lineage', 'Lineage']];
    var sub = this.subTab;
    html += '<div class="qvdv-sub">' + tabs.map(function (t) {
      return '<button class="qvdv-subtab' + (t[0] === sub ? ' is-active' : '') + '" data-action="subtab" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
    }).join('') + '</div><div data-ref="content"></div>';
    panel.innerHTML = html;
    this.renderCards();
    var content = panel.querySelector('[data-ref=content]');
    if (sub === 'records') { this.renderRecords(content, q); }
    else if (sub === 'fields') { content.innerHTML = this.fieldsHtml(q); }
    else if (sub === 'header') { content.innerHTML = this.headerHtml(q); }
    else { content.innerHTML = this.lineageHtml(q); this.loadPlatformLineage(q); }
  };

  Viewer.prototype.renderCards = function () {
    var box = this.refs.main.querySelector('[data-ref=cards]');
    var q = this.activeQvd();
    if (!box || !q) { return; }
    var h = q.header || {};
    var f = q.file;
    var appId = text(h['Creator App']);
    var appName = this.appNames[appId];
    var creator = appId
      ? (/^[0-9a-f-]{36}$/i.test(appId)
        ? '<a href="/sense/app/' + esc(appId) + '" target="_blank" rel="noopener" title="' + esc(appId) + '">' + esc(appName || appId) + '</a>'
        : esc(appId))
      : '';
    var loaded = q.table ? q.table.rows : 0;
    function card(k, v, small) {
      return '<div class="qvdv-card"><div class="qvdv-card-k">' + esc(k) + '</div><div class="qvdv-card-v' + (small ? ' is-small' : '') + '" title="' + (small ? '' : esc(String(v).replace(/<[^>]+>/g, ''))) + '">' + (v === '' ? '–' : v) + '</div></div>';
    }
    box.innerHTML = '<div class="qvdv-cards">' +
      card('Records', esc(fmtInt(num(f['Record Count'])))) +
      card('Fields', esc(fmtInt(num(f['Field Count'])))) +
      card('Rows loaded', esc(fmtInt(loaded))) +
      card('Table name', esc(text(f['Table Name']))) +
      card('Created (UTC)', esc(text(h['Create Time UTC']))) +
      card('Record size', esc(text(h['Record Byte Size']) ? text(h['Record Byte Size']) + ' bytes' : '')) +
      card('Space', esc(text(f.Space))) +
      card('Creator app', creator, true) +
      '</div>';
  };

  Viewer.prototype.renderRecords = function (content, q) {
    if (!q.table) {
      content.innerHTML = '<div class="qvdv-empty">No records were loaded for this file.</div>';
      return;
    }
    if (!this.records || this.records.key !== q.key) {
      content.innerHTML = '<div data-ref="records"></div>';
      this.openRecords();
      return;
    }
    var rec = this.records;
    var prefix = 'Q' + q.key + '.';
    var options = rec.fields.filter(function (f) { return f !== prefix + '__Row'; }).map(function (f) {
      return '<option value="' + esc(f) + '"' + (f === this.search.field ? ' selected' : '') + '>' + esc(f.slice(prefix.length)) + '</option>';
    }, this).join('');
    content.innerHTML = '<div class="qvdv-tools"><select data-ref="search-field" aria-label="Field to search">' + options + '</select>' +
      '<input type="text" data-ref="search-text" placeholder="Search values (* and ? allowed)" value="' + esc(this.search.text) + '">' +
      '<button class="qvdv-btn" data-action="search">Search</button>' +
      '<button class="qvdv-btn" data-action="search-clear">Clear</button></div>' +
      '<div data-ref="records"></div>';
    this.renderRecordsBody();
  };

  Viewer.prototype.renderRecordsBody = function () {
    var box = this.refs.main.querySelector('[data-ref=records]');
    var rec = this.records;
    if (!box || !rec) { return; }
    if (rec.error) { box.innerHTML = '<div class="qvdv-alert">' + esc(rec.error) + '</div>'; return; }
    if (rec.loading && !rec.rows.length) { box.innerHTML = '<div class="qvdv-empty">Loading records…</div>'; return; }
    var prefix = 'Q' + rec.key + '.';
    var head = rec.fields.map(function (f, i) {
      return i === 0 ? '<th class="qvdv-rowno">#</th>' : '<th>' + esc(f.slice(prefix.length)) + '</th>';
    }).join('');
    var body = rec.rows.map(function (r) {
      return '<tr>' + r.map(function (c, i) {
        if (i === 0) { return '<td class="qvdv-rowno">' + esc(c ? c.t : '') + '</td>'; }
        if (c === null) { return '<td class="is-null">null</td>'; }
        return '<td class="' + (c.n !== null ? 'is-num' : '') + '" title="' + esc(c.t) + '">' + esc(c.t) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var size = this.pageSize();
    var from = rec.total ? rec.top + 1 : 0;
    var to = Math.min(rec.top + size, rec.total);
    box.innerHTML = '<div class="qvdv-tablewrap"><table class="qvdv-table"><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="' + rec.fields.length + '" class="is-null">No matching records.</td></tr>') + '</tbody></table></div>' +
      '<div class="qvdv-pager"><button class="qvdv-btn" data-action="page" data-dir="first"' + (rec.top <= 0 ? ' disabled' : '') + '>«</button>' +
      '<button class="qvdv-btn" data-action="page" data-dir="prev"' + (rec.top <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<span>' + esc(fmtInt(from)) + '–' + esc(fmtInt(to)) + ' of ' + esc(fmtInt(rec.total)) + (rec.loading ? ' · loading…' : '') + '</span>' +
      '<button class="qvdv-btn" data-action="page" data-dir="next"' + (to >= rec.total ? ' disabled' : '') + '>›</button>' +
      '<button class="qvdv-btn" data-action="page" data-dir="last"' + (to >= rec.total ? ' disabled' : '') + '>»</button></div>';
  };

  Viewer.prototype.fieldsHtml = function (q) {
    var xmlFields = q.xml ? q.xml.fields : [];
    if (!q.fields.length && !xmlFields.length) { return '<div class="qvdv-empty">No field headers were read for this file.</div>'; }
    // Prefer the parsed XML header (complete); fall back to the XmlSimple table.
    var rows = xmlFields.length
      ? xmlFields.map(function (f, i) {
        var nf = f.numberFormat || {};
        return {
          pos: i + 1, name: f.FieldName, distinct: f.NoOfSymbols, type: nf.Type, fmt: nf.Fmt, ndec: nf.nDec,
          useThou: nf.UseThou, dec: nf.Dec, thou: nf.Thou, bitOffset: f.BitOffset, bitWidth: f.BitWidth, bias: f.Bias,
          offset: f.Offset, length: f.Length, comment: f.Comment, tags: f.tags || []
        };
      })
      : q.fields.map(function (f) {
        return {
          pos: text(f['Field Position']), name: text(f['Field Name']), distinct: text(f['Distinct Values']),
          type: text(f['Number Format Type']), fmt: text(f['Number Format Pattern']), ndec: text(f['Number Format Decimals']),
          useThou: null, dec: text(f['Decimal Separator']), thou: text(f['Thousands Separator']),
          bitOffset: text(f['Bit Offset']), bitWidth: text(f['Bit Width']), bias: text(f.Bias),
          offset: text(f['Symbol Offset']), length: text(f['Symbol Length']), comment: text(f['Field Comment']), tags: null
        };
      });
    var cols = [
      ['pos', '#', true], ['name', 'Field', false], ['tags', 'Tags', false], ['distinct', 'Distinct values', true],
      ['type', 'Format type', false], ['fmt', 'Format pattern', false], ['ndec', 'Decimals', true],
      ['useThou', 'Use thou. sep.', true], ['dec', 'Dec. sep.', false], ['thou', 'Thou. sep.', false],
      ['bitOffset', 'Bit offset', true], ['bitWidth', 'Bit width', true], ['bias', 'Bias', true],
      ['offset', 'Symbol offset', true], ['length', 'Symbol length', true], ['comment', 'Comment', false]
    ].filter(function (c) { return xmlFields.length || (c[0] !== 'tags' && c[0] !== 'useThou'); });
    var note = xmlFields.length ? '' : '<div class="qvdv-hint" style="margin:0 0 8px">Field tags are not shown: the raw header was not loaded. Reload with load script version 1.1.</div>';
    return note + '<div class="qvdv-tablewrap"><table class="qvdv-table"><thead><tr>' +
      cols.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + cols.map(function (c) {
          var v = r[c[0]];
          if (c[0] === 'tags') {
            return '<td>' + (v && v.length ? v.map(function (t) { return '<span class="qvdv-tag">' + esc(t) + '</span>'; }).join(' ') : '') + '</td>';
          }
          if (v === null || v === undefined || v === '') { return '<td class="is-null"></td>'; }
          var shown = c[2] && !isNaN(v) ? fmtInt(Number(v)) : v;
          return '<td class="' + (c[2] ? 'is-num' : '') + (c[0] === 'comment' ? ' is-wrap' : '') + '">' + esc(shown) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  };

  Viewer.prototype.headerHtml = function (q) {
    var self = this;
    var f = q.file;
    var h = q.header || {};
    function kv(rows) {
      return '<dl class="qvdv-kv">' + rows.map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + (r[1] === '' || r[1] === null || r[1] === undefined ? '<span style="color:#8a8f98">empty</span>' : esc(r[1])) + '</dd>';
      }).join('') + '</dl>';
    }
    function appLabel(id) {
      return id + (self.appNames[id] ? ' (' + self.appNames[id] + ')' : '');
    }
    var html = '<h4 class="qvdv-h4">File</h4>' + kv([
      ['File path', text(f['File Path'])],
      ['Space', text(f.Space)],
      ['Created (file function)', text(f['Create Time'])],
      ['Load status', text(q.status && q.status['Load Status'])]
    ]);
    if (q.xml) {
      html += '<h4 class="qvdv-h4">XML header: table elements</h4>' + kv(q.xml.table.map(function (t) {
        var label = (XML_LABELS[t.name] || t.name) + ' (' + t.name + ')';
        return [label, t.name === 'CreatorDoc' && t.value ? appLabel(t.value) : t.value];
      }).concat([['Lineage entries (Lineage)', String(q.xml.lineage.length)], ['Field headers (Fields)', String(q.xml.fields.length)]]));
      html += '<h4 class="qvdv-h4">Raw XML header</h4>' +
        '<div class="qvdv-tools"><button class="qvdv-btn" data-action="toggle-xml">' + (this.showXml ? 'Hide' : 'Show') + ' raw XML</button>' +
        '<button class="qvdv-btn" data-action="copy-xml">Copy XML</button><span class="qvdv-hint" data-ref="copy-msg" style="margin:0"></span></div>' +
        (this.showXml ? '<pre class="qvdv-xml">' + esc(q.xml.raw) + '</pre>' : '');
    } else {
      html += '<h4 class="qvdv-h4">XML header</h4>' + kv([
        ['Table name', text(h['Header Table Name'])],
        ['Number of records', fmtInt(num(h['Header Record Count']))],
        ['Created (UTC)', text(h['Create Time UTC'])],
        ['Creator app', text(h['Creator App']) ? appLabel(text(h['Creator App'])) : ''],
        ['Qlik build number', text(h['Qlik Build Number'])],
        ['Record byte size', text(h['Record Byte Size'])],
        ['Source file size', text(h['Source File Size'])],
        ['Table comment', text(h['Table Comment'])]
      ]) + '<div class="qvdv-hint">The raw header was not loaded, so only these elements are shown. Reload with load script version 1.1 to see all of them.</div>';
    }
    return html;
  };

  Viewer.prototype.lineageHtml = function (q) {
    var html = '<h4 class="qvdv-h4">Platform lineage (Qlik Cloud lineage service)</h4>';
    var lin = this.lineage[q.key];
    if (!lin || lin.loading) {
      html += '<div class="qvdv-empty">Loading lineage…</div>';
    } else if (lin.error) {
      html += '<div class="qvdv-alert">' + esc(lin.error) + '</div>';
    } else {
      html += this.nodeListHtml('Created by (one step upstream)', lin.up, 'No upstream lineage was found.') +
        this.nodeListHtml('Used by (one step downstream)', lin.down, 'No app or file uses this file yet.');
    }
    var headerLineage = q.xml ? q.xml.lineage : q.lineage.map(function (l) {
      return { source: text(l['Lineage Source']), statement: text(l['Lineage Statement']) };
    });
    html += '<h4 class="qvdv-h4">Lineage in the QVD header</h4>';
    if (!headerLineage.length) {
      html += '<div class="qvdv-empty" style="padding-left:0">The QVD header has no lineage entries. QVDs stored by Qlik Cloud apps have an empty Lineage element; QVDs made with QlikView or Qlik Sense Client-Managed usually have entries.</div>';
    } else {
      html += '<div class="qvdv-tablewrap"><table class="qvdv-table"><thead><tr><th>#</th><th>Source</th><th>Statement</th></tr></thead><tbody>' +
        headerLineage.map(function (l, i) {
          return '<tr><td class="is-num">' + (i + 1) + '</td><td class="is-wrap">' + esc(l.source) + '</td><td class="is-wrap">' + esc(l.statement) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    return html;
  };

  Viewer.prototype.nodeListHtml = function (title, nodes, emptyText) {
    var html = '<div class="qvdv-sublabel">' + esc(title) + '</div>';
    if (!nodes.length) { return html + '<div class="qvdv-empty" style="padding:4px 0 12px">' + esc(emptyText) + '</div>'; }
    return html + '<ul class="qvdv-nodes">' + nodes.map(function (n) {
      var appId = /^qri:app:sense:\/\/([0-9a-f-]{36})/i.exec(n.qri);
      var name = appId
        ? '<a href="/sense/app/' + esc(appId[1]) + '" target="_blank" rel="noopener">' + esc(n.label || appId[1]) + '</a>'
        : esc(n.label || n.qri);
      return '<li><span class="qvdv-node-type">' + esc(n.type) + '</span>' + name +
        (n.relation ? ' <span class="qvdv-node-rel">' + esc(n.relation) + '</span>' : '') +
        '<div class="qvdv-file-meta">' + esc(n.qri) + '</div></li>';
    }).join('') + '</ul>';
  };

  // ---------------------------------------------------------------- platform lineage

  function nodeType(qri, meta) {
    if (meta && meta.type) { return String(meta.type).toLowerCase(); }
    var m = /^qri:([a-z]+):/i.exec(qri || '');
    if (!m) { return 'resource'; }
    return { app: 'app', qdf: 'data file', db: 'database', file: 'file' }[m[1]] || m[1];
  }

  // Calls a lineage-graphs endpoint whose path contains a QRI. Retries with only '#' encoded
  // if the gateway rejects fully encoded slashes.
  function lineageGet(prefix, qri, suffix) {
    return api(prefix + encodeURIComponent(qri) + suffix).catch(function (err) {
      if (err && (err.status === 400 || err.status === 404)) {
        return api(prefix + qri.replace(/#/g, '%23') + suffix);
      }
      throw err;
    });
  }

  function firstGraph(res) {
    return (res && (res.graph || (res.graphs && res.graphs[0]))) || { nodes: {}, edges: [] };
  }

  Viewer.prototype.resolveQri = function (q) {
    var self = this;
    var path = text(q.file['File Path']);
    var m = /^lib:\/\/(.+?):DataFiles\/(.+)$/i.exec(path);
    var personal = /^lib:\/\/DataFiles\/(.+)$/i.exec(path);
    var spaceName = m ? m[1] : null;
    var name = m ? m[2] : (personal ? personal[1] : null);
    if (!name) { return Promise.reject(new Error('The file path is not a Qlik Cloud data file path.')); }
    return (this.spacesReady || Promise.resolve()).then(function () {
      var connectionId = null;
      if (spaceName) {
        var space = self.spaces.filter(function (s) { return s.name.toLowerCase() === spaceName.toLowerCase(); })[0];
        if (!space) { throw new Error('The space "' + spaceName + '" was not found.'); }
        connectionId = space.connectionId;
      }
      var base = name.split('/').pop();
      var url = '/api/v1/data-files?limit=100&baseNameWildcard=' + encodeURIComponent(base) +
        (connectionId ? '&connectionId=' + encodeURIComponent(connectionId) : '');
      return apiAll(url, 1000).then(function (items) {
        var item = items.filter(function (f) { return String(f.name).toLowerCase() === name.toLowerCase(); })[0];
        if (!item) { throw new Error('The data file was not found in its space.'); }
        if (!item.qri) { throw new Error('The data file has no lineage ID (QRI).'); }
        return item.qri;
      });
    });
  };

  Viewer.prototype.loadPlatformLineage = function (q) {
    var self = this;
    if (q.isError || this.lineage[q.key]) { if (q.isError && !this.lineage[q.key]) { this.lineage[q.key] = { error: 'The file could not be loaded, so its lineage is not available.' }; this.renderLineageIfActive(q.key); } return; }
    var entry = { loading: true, up: [], down: [] };
    this.lineage[q.key] = entry;
    this.resolveQri(q).then(function (qri) {
      entry.qri = qri;
      var upReq = lineageGet('/api/v1/lineage-graphs/nodes/', qri, '?level=resource&up=1').then(function (res) {
        var g = firstGraph(res);
        var nodes = g.nodes || {};
        return (g.edges || []).filter(function (e) { return e.target === qri && e.source !== qri; }).map(function (e) {
          var n = nodes[e.source] || {};
          return { qri: e.source, label: n.label, type: nodeType(e.source, n.metadata), relation: e.relation || (e.metadata && e.metadata.type) || '' };
        });
      });
      var downReq = lineageGet('/api/v1/lineage-graphs/impact/', qri, '/overview?down=1').then(function (res) {
        var g = firstGraph(res);
        var nodes = g.nodes || {};
        return Object.keys(nodes).filter(function (k) { return k !== qri; }).map(function (k) {
          return { qri: k, label: nodes[k].label, type: nodeType(k, nodes[k].metadata), relation: '' };
        });
      });
      return Promise.all([upReq, downReq]);
    }).then(function (res) {
      entry.up = res[0];
      entry.down = res[1];
      entry.loading = false;
      self.renderLineageIfActive(q.key);
    }).catch(function (err) {
      entry.loading = false;
      entry.error = 'Could not read the lineage. ' + (err.message || err);
      self.renderLineageIfActive(q.key);
    });
  };

  Viewer.prototype.renderLineageIfActive = function (key) {
    if (this.subTab === 'lineage' && this.activeKey === key) {
      var content = this.refs.main.querySelector('[data-ref=content]');
      var q = this.activeQvd();
      if (content && q) { content.innerHTML = this.lineageHtml(q); }
    }
  };

  // ---------------------------------------------------------------- load script install

  Viewer.prototype.checkScript = function () {
    var self = this;
    return this.app.getScript().then(function (res) {
      var current = typeof res === 'string' ? res : (res && res.qScript) || '';
      var st = scriptStatus(current);
      self.script.status = st.status;
      self.script.version = st.version;
    }).catch(function () {
      self.script.status = 'unknown';   // no edit rights or not readable: do not block loading
    }).then(function () {
      self.renderStatus();
      self.renderPanel();
    });
  };

  Viewer.prototype.installScript = function () {
    var self = this;
    var sc = this.script;
    if (sc.busy) { return; }
    if (sc.status === 'foreign' && !sc.confirm) {
      sc.confirm = true;
      this.renderPanel();
      return;
    }
    sc.busy = true;
    this.setBusy('Installing the load script…');
    this.app.getScript().then(function (res) {
      var current = typeof res === 'string' ? res : (res && res.qScript) || '';
      var st = scriptStatus(current).status;
      if (st === 'ok') { return null; }
      return self.app.setScript(buildScript(current, st)).then(function () { return self.app.doSave(); });
    }).then(function () {
      sc.status = 'ok';
      sc.version = SCRIPT_VERSION;
      sc.confirm = false;
      sc.busy = false;
      self.message = { kind: 'info', text: 'The QVD Viewer load script (version ' + SCRIPT_VERSION + ') is installed and the app is saved. Select files and click Load.' };
      self.setBusy('');
      self.renderPanel();
    }).catch(function (err) {
      sc.busy = false;
      sc.confirm = false;
      self.showError('The load script could not be installed. You need edit rights to this app.', err);
    });
  };

  Viewer.prototype.scriptBannerHtml = function () {
    var sc = this.script;
    if (sc.status === 'missing') {
      return '<div class="qvdv-alert is-info"><strong>This app does not have the QVD Viewer load script yet.</strong> ' +
        'Install it to load QVD files. Any default SET statements in the app are kept.' +
        '<div style="margin-top:8px"><button class="qvdv-btn qvdv-btn-primary" data-action="install-script"' + (sc.busy ? ' disabled' : '') + '>Install load script</button></div></div>';
    }
    if (sc.status === 'outdated') {
      return '<div class="qvdv-alert is-info">This app has QVD Viewer load script version ' + esc(sc.version) +
        '. Version ' + SCRIPT_VERSION + ' is available.' +
        '<div style="margin-top:8px"><button class="qvdv-btn qvdv-btn-primary" data-action="install-script"' + (sc.busy ? ' disabled' : '') + '>Update load script</button></div></div>';
    }
    if (sc.status === 'foreign') {
      return '<div class="qvdv-alert"><strong>This app already has its own load script.</strong> ' +
        'The QVD Viewer needs its own script, which replaces the current one. Earlier script versions stay in the app\'s script history. ' +
        'Use a new, empty app if you want to keep this script as it is.' +
        '<div style="margin-top:8px"><button class="qvdv-btn' + (sc.confirm ? ' qvdv-btn-primary' : '') + '" data-action="install-script"' + (sc.busy ? ' disabled' : '') + '>' +
        (sc.confirm ? 'Click again to replace the script' : 'Replace the script') + '</button></div></div>';
    }
    return '';
  };

  // ---------------------------------------------------------------- events

  Viewer.prototype.handleClick = function (e) {
    var target = e.target.closest('[data-action]');
    if (!target || !this.root.contains(target)) { return; }
    var action = target.getAttribute('data-action');
    if (target.disabled) { return; }
    switch (action) {
      case 'toggle-file':
        if (!target.classList.contains('is-disabled') || this.isSelected(target.getAttribute('data-path'))) {
          this.toggleFile(target.getAttribute('data-path'));
        }
        break;
      case 'unselect':
        this.selected = this.selected.filter(function (s) { return s.path !== target.getAttribute('data-path'); });
        this.renderFiles();
        this.renderSelected();
        break;
      case 'clear-selected':
        this.selected = [];
        this.renderFiles();
        this.renderSelected();
        break;
      case 'refresh-files':
        this.loadFiles();
        break;
      case 'load':
        this.startReload();
        break;
      case 'tab':
        this.activeKey = Number(target.getAttribute('data-key'));
        this.closeRecords();
        this.renderMain();
        break;
      case 'subtab':
        this.subTab = target.getAttribute('data-tab');
        this.renderPanel();
        break;
      case 'page':
        this.page(target.getAttribute('data-dir'));
        break;
      case 'search':
        this.readSearchInputs();
        this.applySearch();
        break;
      case 'search-clear':
        this.search.text = '';
        this.applySearch();
        this.renderPanel();
        break;
      case 'toggle-xml':
        this.showXml = !this.showXml;
        this.renderPanel();
        break;
      case 'install-script':
        this.installScript();
        break;
      case 'copy-xml':
        this.copyXml();
        break;
      case 'dismiss':
        this.message = null;
        this.renderPanel();
        break;
      case 'refresh-page':
        window.location.reload();
        break;
      default:
        break;
    }
  };

  Viewer.prototype.copyXml = function () {
    var q = this.activeQvd();
    var msg = this.root.querySelector('[data-ref=copy-msg]');
    if (!q || !q.xml) { return; }
    function done(text) { if (msg) { msg.textContent = text; } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(q.xml.raw).then(function () { done('Copied.'); }, function () { done('Copy failed. Use Show raw XML and copy it manually.'); });
    } else {
      done('Copy is not available in this browser. Use Show raw XML and copy it manually.');
    }
  };

  Viewer.prototype.readSearchInputs = function () {
    var field = this.root.querySelector('[data-ref=search-field]');
    var input = this.root.querySelector('[data-ref=search-text]');
    if (field) { this.search.field = field.value; }
    if (input) { this.search.text = input.value; }
  };

  Viewer.prototype.page = function (dir) {
    var rec = this.records;
    if (!rec || rec.loading) { return; }
    var size = this.pageSize();
    var top = rec.top;
    if (dir === 'first') { top = 0; }
    else if (dir === 'prev') { top = Math.max(0, rec.top - size); }
    else if (dir === 'next') { top = rec.top + size; }
    else if (dir === 'last') { top = Math.max(0, Math.floor((rec.total - 1) / size) * size); }
    this.fetchRecords(top);
  };

  Viewer.prototype.handleChange = function (e) {
    var ref = e.target.getAttribute('data-ref');
    if (ref === 'space') {
      this.spaceKey = e.target.value;
      this.loadFiles();
    } else if (ref === 'limit') {
      this.rowLimit = Number(e.target.value);
    } else if (ref === 'search-field') {
      this.search.field = e.target.value;
    }
  };

  Viewer.prototype.handleInput = function (e) {
    var ref = e.target.getAttribute('data-ref');
    if (ref === 'filter') {
      this.filter = e.target.value;
      this.renderFiles();
    } else if (ref === 'search-text') {
      this.search.text = e.target.value;
    }
  };

  Viewer.prototype.handleKey = function (e) {
    if (e.key === 'Enter' && e.target.getAttribute('data-ref') === 'search-text') {
      e.preventDefault();
      this.readSearchInputs();
      this.applySearch();
    }
  };

  // ---------------------------------------------------------------- supernova

  return function supernova() {
    return {
      qae: {
        properties: { showTitles: false },
        data: { targets: [] }
      },
      ext: {
        definition: {
          type: 'items',
          component: 'accordion',
          items: { settings: { uses: 'settings' } }
        },
        support: { snapshot: false, export: false, exportData: false, sharing: false, viewData: false }
      },
      component: function () {
        var element = useElement();
        var app = useApp();
        useEffect(function () {
          if (!element || !app) { return undefined; }
          var viewer = new Viewer(element, app);
          viewer.init();
          return function () { viewer.destroy(); };
        }, [element, app]);
      }
    };
  };
});
